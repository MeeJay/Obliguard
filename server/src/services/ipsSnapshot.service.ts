/**
 * IPS dashboard snapshots (W8-4, DATA-REALTIME-9), mirroring Obliance's
 * deviceService.snapshotFleetDaily / snapshotFleetHourly: one row per
 * (tenant, bucket) in ips_daily_snapshot / ips_hourly_snapshot (migration 036)
 * feeding the dashboard trends and day-over-day deltas.
 *
 * A row holds what the tenant's dashboard shows (dashboard.service scoping):
 * its own events, the bans that apply to it (own + non-excluded global), its
 * agents. The Default tenant's row is the whole install, read as is (Obliance
 * sums the tenant rows instead, which is impossible here: distinct IPs and
 * global bans do not add up).
 *
 *   flows  events, failures, unique_ips, auto_bans, manual_bans: what happened
 *          in the bucket, re-computed from ip_events / ip_bans on every run.
 *          A past bucket only ever grows (GREATEST merge), so the ip_events
 *          retention purge or a wipe never erases history already recorded;
 *   gauges active_bans, agents_total, agents_connected: the state while the
 *          bucket was the current one (last run inside it). NULL when unknown,
 *          e.g. a bucket backfilled at boot.
 *
 * Runs at boot (backfilling the flows of the last 30 days / 48 hours still in
 * ip_events) and then hourly (server/src/index.ts): each run re-computes the
 * previous and the current bucket, so a bucket is final once the first run
 * after its end went through, whatever the interval alignment. Idempotent
 * (onConflict(tenant_id, bucket) merge). The read side always replaces the
 * current bucket with a live point (dashboard.service).
 */
import type { Knex } from 'knex';
import { db } from '../db';
import { isMasterTenant } from '@obliview/shared';
import { obliguardHub } from './obliguardHub.service';
import { logger } from '../utils/logger';

export type SnapshotKind = 'daily' | 'hourly';

export const SNAPSHOT_TABLE: Record<SnapshotKind, string> = {
  daily: 'ips_daily_snapshot',
  hourly: 'ips_hourly_snapshot',
};

/** Boot backfill depth (buckets before the current one). */
const BACKFILL: Record<SnapshotKind, number> = { daily: 30, hourly: 48 };
/** Retention: hourly rows 8 days (the dashboard reads at most 7), daily rows ~13 months. */
const HOURLY_RETENTION_HOURS = 8 * 24;
const DAILY_RETENTION_DAYS = 400;

export interface IpsFlows {
  events: number;
  failures: number;
  uniqueIps: number;
  autoBans: number;
  manualBans: number;
}

export interface IpsGauges {
  activeBans: number;
  agentsTotal: number;
  agentsConnected: number;
}

const ZERO_FLOWS: IpsFlows = { events: 0, failures: 0, uniqueIps: 0, autoBans: 0, manualBans: 0 };

// ── Scoping helpers (shared with dashboard.service) ──────────────────────────

/** Bans that apply to the tenant: all for Default; else own + non-excluded global. */
export function banAudience(q: Knex.QueryBuilder, tenantId: number): Knex.QueryBuilder {
  if (isMasterTenant(tenantId)) return q;
  return q.where((w) => {
    w.where('b.tenant_id', tenantId).orWhere((g) => {
      g.where('b.scope', 'global').whereNotExists(
        db('ip_ban_exclusions as bex').whereRaw('bex.ban_id = b.id').where('bex.tenant_id', tenantId).select(db.raw('1')),
      );
    });
  });
}

/** Events of the tenant (Default: all), from the visible agents only when restricted. */
export function eventScope(q: Knex.QueryBuilder, tenantId: number, visibleAgentIds: number[] | 'all' = 'all'): Knex.QueryBuilder {
  if (!isMasterTenant(tenantId)) q.where('e.tenant_id', tenantId);
  if (Array.isArray(visibleAgentIds)) q.whereIn('e.device_id', visibleAgentIds);
  return q;
}

// ── Buckets ──────────────────────────────────────────────────────────────────
// Days are calendar days in the database timezone (like CURRENT_DATE in the
// summary), keyed 'YYYY-MM-DD'; hours are keyed by their ISO start instant.

/** SQL key of the bucket holding `col` (a timestamptz column). */
function bucketSql(kind: SnapshotKind, col: string): string {
  return kind === 'daily'
    ? `to_char((${col})::date, 'YYYY-MM-DD')`
    : `date_trunc('hour', ${col})`;
}

/** SQL start of the bucket `span` buckets before the current one (one binding: span). */
function rangeStartSql(kind: SnapshotKind): string {
  return kind === 'daily'
    ? '(CURRENT_DATE - ?::int)::timestamptz'
    : "date_trunc('hour', NOW()) - make_interval(hours => ?::int)";
}

/** JS key of a bucket value: a day key as is, a timestamp as its ISO instant. */
function bucketKey(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date(s).toISOString();
}

