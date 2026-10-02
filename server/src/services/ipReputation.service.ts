import { db } from '../db';
import type { IpReputation, IpEvent, IpStatus } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';
import { seesAllBans, canSeeBanAuthor } from './banVisibility';
import { parseIpSearch, ipSearchSql } from '../utils/pagination';

/** Per-IP totals computed from ONE tenant's own ip_events (restricted callers). */
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
 * Totals shown to a restricted caller (customer tenant): from its own events
 * only (tenantId set), or zeroed (no tenant). Default / platform admins keep
 * the global ip_reputation values (god view).
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
  o: { banned: boolean; tenantOnly: number | null },
): { sql: string; bindings: number[] } {
  const ipCol = o.banned ? 'b.ip' : 'r.ip';
  const tail = o.banned ? `, ${ipCol} ASC, b.id ASC` : `, ${ipCol} ASC`;
  const tenantAgg = (agg: string, extra = '') =>
    `(SELECT ${agg} FROM ip_events se WHERE se.ip = ${ipCol} AND se.tenant_id = ?${extra})`;
  const num = (col: string) => (o.banned ? `COALESCE(${col}, 0)` : col);

  let expr: string;
  const bindings: number[] = [];
  const t = o.tenantOnly;
  // No ban column on the reputation list: bannedAt falls back to the default.
  switch (key === 'bannedAt' && !o.banned ? 'lastSeen' : key) {
    case 'failures':
      if (t != null) { expr = tenantAgg('count(*)', " AND se.event_type = 'auth_failure'"); bindings.push(t); }
      else expr = num('r.total_failures');
      break;
    case 'agents':
      if (t != null) { expr = tenantAgg('count(DISTINCT se.device_id)'); bindings.push(t); }
      else expr = num('r.affected_agents_count');
      break;
    case 'country':
      expr = 'r.geo_country_code';
      break;
    case 'firstSeen':
      if (t != null) { expr = tenantAgg('min(se.timestamp)'); bindings.push(t); }
      else expr = 'r.first_seen';
      break;
    case 'bannedAt':
      expr = 'b.banned_at';
      break;
    case 'lastSeen':
    default:
      if (t != null) { expr = tenantAgg('max(se.timestamp)'); bindings.push(t); }
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
  }

  /**
   * LATERAL joins picking at most ONE active ban and ONE whitelist entry per
   * IP (an IP is never listed twice, even when several tenants hold local
   * bans on it). Restricted callers only see global rows and their own.
   */
  private lateralJoins(restrict: boolean, tenantId: number | null | undefined): {
    banSql: string; banBindings: unknown[]; wlSql: string; wlBindings: unknown[];
  } {
    const vis = (alias: string): { sql: string; bindings: unknown[] } => {
      if (!restrict) return { sql: '', bindings: [] };
      if (tenantId == null) return { sql: `AND ${alias}.scope = 'global'`, bindings: [] };
      return { sql: `AND (${alias}.scope = 'global' OR ${alias}.tenant_id = ?)`, bindings: [tenantId] };
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

  /** Per-IP totals from one tenant's own ip_events (keyed by the ip text). */
  private async tenantEventAggregates(ips: string[], tenantId: number): Promise<Map<string, TenantAgg>> {
    const out = new Map<string, TenantAgg>();
    if (ips.length === 0) return out;
    const rows = await db('ip_events as e')
      .whereIn('e.ip', ips)
      .where('e.tenant_id', tenantId)
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

  /** Restricted callers: override the global totals with the tenant's own (or zero them). */
  private async scopeTotals<T extends IpReputation>(items: T[], restrict: boolean, tenantId: number | null | undefined): Promise<T[]> {
    if (!restrict) return items;
    if (tenantId == null) return items.map((it) => applyTenantTotals(it, undefined));
    const aggs = await this.tenantEventAggregates([...new Set(items.map((it) => String(it.ip)))], tenantId);
    return items.map((it) => applyTenantTotals(it, aggs.get(String(it.ip))));
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
   *   - When tenantId is provided, restricts to IPs that have ip_events for
   *     that tenant's agents.
   *   - Suspicious threshold is adjusted by per-tenant clears: an IP is
   *     suspicious for a tenant only when total_failures > baseline_failures
   *     (the counter value at the time of their last "clear suspicious" action).
   *
   * Restricted callers (customer tenants) only see global bans / whitelist
   * entries and their own, and their totals come from their own ip_events.
   */
  async list(filters: {
    tenantId?: number;
    isAdmin?: boolean;
    status?: IpStatus;
    search?: string;
    limit?: number;
    offset?: number;
    /** Whitelisted key; omitted = lastSeen (bannedAt on the banned list). */
    sortBy?: ReputationSortKey;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ data: IpReputation[]; total: number }> {
    // Bounded even when called without the controller's parsing.
    const limit  = Math.min(Math.max(filters.limit ?? 50, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const tenantId = filters.tenantId;
    const isAdmin  = filters.isAdmin ?? false;
    const restrict = !seesAllBans(tenantId, isAdmin);
    const sortOrder = filters.sortOrder ?? 'desc';
    const tenantOnly = restrict && tenantId != null ? tenantId : null;

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
      if (restrict) {
        if (tenantId == null) q = q.where('b.scope', 'global');
        else q = q.where(function () { this.where('b.scope', 'global').orWhere('b.tenant_id', tenantId); });
      }

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

      return { data: await this.scopeTotals(data, restrict, tenantId), total };
    }

    // ── All other statuses: ip_reputation as driving table ───────────────────

    // Suspicious case: per-tenant clear baseline
    // CASE expression is different depending on whether we have a tenant context.
    const suspiciousExpr = tenantId && !isAdmin && !isMasterTenant(tenantId)
      ? `r.total_failures > COALESCE(clr.baseline_failures, 0)`
      : `r.total_failures > 0`;

    const STATUS_CASE = `(CASE
      WHEN b.id IS NOT NULL THEN 'banned'
      WHEN w.id IS NOT NULL THEN 'whitelisted'
      WHEN ${suspiciousExpr} THEN 'suspicious'
      ELSE 'clean'
    END)`;

    const { banSql, banBindings, wlSql, wlBindings } = this.lateralJoins(restrict, tenantId);

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

    // Per-tenant clear baseline — join only for non-admin tenant users
    if (tenantId && !isAdmin && !isMasterTenant(tenantId)) {
      baseQuery.leftJoin('ip_reputation_tenant_clears as clr', function () {
        // clr.ip is text, r.ip is inet — cast to compare, else Postgres throws
        // "operator does not exist: text = inet" (500 on the non-admin path).
        this.on(db.raw('clr.ip::inet = r.ip')).andOnVal('clr.tenant_id', '=', tenantId);
      });
      // Also expose whether this tenant has a clear record
      baseQuery.select(db.raw('clr.baseline_failures IS NOT NULL AS cleared_for_tenant'));

      // Restrict to IPs that have events for THIS tenant's agents
      baseQuery.whereExists(
        db('ip_events as e')
          .where('e.ip', db.raw('r.ip'))
          .where('e.tenant_id', tenantId)
          .select(db.raw('1')),
      );
    }

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

    if (tenantId && !isAdmin && !isMasterTenant(tenantId)) {
      countQuery.leftJoin('ip_reputation_tenant_clears as clr', function () {
        // clr.ip is text, r.ip is inet — cast to compare (see baseQuery above).
        this.on(db.raw('clr.ip::inet = r.ip')).andOnVal('clr.tenant_id', '=', tenantId);
      });
      countQuery.whereExists(
        db('ip_events as e')
          .where('e.ip', db.raw('r.ip'))
          .where('e.tenant_id', tenantId)
          .select(db.raw('1')),
      );
    }

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

    return { data: await this.scopeTotals(data, restrict, tenantId), total };
  }

  /** Active ban / whitelist lookups for one IP, scoped for restricted callers. */
  private async statusRows(ip: string, restrict: boolean, tenantId: number | null | undefined): Promise<{ ban: unknown; wl: unknown }> {
    const scoped = (q: ReturnType<typeof db>) => {
      if (!restrict) return q;
      if (tenantId == null) return q.where('scope', 'global');
      return q.where(function () { this.where('scope', 'global').orWhere('tenant_id', tenantId); });
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
   * Fetches a single IP reputation record by IP address.
   */
  async getByIp(ip: string, tenantId?: number, isAdmin?: boolean): Promise<IpReputation | null> {
    const row = await db<IpReputationRow>('ip_reputation').where({ ip }).first();
    if (!row) return null;
    const restrict = !seesAllBans(tenantId, isAdmin ?? false);

    // Compute status
    const { ban, wl } = await this.statusRows(ip, restrict, tenantId);

    let status: IpStatus = 'clean';
    let cleared = false;

    if (ban) {
      status = 'banned';
    } else {
      if (wl) {
        status = 'whitelisted';
      } else if (Number(row.total_failures) > 0) {
        if (tenantId && !isAdmin && !isMasterTenant(tenantId)) {
          // Check per-tenant baseline
          const clr = await db('ip_reputation_tenant_clears')
            .where({ ip, tenant_id: tenantId })
            .first() as { baseline_failures: number } | undefined;
          if (clr) {
            cleared = true;
            status = Number(row.total_failures) > clr.baseline_failures ? 'suspicious' : 'clean';
          } else {
            status = 'suspicious';
          }
        } else {
          status = 'suspicious';
        }
      }
    }

    const [rep] = await this.scopeTotals([rowToReputation(row, status, cleared)], restrict, tenantId);
    return rep;
  }

  /**
   * Returns detailed info about a specific IP: reputation + recent events.
   */
  async getIpDetail(ip: string, tenantId?: number, isAdmin?: boolean): Promise<{ reputation: IpReputation | null; recentEvents: IpEvent[] } | null> {
    const row = await db<IpReputationRow>('ip_reputation').where({ ip }).first();
    const restrict = !seesAllBans(tenantId, isAdmin ?? false);
    const { ban, wl } = await this.statusRows(ip, restrict, tenantId);

    let status: IpStatus = 'clean';
    let cleared = false;

    if (ban) {
      status = 'banned';
    } else {
      if (wl) {
        status = 'whitelisted';
      } else if (row && Number(row.total_failures) > 0) {
        if (tenantId && !isAdmin && !isMasterTenant(tenantId)) {
          const clr = await db('ip_reputation_tenant_clears')
            .where({ ip, tenant_id: tenantId })
            .first() as { baseline_failures: number } | undefined;
          if (clr) {
            cleared = true;
            status = Number(row.total_failures) > clr.baseline_failures ? 'suspicious' : 'clean';
          } else {
            status = 'suspicious';
          }
        } else {
          status = 'suspicious';
        }
      }
    }

    const reputation = row
      ? (await this.scopeTotals([rowToReputation(row, status, cleared)], restrict, tenantId))[0]
      : null;

    const eventQ = db<IpEventRow>('ip_events as e')
      .leftJoin('agent_devices as d', 'd.id', 'e.device_id')
      .where('e.ip', ip)
      .select('e.*', 'd.hostname')
      .orderBy('e.timestamp', 'desc')
      .limit(50);
    if (tenantId && !isAdmin && !isMasterTenant(tenantId)) { eventQ.where('e.tenant_id', tenantId); }
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
