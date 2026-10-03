import type { Knex } from 'knex';
import { db } from '../db';
import type { IpReputation, IpEvent, IpStatus } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';
import { applyBanReadTenants, canSeeBanAuthor } from './banVisibility';
import { readTenantsFor, whereReadTenants } from '../middleware/tenant';
import type { ReadTenants } from '../middleware/tenant';
import { parseIpSearch, ipSearchSql } from '../utils/pagination';
import { logger } from '../utils/logger';
import { geoipService, geoLookupCandidate } from './geoip.service';
import type { GeoInfo } from './geoip.service';

// ── GeoIP enrichment queue ───────────────────────────────────────────────────

/** Delay between enrichment batches (ADMIN-FEATURES-14). */
const GEO_FLUSH_MS = 5000;
/** IPs per enrichment batch. */
const GEO_BATCH_MAX = 100;
/** Pending IPs kept in memory; the periodic backfill picks up any overflow. */
const GEO_QUEUE_MAX = 10_000;
/** Rows scanned per backfill pass, and the backfill period. */
const GEO_BACKFILL_ROWS = 500;
/** Pages of GEO_BACKFILL_ROWS scanned per pass when rows cannot be resolved. */
const GEO_BACKFILL_SCAN_PAGES = 20;
const GEO_BACKFILL_FIRST_MS = 60_000;
const GEO_BACKFILL_EVERY_MS = 15 * 60_000;

/**
 * A reputation list row with its tenant attribution (W10-5):
 *   - tenantIds: the tenants (within the caller's read scope) whose agents
 *     logged events from this IP, ascending;
 *   - tenantId / tenantName: on the banned list the owner of the ban (null =
 *     global ban); elsewhere the attacked tenant when there is exactly one
 *     (null = several tenants, or none).
 */
export type IpReputationListItem = IpReputation & {
  tenantId: number | null;
  tenantName: string | null;
  tenantIds: number[];
};

/** `IN (?, ?, …)` placeholders of a non-empty id list. */
function inList(ids: readonly number[]): string {
  return `(${ids.map(() => '?').join(', ')})`;
}

/** Per-IP totals computed from the read tenants' own ip_events (restricted callers). */
interface TenantAgg {
  failures: number;
  successes: number;
  agents: number;
  services: string[];
  usernames: string[];
  firstSeen: Date | null;
  lastSeen: Date | null;
  lastDeviceId: number | null;
}

/**
 * Totals shown to a restricted caller (customer tenant, or Default narrowed by
 * tenant chips): from the read tenants' own events only, or zeroed (no
 * tenant). The unnarrowed Default view keeps the global ip_reputation values.
 */
function applyTenantTotals<T extends IpReputation>(rep: T, agg: TenantAgg | undefined): T {
  return {
    ...rep,
    totalFailures: agg?.failures ?? 0,
    totalSuccesses: agg?.successes ?? 0,
    affectedAgentsCount: agg?.agents ?? 0,
    affectedServices: agg?.services ?? [],
    attemptedUsernames: agg?.usernames ?? [],
    firstSeen: agg?.firstSeen ? new Date(agg.firstSeen).toISOString() : null,
    lastSeen: agg?.lastSeen ? new Date(agg.lastSeen).toISOString() : null,
    lastEventDeviceId: agg?.lastDeviceId ?? null,
  };
}

// ── Row interfaces ───────────────────────────────────────────────────────────

interface IpReputationRow {
  ip: string;
  total_failures: number | string;
  total_successes: number | string;
  affected_agents_count: number | string;
  affected_services: string[] | string | null;
  attempted_usernames: string[] | string | null;
  first_seen: Date | null;
  last_seen: Date | null;
  last_event_device_id: number | null;
  geo_country_code: string | null;
  geo_city: string | null;
  asn: string | null;
  updated_at: Date;
}

interface IpEventRow {
  id: number;
  device_id: number | null;
  hostname?: string | null;
  ip: string;
  username: string | null;
  service: string;
  event_type: string;
  timestamp: Date;
  raw_log: string | null;
  track_only: boolean;
  tenant_id: number | null;
  created_at: Date;
}

// ── Row → Model ──────────────────────────────────────────────────────────────

function parseJsonArray(val: string[] | string | null | undefined): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToReputation(
  row: IpReputationRow,
  status: IpStatus = 'clean',
  cleared = false,
): IpReputation {
  return {
    ip: row.ip,
    totalFailures: Number(row.total_failures),
    totalSuccesses: Number(row.total_successes),
    affectedAgentsCount: Number(row.affected_agents_count),
    affectedServices: parseJsonArray(row.affected_services),
    attemptedUsernames: parseJsonArray(row.attempted_usernames),
    firstSeen: row.first_seen ? row.first_seen.toISOString() : null,
    lastSeen: row.last_seen ? row.last_seen.toISOString() : null,
    lastEventDeviceId: row.last_event_device_id,
    geoCountryCode: row.geo_country_code,
    geoCity: row.geo_city,
    asn: row.asn,
    updatedAt: row.updated_at.toISOString(),
    status,
    clearedForTenant: cleared,
  };
}

/** Minimal empty reputation row for IPs that are banned but have no events. */
function emptyReputationRow(ip: string): IpReputationRow {
  const now = new Date();
  return {
    ip,
    total_failures: 0,
    total_successes: 0,
    affected_agents_count: 0,
    affected_services: [],
    attempted_usernames: [],
    first_seen: null,
    last_seen: null,
    last_event_device_id: null,
    geo_country_code: null,
    geo_city: null,
    asn: null,
    updated_at: now,
  };
}

function rowToEvent(row: IpEventRow): IpEvent {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceHostname: row.hostname ?? undefined,
    ip: row.ip,
    username: row.username,
    service: row.service,
    eventType: row.event_type as IpEvent['eventType'],
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp),
    rawLog: row.raw_log,
    trackOnly: row.track_only ?? false,
    tenantId: row.tenant_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