/** The keys of the `span` buckets before the current one and the current one, oldest first. */
export async function bucketKeys(kind: SnapshotKind, span: number): Promise<string[]> {
  const sql = kind === 'daily'
    ? "SELECT to_char(CURRENT_DATE - i, 'YYYY-MM-DD') AS bucket FROM generate_series(?::int, 0, -1) AS i"
    : "SELECT date_trunc('hour', NOW()) - make_interval(hours => i) AS bucket FROM generate_series(?::int, 0, -1) AS i";
  const res = await db.raw(sql, [Math.max(0, span)]) as { rows: Array<{ bucket: unknown }> };
  return res.rows.map((r) => bucketKey(r.bucket));
}

function num(v: unknown): number {
  return Number(v ?? 0) || 0;
}

// ── Flows ────────────────────────────────────────────────────────────────────

interface EventFlowRow { tenant_id?: number; bucket: unknown; events: string; failures: string; unique_ips: string }

/** Event flows grouped by bucket, for one tenant scope or (perTenant) every tenant's own events. */
function eventFlowsQuery(
  kind: SnapshotKind,
  span: number,
  scope: { tenantId: number; visibleAgentIds?: number[] | 'all' } | 'perTenant',
): Knex.QueryBuilder {
  const bucket = bucketSql(kind, 'e.timestamp');
  let q = db('ip_events as e').whereRaw(`e.timestamp >= ${rangeStartSql(kind)}`, [span]);
  if (scope === 'perTenant') {
    q = q.whereNotNull('e.tenant_id').groupBy('e.tenant_id').select('e.tenant_id');
  } else {
    q = eventScope(q, scope.tenantId, scope.visibleAgentIds ?? 'all');
  }
  return q
    .groupByRaw(bucket)
    .select(
      db.raw(`${bucket} AS bucket`),
      db.raw('count(*) AS events'),
      db.raw("count(*) FILTER (WHERE e.event_type = 'auth_failure') AS failures"),
      db.raw("count(DISTINCT e.ip) FILTER (WHERE e.event_type = 'auth_failure') AS unique_ips"),
    );
}

/** Ban flows (auto / manual bans created) of the tenant's audience, by bucket. */
async function banFlows(kind: SnapshotKind, span: number, tenantId: number): Promise<Map<string, { auto: number; manual: number }>> {
  const bucket = bucketSql(kind, 'b.banned_at');
  const rows = await banAudience(
    db('ip_bans as b')
      .whereIn('b.ban_type', ['auto', 'manual'])
      .whereRaw(`b.banned_at >= ${rangeStartSql(kind)}`, [span]),
    tenantId,
  )
    .groupByRaw(bucket)
    .select(
      db.raw(`${bucket} AS bucket`),
      db.raw("count(*) FILTER (WHERE b.ban_type = 'auto') AS auto"),
      db.raw("count(*) FILTER (WHERE b.ban_type = 'manual') AS manual"),
    ) as Array<{ bucket: unknown; auto: string; manual: string }>;
  return new Map(rows.map((r) => [bucketKey(r.bucket), { auto: num(r.auto), manual: num(r.manual) }]));
}

function mergeFlows(
  keys: string[],
  events: Array<EventFlowRow>,
  bans: Map<string, { auto: number; manual: number }>,
): Map<string, IpsFlows> {
  const out = new Map<string, IpsFlows>(keys.map((k) => [k, { ...ZERO_FLOWS }]));
  for (const r of events) {
    const f = out.get(bucketKey(r.bucket));
    if (!f) continue;
    f.events = num(r.events);
    f.failures = num(r.failures);
    f.uniqueIps = num(r.unique_ips);
  }
  for (const [k, b] of bans) {
    const f = out.get(k);
    if (!f) continue;
    f.autoBans = b.auto;
    f.manualBans = b.manual;
  }
  return out;
}

/**
 * Flows of the `span` buckets before the current one and of the current one
 * (zero-filled, oldest first), as the tenant's dashboard sees them. Event
 * figures follow the team scope (`visibleAgentIds`); ban figures stay
 * tenant-wide (bans are a tenant policy, as in the summary).
 */
export async function computeFlows(
  tenantId: number,
  kind: SnapshotKind,
  span: number,
  visibleAgentIds: number[] | 'all' = 'all',
): Promise<Map<string, IpsFlows>> {
  const [keys, events, bans] = await Promise.all([
    bucketKeys(kind, span),
    eventFlowsQuery(kind, span, { tenantId, visibleAgentIds }) as unknown as Promise<EventFlowRow[]>,
    banFlows(kind, span, tenantId),
  ]);
  return mergeFlows(keys, events, bans);
}

// ── Gauges ───────────────────────────────────────────────────────────────────

/**
 * Current state: active bans of the tenant's audience (tenant-wide), approved
 * agents and those with a live channel (MikroTik routers excluded, team scope
 * applied), the summary's definitions.
 */
