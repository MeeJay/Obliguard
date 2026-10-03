import type { Knex } from 'knex';
import { db } from '../db';
import { logger } from '../utils/logger';
import { appConfigService, type RetentionConfig } from './appConfig.service';
import { liveAlertService } from './liveAlert.service';

/**
 * Data retention (W12-1 / D15.1, pattern Obliance index.ts pruneInventory +
 * cleanOrphans): keeps the hot tables bounded.
 *
 * Runs 60 s after boot, then hourly, behind a re-entrancy guard (a slow run
 * is never stacked with the next tick). Each step is independent: one that
 * fails is logged and the others still run.
 *
 *  - ip_events older than eventsDays;
 *  - ip_reputation rows inactive for reputationDays, unless the IP is banned
 *    (active ban, exact or subnet) or whitelisted; their per-tenant clear
 *    baselines go with them (a baseline left behind would hide the IP's
 *    next suspicious phase);
 *  - inactive ip_bans whose lifted_at / expires_at is older than
 *    banHistoryDays (exclusions cascade);
 *  - live alerts: liveAlertService.cleanup (resolved / plain notifications
 *    past LIVE_ALERT_RETENTION_DAYS, default 30; open incidents are kept);
 *  - audit_logs older than auditDays;
 *  - orphan rows: polymorphic group/agent references (no DB foreign key)
 *    whose group or agent no longer exists.
 *
 * Large deletes go in batches of BATCH_SIZE rows, one short transaction per
 * batch with a bounded statement timeout, so the purge never holds long
 * locks nor trips the 30 s request statement timeout.
 *
 * Windows come from app_config (retention.*, edited in Settings), with the
 * env (IP_EVENTS_RETENTION_DAYS, AUDIT_RETENTION_DAYS) as fallback: see
 * appConfigService.getRetention.
 */

export const RETENTION_BATCH_SIZE = 10_000;
/** Batches per table and run (10 M rows): the next hourly run continues. */
const MAX_BATCHES_PER_RUN = 1_000;
/** Per-batch statement timeout: generous for one batch, never unbounded. */
const BATCH_STATEMENT_TIMEOUT = '300s';
const FIRST_RUN_DELAY_MS = 60_000;
const RUN_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;