// ── List sorting / search ────────────────────────────────────────────────────

/** sortBy keys accepted by GET /ip-reputation (bannedAt only applies to status=banned). */
export const REPUTATION_SORT_KEYS = ['lastSeen', 'failures', 'agents', 'country', 'firstSeen', 'bannedAt'] as const;
export type ReputationSortKey = typeof REPUTATION_SORT_KEYS[number];

/**
 * ORDER BY clause for the list (whitelisted keys only, NULLS LAST both ways,
 * the ip — and the ban id on the banned list — as a stable tie-breaker).
 * Restricted callers see totals computed from their own ip_events, so they are
 * also sorted on those (correlated subqueries on idx_ip_events_ip).
 */
function reputationOrderBy(
  key: ReputationSortKey,
  order: 'asc' | 'desc',
  o: { banned: boolean; tenantOnly: number[] | null },
): { sql: string; bindings: number[] } {
  const ipCol = o.banned ? 'b.ip' : 'r.ip';
  const tail = o.banned ? `, ${ipCol} ASC, b.id ASC` : `, ${ipCol} ASC`;
  const only = o.tenantOnly && o.tenantOnly.length > 0 ? o.tenantOnly : null;
  const tenantAgg = (agg: string, extra = '') =>
    `(SELECT ${agg} FROM ip_events se WHERE se.ip = ${ipCol} AND se.tenant_id IN ${inList(only ?? [])}${extra})`;
  const num = (col: string) => (o.banned ? `COALESCE(${col}, 0)` : col);

  let expr: string;
  const bindings: number[] = [];
  const t = only;
  // No ban column on the reputation list: bannedAt falls back to the default.
  switch (key === 'bannedAt' && !o.banned ? 'lastSeen' : key) {
    case 'failures':
      if (t != null) { expr = tenantAgg('count(*)', " AND se.event_type = 'auth_failure'"); bindings.push(...t); }
      else expr = num('r.total_failures');
      break;
    case 'agents':
      if (t != null) { expr = tenantAgg('count(DISTINCT se.device_id)'); bindings.push(...t); }
      else expr = num('r.affected_agents_count');
      break;
    case 'country':
      expr = 'r.geo_country_code';
      break;
    case 'firstSeen':
      if (t != null) { expr = tenantAgg('min(se.timestamp)'); bindings.push(...t); }
      else expr = 'r.first_seen';
      break;
    case 'bannedAt':
      expr = 'b.banned_at';
      break;
    case 'lastSeen':
    default:
      if (t != null) { expr = tenantAgg('max(se.timestamp)'); bindings.push(...t); }
      else expr = 'r.last_seen';
  }
  return { sql: `${expr} ${order} NULLS LAST${tail}`, bindings };
}

/** Search filter on the ban list: an address finds the bans covering it, a network the bans inside it. */
function banSearchSql(raw: string): { sql: string; bindings: string[] } {
  const s = parseIpSearch(raw);
  const net = 'set_masklen(b.ip, COALESCE(b.cidr_prefix, masklen(b.ip)))';
  if (s.kind === 'exact') return { sql: `?::inet <<= ${net}`, bindings: [s.value] };
  if (s.kind === 'cidr') return { sql: `${net} <<= ?::inet`, bindings: [s.value] };
  return ipSearchSql('b.ip', s);
}

// ── Service ──────────────────────────────────────────────────────────────────

class IpReputationService {
  /**
   * Bulk-upserts reputation data from a batch of IP events.
   * - auth_failure events increment total_failures
   * - auth_success events increment total_successes
   * - affected_services and attempted_usernames arrays are merged (deduped)
   * - first_seen / last_seen timestamps are tracked
   */
  async upsertFromEvents(
    events: Array<{
      ip: string;
      service: string;
      username: string | null;
      deviceId: number;
      eventType: string;
    }>,
  ): Promise<void> {
    if (events.length === 0) return;

    // Group events by IP for efficient upsert
    const byIp = new Map<
      string,
      {
        ip: string;
        services: Set<string>;
        usernames: Set<string>;
        failures: number;
        successes: number;
        deviceId: number;
      }
    >();

    for (const ev of events) {
      let entry = byIp.get(ev.ip);
      if (!entry) {
        entry = {
          ip: ev.ip,
          services: new Set(),
          usernames: new Set(),
          failures: 0,
          successes: 0,
          deviceId: ev.deviceId,
        };
        byIp.set(ev.ip, entry);
      }
      entry.services.add(ev.service);
      if (ev.username) entry.usernames.add(ev.username);
      if (ev.eventType === 'auth_failure') entry.failures++;
      if (ev.eventType === 'auth_success') entry.successes++;
      // Update deviceId to most recent
      entry.deviceId = ev.deviceId;
    }

    const now = new Date();

    for (const entry of byIp.values()) {
      // ip_reputation.affected_services / attempted_usernames are text[] columns.
      // Pass JS arrays directly — the pg driver serialises them to PostgreSQL
      // array literals ({ssh,rdp}) automatically.
      // Use text[] array operations (unnest + array_agg) instead of jsonb.
      await db.raw(
        `
        INSERT INTO ip_reputation (
          ip,
          total_failures,
          total_successes,
          affected_agents_count,
          affected_device_ids,
          affected_services,
          attempted_usernames,
          first_seen,
          last_seen,
          last_event_device_id,
          geo_country_code,
          geo_city,
          asn,
          updated_at
        ) VALUES (
          ?,
          ?,
          ?,
          1,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          NULL,
          NULL,
          NULL,
          ?
        )
        ON CONFLICT (ip) DO UPDATE SET
          total_failures        = ip_reputation.total_failures + EXCLUDED.total_failures,
          total_successes       = ip_reputation.total_successes + EXCLUDED.total_successes,
          affected_device_ids = (
            SELECT array_agg(DISTINCT val)
            FROM unnest(
              COALESCE(ip_reputation.affected_device_ids, ARRAY[]::int[]) ||
              COALESCE(EXCLUDED.affected_device_ids, ARRAY[]::int[])
            ) AS val
            WHERE val IS NOT NULL
          ),
          affected_agents_count = (
            SELECT COUNT(DISTINCT val)
            FROM unnest(
              COALESCE(ip_reputation.affected_device_ids, ARRAY[]::int[]) ||
              COALESCE(EXCLUDED.affected_device_ids, ARRAY[]::int[])
            ) AS val
            WHERE val IS NOT NULL
          ),
          affected_services     = (
            SELECT array_agg(DISTINCT val)
            FROM unnest(
              COALESCE(ip_reputation.affected_services, ARRAY[]::text[]) ||
              COALESCE(EXCLUDED.affected_services, ARRAY[]::text[])
            ) AS val
            WHERE val IS NOT NULL
          ),
          attempted_usernames   = (
            SELECT array_agg(DISTINCT val)
            FROM unnest(
              COALESCE(ip_reputation.attempted_usernames, ARRAY[]::text[]) ||
              COALESCE(EXCLUDED.attempted_usernames, ARRAY[]::text[])
            ) AS val
            WHERE val IS NOT NULL
          ),
          first_seen            = LEAST(ip_reputation.first_seen, EXCLUDED.first_seen),
          last_seen             = GREATEST(ip_reputation.last_seen, EXCLUDED.last_seen),
          last_event_device_id  = EXCLUDED.last_event_device_id,
          updated_at            = EXCLUDED.updated_at
        `,
        [
          entry.ip,
          entry.failures,
          entry.successes,
          [entry.deviceId],      // affected_device_ids — seed with the reporting device
          [...entry.services],   // text[] — pg serialises JS array to {ssh,rdp,...}
          [...entry.usernames],  // text[] — same
          now,
          now,
          entry.deviceId,
          now,
        ],
      );
    }

    this.enqueueGeo(byIp.keys());
  }