export async function computeGauges(tenantId: number, visibleAgentIds: number[] | 'all' = 'all'): Promise<IpsGauges> {
  const master = isMasterTenant(tenantId);
  const [[active], devices] = await Promise.all([
    banAudience(
      db('ip_bans as b').where('b.is_active', true).whereRaw('(b.expires_at IS NULL OR b.expires_at > NOW())'),
      tenantId,
    ).count<Array<{ count: string }>>({ count: '*' }),
    db('agent_devices as d')
      .where('d.status', 'approved')
      .whereRaw("COALESCE(d.device_type, 'agent') = 'agent'")
      .modify((q) => {
        if (!master) q.where('d.tenant_id', tenantId);
        if (Array.isArray(visibleAgentIds)) q.whereIn('d.id', visibleAgentIds);
      })
      .select('d.uuid') as Promise<Array<{ uuid: string }>>,
  ]);
  return {
    activeBans: num(active?.count),
    agentsTotal: devices.length,
    agentsConnected: devices.filter((d) => obliguardHub.isConnected(d.uuid)).length,
  };
}

// ── Snapshot job ─────────────────────────────────────────────────────────────

const FLOW_COLUMNS = ['events', 'failures', 'unique_ips', 'auto_bans', 'manual_bans'] as const;

function flowRow(f: IpsFlows): Record<(typeof FLOW_COLUMNS)[number], number> {
  return { events: f.events, failures: f.failures, unique_ips: f.uniqueIps, auto_bans: f.autoBans, manual_bans: f.manualBans };
}

/**
 * Upsert the rows of one tenant: past buckets merge their flows only (never
 * lower, never touching the gauges), the current bucket overwrites everything.
 */
async function writeTenant(kind: SnapshotKind, tenantId: number, flows: Map<string, IpsFlows>, gauges: IpsGauges): Promise<void> {
  const table = SNAPSHOT_TABLE[kind];
  const keys = [...flows.keys()];
  const current = keys[keys.length - 1];
  const now = new Date();

  const past = keys.slice(0, -1).map((k) => ({
    tenant_id: tenantId, bucket: k, ...flowRow(flows.get(k)!), updated_at: now,
  }));
  if (past.length > 0) {
    const merge: Record<string, Knex.Raw | Date> = { updated_at: now };
    for (const c of FLOW_COLUMNS) merge[c] = db.raw(`GREATEST(${table}.${c}, EXCLUDED.${c})`);
    await db(table).insert(past).onConflict(['tenant_id', 'bucket']).merge(merge);
  }
  if (current !== undefined) {
    await db(table)
      .insert({
        tenant_id: tenantId,
        bucket: current,
        ...flowRow(flows.get(current)!),
        active_bans: gauges.activeBans,
        agents_total: gauges.agentsTotal,
        agents_connected: gauges.agentsConnected,
        updated_at: now,
      })
      .onConflict(['tenant_id', 'bucket'])
      .merge();
  }
}

let running = false;

export const ipsSnapshotService = {
  /**
   * Snapshot every tenant, daily and hourly. `backfill` (boot) re-computes
   * the flows of the last 30 days / 48 hours, else only the previous and the
   * current bucket. Returns false when a run is already in progress (skipped).
   */
  async runAll(opts: { backfill?: boolean } = {}): Promise<boolean> {
    if (running) return false;
    running = true;
    try {
      const tenants = await db('tenants').select('id').orderBy('id') as Array<{ id: number }>;
      for (const kind of ['daily', 'hourly'] as const) {
        const span = opts.backfill ? BACKFILL[kind] : 1;
        const [keys, perTenantRows] = await Promise.all([
          bucketKeys(kind, span),
          // One scan for every tenant's own events (the Default row, install-wide, has its own).
          eventFlowsQuery(kind, span, 'perTenant') as unknown as Promise<EventFlowRow[]>,
        ]);
        const byTenant = new Map<number, EventFlowRow[]>();
        for (const r of perTenantRows) {
          const id = Number(r.tenant_id);
          if (!byTenant.has(id)) byTenant.set(id, []);
          byTenant.get(id)!.push(r);
        }
        for (const t of tenants) {
          try {
            const events = isMasterTenant(t.id)
              ? await (eventFlowsQuery(kind, span, { tenantId: t.id }) as unknown as Promise<EventFlowRow[]>)
              : byTenant.get(t.id) ?? [];
            const [bans, gauges] = await Promise.all([banFlows(kind, span, t.id), computeGauges(t.id)]);
            await writeTenant(kind, t.id, mergeFlows(keys, events, bans), gauges);
          } catch (err) {
            logger.error({ err, tenantId: t.id, kind }, 'IPS snapshot failed for a tenant');
          }
        }
      }
      await db(SNAPSHOT_TABLE.hourly)
        .whereRaw("bucket < NOW() - make_interval(hours => ?::int)", [HOURLY_RETENTION_HOURS]).del();
      await db(SNAPSHOT_TABLE.daily).whereRaw('bucket < CURRENT_DATE - ?::int', [DAILY_RETENTION_DAYS]).del();
      logger.info({ tenants: tenants.length, backfill: !!opts.backfill }, 'IPS dashboard snapshot complete');
      return true;
    } catch (err) {
      logger.error(err, 'IPS dashboard snapshot failed');
      return true;
    } finally {
      running = false;
    }
  },
};