const LIVE_ALERT_RETENTION_DAYS = (() => {
  const n = Number(process.env.LIVE_ALERT_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
})();

/**
 * Polymorphic references to groups / agents, cleaned in code: these columns
 * have no foreign key, so deleting a group or an agent leaves them behind.
 */
const ORPHAN_SOURCES: ReadonlyArray<{ table: string; scope: string; scopeId: string }> = [
  { table: 'notification_bindings',        scope: 'scope',       scopeId: 'scope_id' },
  { table: 'remediation_bindings',         scope: 'scope',       scopeId: 'scope_id' },
  { table: 'team_permissions',             scope: 'scope',       scopeId: 'scope_id' },
  { table: 'settings',                     scope: 'scope',       scopeId: 'scope_id' },
  { table: 'service_template_assignments', scope: 'scope',       scopeId: 'scope_id' },
  { table: 'ip_whitelist',                 scope: 'scope',       scopeId: 'scope_id' },
  { table: 'rate_limit_policies',          scope: 'scope',       scopeId: 'scope_id' },
  // Local (group / agent owned) service templates; their assignments cascade.
  { table: 'service_templates',            scope: 'owner_scope', scopeId: 'owner_scope_id' },
];
const ORPHAN_TARGETS: ReadonlyArray<{ scope: string; table: string }> = [
  { scope: 'group', table: 'monitor_groups' },
  { scope: 'agent', table: 'agent_devices' },
];

export interface RetentionRunResult {
  config: RetentionConfig;
  events: number;
  reputation: number;
  bans: number;
  liveAlerts: number;
  audit: number;
  orphans: number;
  /** Steps that failed (logged); the others still ran. */
  failed: string[];
  durationMs: number;
}

let running: Promise<RetentionRunResult> | null = null;
let firstRunTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let stopping = false;

/** One batch in its own transaction, with a bounded statement timeout. */
async function runBatch(sql: string, bindings: Knex.RawBinding[]): Promise<number> {
  return db.transaction(async (trx) => {
    await trx.raw(`SET LOCAL statement_timeout = '${BATCH_STATEMENT_TIMEOUT}'`);
    const res = await trx.raw(sql, bindings) as { rowCount?: number | null; rows?: Array<{ n?: number | string }> };
    // DELETE ... returns rowCount; a CTE ending in SELECT count(*) AS n returns a row.
    if (res.rows && res.rows.length === 1 && res.rows[0].n !== undefined) return Number(res.rows[0].n);
    return res.rowCount ?? 0;
  });
}

/** Repeats a batch statement (deleting at most `batchSize` rows) until a short batch. */
async function deleteInBatches(sql: string, bindings: Knex.RawBinding[], batchSize: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN && !stopping; i++) {
    const n = await runBatch(sql, [...bindings, batchSize]);
    total += n;
    if (n < batchSize) break;
    // Let agent heartbeats and requests through between batches.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return total;
}

const cutoffOf = (days: number): Date => new Date(Date.now() - days * DAY_MS);

async function purgeEvents(days: number, batchSize: number): Promise<number> {
  return deleteInBatches(
    `DELETE FROM ip_events WHERE id IN (
       SELECT id FROM ip_events WHERE "timestamp" < ? LIMIT ?
     )`,
    [cutoffOf(days)],
    batchSize,
  );
}

async function purgeReputation(days: number, batchSize: number): Promise<number> {
  const cutoff = cutoffOf(days);
  return deleteInBatches(
    `WITH victims AS (
       SELECT r.ip FROM ip_reputation r
        WHERE (r.last_seen < ? OR (r.last_seen IS NULL AND r.updated_at < ?))
          AND NOT EXISTS (SELECT 1 FROM ip_bans b WHERE b.is_active AND b.ip = r.ip)
          AND NOT EXISTS (
            -- Subnet bans: network + cidr_prefix, or a legacy row carrying
            -- the prefix in the inet mask (cidr_prefix NULL).
            SELECT 1 FROM ip_bans b
             WHERE b.is_active
               AND COALESCE(b.cidr_prefix, masklen(b.ip)) BETWEEN 0 AND masklen(b.ip)
               AND family(b.ip) = family(r.ip)
               AND r.ip <<= set_masklen(b.ip, COALESCE(b.cidr_prefix, masklen(b.ip)))
          )
          AND NOT EXISTS (SELECT 1 FROM ip_whitelist w WHERE r.ip <<= w.ip)
        LIMIT ?
     ), gone AS (
       DELETE FROM ip_reputation r USING victims v WHERE r.ip = v.ip RETURNING r.ip
     ), clears AS (
       DELETE FROM ip_reputation_tenant_clears c USING gone g WHERE c.ip::inet = g.ip RETURNING c.id
     )
     SELECT count(*)::int AS n FROM gone`,
    [cutoff, cutoff],
    batchSize,
  );
}

async function purgeBanHistory(days: number, batchSize: number): Promise<number> {
  return deleteInBatches(
    `DELETE FROM ip_bans WHERE id IN (
       SELECT id FROM ip_bans
        WHERE NOT is_active
          AND COALESCE(lifted_at, expires_at, banned_at) < ?
        LIMIT ?
     )`,
    [cutoffOf(days)],
    batchSize,
  );
}

async function purgeAudit(days: number, batchSize: number): Promise<number> {
  return deleteInBatches(
    `DELETE FROM audit_logs WHERE id IN (
       SELECT id FROM audit_logs WHERE created_at < ? LIMIT ?
     )`,
    [cutoffOf(days)],
    batchSize,
  );
}

async function purgeOrphans(): Promise<number> {
  let total = 0;
  for (const src of ORPHAN_SOURCES) {
    // Legacy / optional tables: skipped when absent.
    if (!(await db.schema.hasTable(src.table))) continue;
    if (!(await db.schema.hasColumn(src.table, src.scopeId))) continue;
    for (const target of ORPHAN_TARGETS) {
      const res = await db.raw(
        `DELETE FROM ?? AS o
          WHERE o.?? = ? AND o.?? IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM ?? AS t WHERE t.id = o.??)`,
        [src.table, src.scope, target.scope, src.scopeId, target.table, src.scopeId],
      ) as { rowCount?: number | null };
      const n = res.rowCount ?? 0;
      if (n > 0) {
        total += n;
        logger.warn({ table: src.table, scope: target.scope, count: n }, 'Retention: deleted orphan rows');
      }
    }
  }
  return total;
}

async function execute(batchSize: number): Promise<RetentionRunResult> {
  const started = Date.now();
  const config = await appConfigService.getRetention();
  const result: RetentionRunResult = {
    config, events: 0, reputation: 0, bans: 0, liveAlerts: 0, audit: 0, orphans: 0, failed: [], durationMs: 0,
  };

  const step = async (name: string, fn: () => Promise<number>, apply: (n: number) => void): Promise<void> => {
    if (stopping) return;
    try {
      apply(await fn());
    } catch (err) {
      result.failed.push(name);
      logger.error(err, `Retention: ${name} purge failed`);
    }
  };

  await step('ip_events', () => purgeEvents(config.eventsDays, batchSize), (n) => { result.events = n; });
  await step('ip_reputation', () => purgeReputation(config.reputationDays, batchSize), (n) => { result.reputation = n; });
  await step('ip_bans', () => purgeBanHistory(config.banHistoryDays, batchSize), (n) => { result.bans = n; });
  await step('live_alerts', () => liveAlertService.cleanup(LIVE_ALERT_RETENTION_DAYS), (n) => { result.liveAlerts = n; });
  await step('audit_logs', () => purgeAudit(config.auditDays, batchSize), (n) => { result.audit = n; });
  await step('orphans', () => purgeOrphans(), (n) => { result.orphans = n; });

  result.durationMs = Date.now() - started;
  const purged = result.events + result.reputation + result.bans + result.liveAlerts + result.audit + result.orphans;
  if (purged > 0 || result.failed.length > 0) {
    logger.info({
      events: result.events, reputation: result.reputation, bans: result.bans,
      liveAlerts: result.liveAlerts, audit: result.audit, orphans: result.orphans,
      failed: result.failed, durationMs: result.durationMs, config,
    }, 'Retention: run complete');
  }
  return result;
}

export const retentionService = {
  /**
   * One retention pass. Returns null without doing anything when a pass is
   * already running (re-entrancy guard). `batchSize` is for tests only.
   */
  async runOnce(opts: { batchSize?: number } = {}): Promise<RetentionRunResult | null> {
    if (running) return null;
    const batchSize = Math.max(1, Math.floor(opts.batchSize ?? RETENTION_BATCH_SIZE));
    const run = execute(batchSize);
    running = run;
    try {
      return await run;
    } finally {
      running = null;
    }
  },

  isRunning(): boolean {
    return running !== null;
  },

  /** First pass 60 s after boot, then hourly. Idempotent. */
  start(): void {
    if (firstRunTimer || intervalTimer) return;
    stopping = false;
    const tick = (): void => {
      retentionService.runOnce().catch((err) => logger.error(err, 'Retention run failed'));
    };
    firstRunTimer = setTimeout(() => { firstRunTimer = null; tick(); }, FIRST_RUN_DELAY_MS);
    intervalTimer = setInterval(tick, RUN_INTERVAL_MS);
    firstRunTimer.unref();
    intervalTimer.unref();
  },

  /** Clears the timers; a running pass stops after its current batch. */
  stop(): void {
    stopping = true;
    if (firstRunTimer) clearTimeout(firstRunTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    firstRunTimer = null;
    intervalTimer = null;
  },
};