  /**
   * Ensures a minimal ip_reputation row exists for the given IP.
   * Called when a ban is created to guarantee the IP is visible in the reputation module.
   * Does NOT overwrite existing data (ON CONFLICT DO NOTHING).
   */
  async ensureExists(ip: string): Promise<void> {
    const now = new Date();
    await db('ip_reputation')
      .insert({
        ip,
        total_failures: 0,
        total_successes: 0,
        affected_agents_count: 0,
        affected_services: [],
        attempted_usernames: [],
        first_seen: null,
        last_seen: null,
        last_event_device_id: null,
        geo_country_code: null,
        geo_city: null,
        asn: null,
        updated_at: now,
      })
      .onConflict('ip')
      .ignore();
    this.enqueueGeo([ip]);
  }

  // ── GeoIP enrichment ───────────────────────────────────────────────────────

  private geoQueue = new Set<string>();
  private geoTimer: NodeJS.Timeout | null = null;
  private geoFlushing: Promise<number> | null = null;
  private geoBackfillTimer: NodeJS.Timeout | null = null;

  /**
   * Queue public IPs for country / city / ASN enrichment. Cheap and
   * synchronous: private / reserved IPs and IPs the provider is known not to
   * resolve are dropped here; IPs whose row already has geo are dropped by the
   * flush (one indexed read per batch).
   */
  enqueueGeo(ips: Iterable<string>): void {
    if (!geoipService.isEnabled()) return;
    for (const raw of ips) {
      if (this.geoQueue.size >= GEO_QUEUE_MAX) break;
      const ip = geoLookupCandidate(raw);
      if (!ip || geoipService.isKnownMiss(ip)) continue;
      this.geoQueue.add(ip);
    }
    if (this.geoQueue.size > 0) this.scheduleGeoFlush();
  }

  /** Number of IPs waiting for enrichment (diagnostics, tests). */
  get geoQueueSize(): number {
    return this.geoQueue.size;
  }

  private scheduleGeoFlush(): void {
    if (this.geoTimer) return;
    this.geoTimer = setTimeout(() => {
      this.geoTimer = null;
      this.flushGeoEnrichment().catch((err) => logger.warn({ err }, 'GeoIP enrichment batch failed'));
    }, GEO_FLUSH_MS);
    this.geoTimer.unref?.();
  }

  /**
   * Run one enrichment batch now (the timer calls it every GEO_FLUSH_MS while
   * the queue is not empty): at most GEO_BATCH_MAX IPs, only rows whose geo
   * columns are all still null, written back in one UPDATE. IPs the provider
   * could not resolve yet (rate limit, outage) go back to the queue.
   * Returns the number of rows written.
   */
  flushGeoEnrichment(): Promise<number> {
    if (this.geoFlushing) return this.geoFlushing;
    this.geoFlushing = this.runGeoBatch().finally(() => {
      this.geoFlushing = null;
      if (this.geoQueue.size > 0) this.scheduleGeoFlush();
    });
    return this.geoFlushing;
  }

  private async runGeoBatch(): Promise<number> {
    // Provider turned off since the IPs were queued (e.g. unreadable mmdb):
    // drop the queue instead of re-queuing it every GEO_FLUSH_MS forever.
    if (!geoipService.isEnabled()) {
      this.geoQueue.clear();
      return 0;
    }
    const batch: string[] = [];
    for (const ip of this.geoQueue) {
      batch.push(ip);
      if (batch.length >= GEO_BATCH_MAX) break;
    }
    for (const ip of batch) this.geoQueue.delete(ip);
    if (batch.length === 0) return 0;

    let missing: string[];
    try {
      const rows = await db.raw(
        `SELECT host(ip) AS ip FROM ip_reputation
          WHERE ip = ANY(?::inet[])
            AND geo_country_code IS NULL AND geo_city IS NULL AND asn IS NULL`,
        [batch],
      ) as { rows: Array<{ ip: string }> };
      missing = rows.rows.map((r) => r.ip);
    } catch (err) {
      for (const ip of batch) this.geoQueue.add(ip);
      throw err;
    }
    if (missing.length === 0) return 0;

    const found = await geoipService.lookupMany(missing);
    if (!geoipService.isEnabled()) return 0;
    for (const raw of missing) {
      const ip = geoLookupCandidate(raw);
      if (ip && !found.has(ip) && this.geoQueue.size < GEO_QUEUE_MAX) this.geoQueue.add(ip);
    }
    return this.persistGeo(found);
  }

  /**
   * Write lookup results into ip_reputation. Only rows whose three geo
   * columns are still null are touched (never overwrites), and updated_at is
   * left alone (it tracks attack activity, not enrichment).
   */
  async persistGeo(results: Map<string, GeoInfo | null>): Promise<number> {
    const ips: string[] = [];
    const cc: Array<string | null> = [];
    const city: Array<string | null> = [];
    const asn: Array<string | null> = [];
    for (const [ip, info] of results) {
      if (!info) continue;
      ips.push(ip);
      cc.push(info.countryCode);
      city.push(info.city);
      asn.push(info.asn);
    }
    if (ips.length === 0) return 0;
    const res = await db.raw(
      `UPDATE ip_reputation r
          SET geo_country_code = v.cc, geo_city = v.city, asn = v.asn
         FROM unnest(?::inet[], ?::text[], ?::text[], ?::text[]) AS v(ip, cc, city, asn)
        WHERE r.ip = v.ip
          AND r.geo_country_code IS NULL AND r.geo_city IS NULL AND r.asn IS NULL`,
      // Array bindings (unnest): typed as RawBinding so knex > 3.1.0 still compiles.
      [ips, cc, city, asn] as unknown as Knex.RawBinding[],
    ) as { rowCount?: number };
    return Number(res.rowCount ?? 0);
  }

  /**
   * Queue the most recently active rows that still have no geo (rows created
   * before GeoIP existed, queue overflow, earlier provider outages). Rows that
   * can never resolve (private / reserved addresses, cached misses) stay null
   * forever, so the scan pages past them (up to GEO_BACKFILL_SCAN_PAGES pages)
   * instead of letting them fill every pass and starve older public rows.
   */
  async backfillGeo(limit = GEO_BACKFILL_ROWS): Promise<number> {
    if (!geoipService.isEnabled()) return 0;
    const before = this.geoQueue.size;
    for (let page = 0; page < GEO_BACKFILL_SCAN_PAGES; page++) {
      const rows = await db.raw(
        `SELECT host(ip) AS ip FROM ip_reputation
          WHERE geo_country_code IS NULL AND geo_city IS NULL AND asn IS NULL
            AND masklen(ip) = CASE family(ip) WHEN 4 THEN 32 ELSE 128 END
          ORDER BY last_seen DESC NULLS LAST, ip
          LIMIT ? OFFSET ?`,
        [GEO_BACKFILL_ROWS, page * GEO_BACKFILL_ROWS],
      ) as { rows: Array<{ ip: string }> };
      this.enqueueGeo(rows.rows.map((r) => r.ip));
      if (rows.rows.length < GEO_BACKFILL_ROWS) break;
      if (this.geoQueue.size - before >= limit || this.geoQueue.size >= GEO_QUEUE_MAX) break;
    }
    return this.geoQueue.size - before;
  }

  /** Periodic backfill (index.ts starts it once at boot). Idempotent. */
  startGeoBackfill(): void {
    if (this.geoBackfillTimer || !geoipService.isEnabled()) return;
    const run = () => {
      this.backfillGeo().catch((err) => logger.warn({ err }, 'GeoIP backfill failed'));
    };
    const first = setTimeout(() => {
      run();
      this.geoBackfillTimer = setInterval(run, GEO_BACKFILL_EVERY_MS);
      this.geoBackfillTimer.unref?.();
    }, GEO_BACKFILL_FIRST_MS);
    first.unref?.();
    this.geoBackfillTimer = first;
    logger.info({ provider: geoipService.providerName }, 'GeoIP enrichment enabled');
  }

  stopGeoBackfill(): void {
    if (this.geoBackfillTimer) {
      clearTimeout(this.geoBackfillTimer);
      clearInterval(this.geoBackfillTimer);
    }
    this.geoBackfillTimer = null;
    if (this.geoTimer) clearTimeout(this.geoTimer);
    this.geoTimer = null;
  }

  /**
   * LATERAL joins picking at most ONE active ban and ONE whitelist entry per
   * IP (an IP is never listed twice, even when several tenants hold local
   * bans on it). Restricted callers only see global rows and the rows of
   * their read tenants.
   */
  private lateralJoins(tenants: ReadTenants, tenantId: number | null | undefined): {
    banSql: string; banBindings: unknown[]; wlSql: string; wlBindings: unknown[];
  } {
    const vis = (alias: string): { sql: string; bindings: unknown[] } => {
      if (tenants === 'all') return { sql: '', bindings: [] };
      if (tenants.length === 0) return { sql: `AND ${alias}.scope = 'global'`, bindings: [] };
      return { sql: `AND (${alias}.scope = 'global' OR ${alias}.tenant_id IN ${inList(tenants)})`, bindings: [...tenants] };
    };
    const banVis = vis('bb');
    const wlVis = vis('ww');
    return {
      banSql: `LEFT JOIN LATERAL (SELECT bb.id, bb.scope, bb.tenant_id, bb.origin_tenant_id FROM ip_bans bb WHERE bb.ip = r.ip AND bb.is_active AND (bb.expires_at IS NULL OR bb.expires_at > now()) ${banVis.sql} ORDER BY (bb.scope = 'global') DESC, COALESCE(bb.tenant_id = ?, false) DESC, bb.banned_at DESC, bb.id DESC LIMIT 1) AS b ON true`,
      banBindings: [...banVis.bindings, tenantId ?? 0],
      wlSql: `LEFT JOIN LATERAL (SELECT ww.id FROM ip_whitelist ww WHERE r.ip <<= ww.ip ${wlVis.sql} ORDER BY (ww.scope = 'global') DESC, ww.id LIMIT 1) AS w ON true`,
      wlBindings: [...wlVis.bindings],
    };
  }

  /** Per-IP totals from the given tenants' own ip_events (keyed by the ip text). */
  private async tenantEventAggregates(ips: string[], tenants: number[]): Promise<Map<string, TenantAgg>> {
    const out = new Map<string, TenantAgg>();
    if (ips.length === 0 || tenants.length === 0) return out;
    const rows = await db('ip_events as e')
      .whereIn('e.ip', ips)
      .whereIn('e.tenant_id', tenants)
      .groupBy('e.ip')
      .select(
        'e.ip',
        db.raw("count(*) FILTER (WHERE e.event_type = 'auth_failure') AS failures"),
        db.raw("count(*) FILTER (WHERE e.event_type = 'auth_success') AS successes"),
        db.raw('count(DISTINCT e.device_id) AS agents'),
        db.raw('array_remove(array_agg(DISTINCT e.service), NULL) AS services'),
        db.raw("(array_remove(array_agg(DISTINCT NULLIF(e.username, '')), NULL))[1:100] AS usernames"),
        db.raw('min(e.timestamp) AS first_seen'),
        db.raw('max(e.timestamp) AS last_seen'),
        db.raw('(array_agg(e.device_id ORDER BY e.timestamp DESC))[1] AS last_device_id'),
      ) as Array<{
        ip: string; failures: string; successes: string; agents: string;
        services: string[] | string | null; usernames: string[] | string | null;
        first_seen: Date | null; last_seen: Date | null; last_device_id: number | null;
      }>;
    for (const r of rows) {
      out.set(String(r.ip), {
        failures: Number(r.failures),
        successes: Number(r.successes),
        agents: Number(r.agents),
        services: parseJsonArray(r.services),
        usernames: parseJsonArray(r.usernames),
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        lastDeviceId: r.last_device_id ?? null,
      });
    }
    return out;
  }

  /** Restricted callers: override the global totals with the read tenants' own (or zero them). */
  private async scopeTotals<T extends IpReputation>(items: T[], tenants: ReadTenants): Promise<T[]> {
    if (tenants === 'all') return items;
    if (tenants.length === 0) return items.map((it) => applyTenantTotals(it, undefined));
    const aggs = await this.tenantEventAggregates([...new Set(items.map((it) => String(it.ip)))], tenants);
    return items.map((it) => applyTenantTotals(it, aggs.get(String(it.ip))));
  }

  /** Tenants (within the read scope) whose agents logged events from each IP, ascending. */
  private async eventTenants(ips: string[], tenants: ReadTenants): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (ips.length === 0 || (tenants !== 'all' && tenants.length === 0)) return out;
    const q = db('ip_events as e')
      .whereIn('e.ip', ips)
      .whereNotNull('e.tenant_id')
      .groupBy('e.ip')
      .select('e.ip', db.raw('array_agg(DISTINCT e.tenant_id ORDER BY e.tenant_id) AS tenant_ids'));
    whereReadTenants(q, 'e.tenant_id', tenants);
    const rows = await q as Array<{ ip: string; tenant_ids: Array<number | string> | null }>;
    for (const r of rows) out.set(String(r.ip), (r.tenant_ids ?? []).map(Number));
    return out;
  }

  /**
   * Tenant attribution of reputation rows (see IpReputationListItem). `owners`
   * (same order as `items`) sets tenantId explicitly: the ban owner on the
   * banned list.
   */
  private async attribute<T extends IpReputation>(
    items: T[],
    tenants: ReadTenants,
    owners?: Array<number | null>,
  ): Promise<Array<T & { tenantId: number | null; tenantName: string | null; tenantIds: number[] }>> {
    const byIp = await this.eventTenants([...new Set(items.map((it) => String(it.ip)))], tenants);
    const resolved = items.map((it, i) => {
      const ids = byIp.get(String(it.ip)) ?? [];
      const owner = owners ? owners[i] : (ids.length === 1 ? ids[0] : null);
      return { it, ids, owner: owner == null ? null : Number(owner) };
    });
    const nameIds = [...new Set(resolved.map((r) => r.owner).filter((v): v is number => v != null))];
    const names = new Map<number, string>();
    if (nameIds.length > 0) {
      const rows = await db('tenants').whereIn('id', nameIds).select('id', 'name') as Array<{ id: number; name: string }>;
      for (const r of rows) names.set(Number(r.id), r.name);
    }
    return resolved.map(({ it, ids, owner }) => ({
      ...it,
      tenantId: owner,
      tenantName: owner != null ? names.get(owner) ?? null : null,
      tenantIds: ids,
    }));
  }

  /**
   * Lists IP reputation records with optional filters.
   *
   * For status='banned': queries from ip_bans as the driving table so that
   * IPs with an active ban but no reputation row (e.g. manually-created bans
   * or historical entries before the events fix) are always visible. One row
   * per ban (the client keys rows by ban id).
   *
   * For status='suspicious'/'clean'/'all': queries from ip_reputation, one row
   * per IP (LATERAL ban / whitelist joins).
   *
   * Read scope (readTenantsFor, W10-5): the Default tenant sees every tenant,
   * optionally narrowed by `tenantIds` (tenant chips); any other tenant only
   * reads itself, whatever the platform role. A restricted scope:
   *   - only lists IPs with ip_events for the read tenants' agents, with
   *     totals computed from those events;
   *   - only sees global bans / whitelist entries and the read tenants' own;
   *   - on a customer tenant, follows its clears: an IP is suspicious only
   *     when total_failures > baseline_failures (the counter value at the
   *     time of its last "clear suspicious" action).
   * Every row carries its tenant attribution (IpReputationListItem).
   */
  async list(filters: {
    tenantId?: number;
    /** Kept for the callers; the platform role no longer widens the view. */
    isAdmin?: boolean;
    /** God view only (Default): narrow to these tenants (`?tenants=`). */
    tenantIds?: number[];
    status?: IpStatus;
    search?: string;
    limit?: number;
    offset?: number;
    /** Whitelisted key; omitted = lastSeen (bannedAt on the banned list). */
    sortBy?: ReputationSortKey;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ data: IpReputationListItem[]; total: number }> {
    // Bounded even when called without the controller's parsing.
    const limit  = Math.min(Math.max(filters.limit ?? 50, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const tenantId = filters.tenantId;
    const isAdmin  = filters.isAdmin ?? false;
    const tenants = readTenantsFor(tenantId, filters.tenantIds);
    const sortOrder = filters.sortOrder ?? 'desc';
    const tenantOnly = tenants === 'all' ? null : tenants;
    // Per-tenant "clear suspicious" baselines only apply on a customer tenant.
    const clearTenant = tenantId != null && !isMasterTenant(tenantId) ? tenantId : null;

    // ── "Banned" uses ip_bans as the driving table ──────────────────────────
    // This guarantees IPs that are banned but have no reputation row still appear.
    if (filters.status === 'banned') {
      let q = db('ip_bans as b')
        .leftJoin('ip_reputation as r', db.raw('r.ip = b.ip'))
        .select(
          db.raw("COALESCE(r.ip, b.ip) AS ip"),
          db.raw("COALESCE(r.total_failures, 0) AS total_failures"),
          db.raw("COALESCE(r.total_successes, 0) AS total_successes"),
          db.raw("COALESCE(r.affected_agents_count, 0) AS affected_agents_count"),
          db.raw("COALESCE(r.affected_services, '{}') AS affected_services"),
          db.raw("COALESCE(r.attempted_usernames, '{}') AS attempted_usernames"),
          db.raw('r.first_seen'),
          db.raw('r.last_seen'),
          db.raw('r.last_event_device_id'),
          db.raw('r.geo_country_code'),
          db.raw('r.geo_city'),
          db.raw('r.asn'),
          db.raw('COALESCE(r.updated_at, b.banned_at) AS updated_at'),
          'b.id as active_ban_id',
          'b.scope as active_ban_scope',
          'b.tenant_id as active_ban_tenant_id',
          'b.origin_tenant_id as active_ban_origin_tenant_id',
          'b.ban_type as ban_type',
          'b.banned_by_user_id as banned_by_user_id',
        )
        .where('b.is_active', true)
        .where(function () {
          this.whereNull('b.expires_at').orWhere('b.expires_at', '>', new Date());
        });

      // Restricted callers never see another tenant's local bans.
      q = applyBanReadTenants(q, tenants, 'b');

      // Has THIS tenant already overridden the ban locally? (unique(ban_id,tenant_id)
      // ⇒ at most one match, so the row count / total stays correct)
      if (tenantId != null) {
        q = q
          .leftJoin('ip_ban_exclusions as bex', function () {
            this.on('bex.ban_id', '=', 'b.id').andOnVal('bex.tenant_id', '=', tenantId);
          })
          .select(db.raw('bex.id IS NOT NULL AS active_ban_excluded'));
      }

      if (filters.search) {
        const s = banSearchSql(filters.search);
        q.whereRaw(s.sql, s.bindings);
      }

      const countResult = await q.clone().clearSelect().count('b.id as count').first() as { count: string } | undefined;
      const total = Number(countResult?.count ?? 0);

      // Historical default: newest ban first.
      const order = reputationOrderBy(filters.sortBy ?? 'bannedAt', sortOrder, { banned: true, tenantOnly });
      const rows = await q.orderByRaw(order.sql, order.bindings).limit(limit).offset(offset) as Array<
        IpReputationRow & {
          active_ban_id: number | null;
          active_ban_scope: string | null;
          active_ban_tenant_id: number | null;
          active_ban_origin_tenant_id: number | null;
          active_ban_excluded?: boolean;
          ban_type: string | null;
          banned_by_user_id: number | null;
        }
      >;

      const data = rows.map((row) => ({
        ...rowToReputation(row, 'banned'),
        activeBanId: row.active_ban_id ?? null,
        activeBanScope: (row.active_ban_scope as IpReputation['activeBanScope']) ?? null,
        activeBanIsOrigin:
          tenantId != null &&
          row.active_ban_origin_tenant_id != null &&
          row.active_ban_origin_tenant_id === tenantId,
        activeBanExcluded: row.active_ban_excluded ?? false,
        banType: row.ban_type ?? null,
        bannedByUserId: canSeeBanAuthor(
          { tenant_id: row.active_ban_tenant_id, origin_tenant_id: row.active_ban_origin_tenant_id },
          tenantId, isAdmin,
        ) ? (row.banned_by_user_id ?? null) : null,
      }));

      const scoped = await this.scopeTotals(data, tenants);
      return { data: await this.attribute(scoped, tenants, rows.map((r) => r.active_ban_tenant_id)), total };
    }

    // ── All other statuses: ip_reputation as driving table ───────────────────

    // Suspicious case: per-tenant clear baseline
    // CASE expression is different depending on whether we have a tenant context.
    const suspiciousExpr = clearTenant != null
      ? `r.total_failures > COALESCE(clr.baseline_failures, 0)`
      : `r.total_failures > 0`;

    const STATUS_CASE = `(CASE
      WHEN b.id IS NOT NULL THEN 'banned'
      WHEN w.id IS NOT NULL THEN 'whitelisted'
      WHEN ${suspiciousExpr} THEN 'suspicious'
      ELSE 'clean'
    END)`;

    const { banSql, banBindings, wlSql, wlBindings } = this.lateralJoins(tenants, tenantId);

    // Restricted scope: only IPs with ip_events for the read tenants' agents.
    const hasTenantEvents = (q: Knex.QueryBuilder): void => {
      if (tenants === 'all') return;
      q.whereExists(
        db('ip_events as e')
          .where('e.ip', db.raw('r.ip'))
          .whereIn('e.tenant_id', tenants)
          .select(db.raw('1')),
      );
    };

    // Joins stay in this order: the bex join below resolves b.id.
    const baseQuery = db
      .from('ip_reputation as r')
      .joinRaw(banSql, banBindings as any[])
      .joinRaw(wlSql, wlBindings as any[])
      .select(
        'r.*',
        'b.id as active_ban_id',
        'b.scope as active_ban_scope',
        'b.tenant_id as active_ban_tenant_id',
        'b.origin_tenant_id as active_ban_origin_tenant_id',
        db.raw(`${STATUS_CASE} AS computed_status`),
      );

    // Has THIS tenant already overridden the active ban locally?
    if (tenantId != null) {
      baseQuery
        .leftJoin('ip_ban_exclusions as bex', function () {
          this.on('bex.ban_id', '=', 'b.id').andOnVal('bex.tenant_id', '=', tenantId);
        })
        .select(db.raw('bex.id IS NOT NULL AS active_ban_excluded'));
    }

    // Per-tenant clear baseline (customer tenants only)
    if (clearTenant != null) {
      baseQuery.leftJoin('ip_reputation_tenant_clears as clr', function () {
        // clr.ip is text, r.ip is inet — cast to compare, else Postgres throws
        // "operator does not exist: text = inet" (500 on the non-admin path).
        this.on(db.raw('clr.ip::inet = r.ip')).andOnVal('clr.tenant_id', '=', clearTenant);
      });
      // Also expose whether this tenant has a clear record
      baseQuery.select(db.raw('clr.baseline_failures IS NOT NULL AS cleared_for_tenant'));
    }
    hasTenantEvents(baseQuery);

    const search = filters.search ? ipSearchSql('r.ip', parseIpSearch(filters.search)) : null;
    if (search) {
      baseQuery.whereRaw(search.sql, search.bindings);
    }

    if (filters.status) {
      baseQuery.whereRaw(`${STATUS_CASE} = ?`, [filters.status]);
    }

    // Count query (same joins + same filters, no limit/offset)
    const countQuery = db
      .from('ip_reputation as r')
      .joinRaw(banSql, banBindings as any[])
      .joinRaw(wlSql, wlBindings as any[])
      .count<Array<{ count: string }>>({ count: 'r.ip' });

    if (clearTenant != null) {
      countQuery.leftJoin('ip_reputation_tenant_clears as clr', function () {
        // clr.ip is text, r.ip is inet — cast to compare (see baseQuery above).
        this.on(db.raw('clr.ip::inet = r.ip')).andOnVal('clr.tenant_id', '=', clearTenant);
      });
    }
    hasTenantEvents(countQuery);

    if (search) {
      countQuery.whereRaw(search.sql, search.bindings);
    }

    if (filters.status) {
      countQuery.whereRaw(`${STATUS_CASE} = ?`, [filters.status]);
    }

    const [countResult] = await countQuery;
    const total = Number(countResult?.count ?? 0);

    const order = reputationOrderBy(filters.sortBy ?? 'lastSeen', sortOrder, { banned: false, tenantOnly });
    const rows = await baseQuery
      .orderByRaw(order.sql, order.bindings)
      .limit(limit)
      .offset(offset);

    const data = (rows as Array<IpReputationRow & {
      computed_status: string;
      active_ban_id: number | null;
      active_ban_scope: string | null;
      active_ban_tenant_id: number | null;
      active_ban_origin_tenant_id: number | null;
      active_ban_excluded?: boolean;
      cleared_for_tenant?: boolean;
    }>).map((row) => ({
      ...rowToReputation(row, row.computed_status as IpStatus, row.cleared_for_tenant ?? false),
      activeBanId: row.active_ban_id ?? null,
      activeBanScope: (row.active_ban_scope as IpReputation['activeBanScope']) ?? null,
      activeBanIsOrigin:
        tenantId != null &&
        row.active_ban_origin_tenant_id != null &&
        row.active_ban_origin_tenant_id === tenantId,
      activeBanExcluded: row.active_ban_excluded ?? false,
    }));

    return { data: await this.attribute(await this.scopeTotals(data, tenants), tenants), total };
  }

  /** Active ban / whitelist lookups for one IP, scoped to the read tenants. */
  private async statusRows(ip: string, tenants: ReadTenants): Promise<{ ban: unknown; wl: unknown }> {
    const scoped = (q: ReturnType<typeof db>) => {
      if (tenants === 'all') return q;
      if (tenants.length === 0) return q.where('scope', 'global');
      return q.where(function () { this.where('scope', 'global').orWhereIn('tenant_id', tenants); });
    };
    const ban = await scoped(
      db('ip_bans')
        .where({ is_active: true })
        .whereRaw('ip = ?::inet', [ip])
        .where(function () {
          this.whereNull('expires_at').orWhere('expires_at', '>', new Date());
        }),
    ).first();
    const wl = ban ? undefined : await scoped(db('ip_whitelist').whereRaw('?::inet <<= ip', [ip])).first();
    return { ban, wl };
  }

  /**
   * Status of one IP for the caller (banned > whitelisted > suspicious >
   * clean); a customer tenant's clear baseline can hide the suspicious state.
   */
  private async statusFor(
    ip: string,
    row: IpReputationRow | undefined,
    tenants: ReadTenants,
    clearTenant: number | null,
  ): Promise<{ status: IpStatus; cleared: boolean }> {
    const { ban, wl } = await this.statusRows(ip, tenants);
    if (ban) return { status: 'banned', cleared: false };
    if (wl) return { status: 'whitelisted', cleared: false };
    if (!row || Number(row.total_failures) <= 0) return { status: 'clean', cleared: false };
    if (clearTenant == null) return { status: 'suspicious', cleared: false };
    const clr = await db('ip_reputation_tenant_clears')
      .where({ ip, tenant_id: clearTenant })
      .first() as { baseline_failures: number } | undefined;
    if (!clr) return { status: 'suspicious', cleared: false };
    return { status: Number(row.total_failures) > clr.baseline_failures ? 'suspicious' : 'clean', cleared: true };
  }

  /**
   * Fetches a single IP reputation record by IP address, in the operating
   * tenant's read scope (the platform role grants nothing extra).
   */
  async getByIp(ip: string, tenantId?: number, _isAdmin?: boolean): Promise<IpReputation | null> {
    const row = await db<IpReputationRow>('ip_reputation').where({ ip }).first();
    if (!row) return null;
    const tenants = readTenantsFor(tenantId);
    const clearTenant = tenantId != null && !isMasterTenant(tenantId) ? tenantId : null;
    const { status, cleared } = await this.statusFor(ip, row, tenants, clearTenant);
    const [rep] = await this.scopeTotals([rowToReputation(row, status, cleared)], tenants);
    return rep;
  }

  /**
   * Returns detailed info about a specific IP, in the operating tenant's read
   * scope: reputation (with its tenant attribution) + recent events.
   */
  async getIpDetail(
    ip: string,
    tenantId?: number,
    _isAdmin?: boolean,
  ): Promise<{ reputation: IpReputationListItem | null; recentEvents: IpEvent[] } | null> {
    const row = await db<IpReputationRow>('ip_reputation').where({ ip }).first();
    const tenants = readTenantsFor(tenantId);
    const clearTenant = tenantId != null && !isMasterTenant(tenantId) ? tenantId : null;
    const { status, cleared } = await this.statusFor(ip, row, tenants, clearTenant);

    const reputation = row
      ? (await this.attribute(await this.scopeTotals([rowToReputation(row, status, cleared)], tenants), tenants))[0]
      : null;

    const eventQ = db<IpEventRow>('ip_events as e')
      .leftJoin('agent_devices as d', 'd.id', 'e.device_id')
      .where('e.ip', ip)
      .select('e.*', 'd.hostname')
      .orderBy('e.timestamp', 'desc')
      .limit(50);
    whereReadTenants(eventQ, 'e.tenant_id', tenants);
    const eventRows = await eventQ;
    const recentEvents = eventRows.map(rowToEvent);

    if (!reputation && recentEvents.length === 0) return null;
    return { reputation, recentEvents };
  }

  /**
   * Fetches recent IP events for a given IP address.
   * Joins with agent_devices to include hostname.
   */
  async getRecentEvents(ip: string, limit = 50): Promise<IpEvent[]> {
    const rows = await db<IpEventRow>('ip_events as e')
      .leftJoin('agent_devices as d', 'd.id', 'e.device_id')
      .where('e.ip', ip)
      .select('e.*', 'd.hostname')
      .orderBy('e.timestamp', 'desc')
      .limit(limit);

    return rows.map(rowToEvent);
  }

  /**
   * Clears an IP's suspicious status for a specific tenant.
   *
   * Records a baseline equal to the current total_failures.
   * The IP becomes suspicious again only when new failures arrive (total_failures > baseline).
   */
  async clearForTenant(ip: string, tenantId: number, userId: number): Promise<void> {
    // Fetch current total_failures for this IP
    const row = await db('ip_reputation').where({ ip }).first() as { total_failures: number } | undefined;
    const baseline = Number(row?.total_failures ?? 0);

    await db('ip_reputation_tenant_clears')
      .insert({
        ip,
        tenant_id: tenantId,
        baseline_failures: baseline,
        cleared_at: new Date(),
        cleared_by: userId,
      })
      .onConflict(['ip', 'tenant_id'])
      .merge({
        baseline_failures: baseline,
        cleared_at: new Date(),
        cleared_by: userId,
      });
  }

  /**
   * Globally clears an IP's suspicious status (admin only).
   *
   * Resets total_failures to 0 on the ip_reputation row AND removes all
   * per-tenant clear baselines (everyone starts fresh at 0).
   */
  async clearGlobal(ip: string): Promise<void> {
    await db('ip_reputation')
      .where({ ip })
      .update({ total_failures: 0, updated_at: new Date() });

    // Remove per-tenant baselines — they're now obsolete (counter was reset to 0)
    await db('ip_reputation_tenant_clears').where({ ip }).delete();
  }

  /**
   * Manually marks an IP as suspicious.
   *
   * Upserts ip_reputation so total_failures >= 1 (status becomes 'suspicious'
   * unless the IP is banned/whitelisted). Also wipes any per-tenant baseline
   * that would mask the suspicious status.
   */
  async markSuspicious(ip: string): Promise<void> {
    const now = new Date();
    await db('ip_reputation')
      .insert({
        ip,
        total_failures: 1,
        total_successes: 0,
        affected_agents_count: 0,
        affected_services: [],
        attempted_usernames: [],
        first_seen: null,
        last_seen: null,
        last_event_device_id: null,
        geo_country_code: null,
        geo_city: null,
        asn: null,
        updated_at: now,
      })
      .onConflict('ip')
      .merge({
        total_failures: db.raw('GREATEST(ip_reputation.total_failures, 1)'),
        updated_at: now,
      });
    this.enqueueGeo([ip]);

    // Drop any tenant baselines that would hide the new suspicious state
    await db('ip_reputation_tenant_clears').where({ ip }).delete();
  }

  /**
   * Manually marks an IP as clean.
   *
   * Admins: resets global counter to 0 via clearGlobal.
   * Tenant users: installs a per-tenant baseline = current total_failures
   *   (same behaviour as clearForTenant).
   * Ensures a reputation row exists so the IP is visible in the list.
   */
  async markClean(ip: string, tenantId: number | undefined, isAdmin: boolean, userId: number): Promise<void> {
    await this.ensureExists(ip);
    if (isAdmin) {
      await this.clearGlobal(ip);
    } else {
      if (!tenantId) throw new Error('No tenant context');
      await this.clearForTenant(ip, tenantId, userId);
    }
  }
}

export const ipReputationService = new IpReputationService();
