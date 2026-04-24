import { db } from '../db';
import type { IpReputation, IpEvent, IpStatus } from '@obliview/shared';

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
          NULL,
          NULL,
          NULL,
          ?
        )
        ON CONFLICT (ip) DO UPDATE SET
          total_failures        = ip_reputation.total_failures + EXCLUDED.total_failures,
          total_successes       = ip_reputation.total_successes + EXCLUDED.total_successes,
          affected_agents_count = (
            SELECT COUNT(DISTINCT device_id)
            FROM ip_events
            WHERE ip_events.ip = ip_reputation.ip
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
   * Lists IP reputation records with optional filters.
   *
   * For status='banned': queries from ip_bans as the driving table so that
   * IPs with an active ban but no reputation row (e.g. manually-created bans
   * or historical entries before the events fix) are always visible.
   *
   * For status='suspicious'/'clean'/'all': queries from ip_reputation.
   *   - When tenantId is provided, restricts to IPs that have ip_events for
   *     that tenant's agents.
   *   - Suspicious threshold is adjusted by per-tenant clears: an IP is
   *     suspicious for a tenant only when total_failures > baseline_failures
   *     (the counter value at the time of their last "clear suspicious" action).
   */
  async list(filters: {
    tenantId?: number;
    isAdmin?: boolean;
    status?: IpStatus;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: IpReputation[]; total: number }> {
    const limit  = filters.limit  ?? 50;
    const offset = filters.offset ?? 0;
    const tenantId = filters.tenantId;
    const isAdmin  = filters.isAdmin ?? false;

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
          'b.ban_type as ban_type',
          'b.banned_by_user_id as banned_by_user_id',
        )
        .where('b.is_active', true)
        .where(function () {
          this.whereNull('b.expires_at').orWhere('b.expires_at', '>', new Date());
        });

      if (filters.search) {
        q.whereRaw("b.ip::text ILIKE ?", [`%${filters.search}%`]);
      }

      const countResult = await q.clone().clearSelect().count('b.id as count').first() as { count: string } | undefined;
      const total = Number(countResult?.count ?? 0);

      const rows = await q.orderBy('b.banned_at', 'desc').limit(limit).offset(offset) as Array<
        IpReputationRow & { active_ban_id: number | null; ban_type: string | null; banned_by_user_id: number | null }
      >;

      const data = rows.map((row) => ({
        ...rowToReputation(row, 'banned'),
        activeBanId: row.active_ban_id ?? null,
        banType: row.ban_type ?? null,
        bannedByUserId: row.banned_by_user_id ?? null,
      }));

      return { data, total };
    }

    // ── All other statuses: ip_reputation as driving table ───────────────────

    // Suspicious case: per-tenant clear baseline
    // CASE expression is different depending on whether we have a tenant context.
    const suspiciousExpr = tenantId && !isAdmin
      ? `r.total_failures > COALESCE(clr.baseline_failures, 0)`
      : `r.total_failures > 0`;

    const STATUS_CASE = `(CASE
      WHEN b.id IS NOT NULL THEN 'banned'
      WHEN w.id IS NOT NULL THEN 'whitelisted'
      WHEN ${suspiciousExpr} THEN 'suspicious'
      ELSE 'clean'
    END)`;

    const baseQuery = db
      .from('ip_reputation as r')
      .leftJoin('ip_bans as b', function () {
        this.on('b.ip', '=', db.raw('r.ip::inet'))
          .andOn(db.raw('b.is_active = true'))
          .andOn(db.raw('(b.expires_at IS NULL OR b.expires_at > NOW())'));
      })
      .leftJoin('ip_whitelist as w', db.raw("r.ip <<= w.ip"))
      .select(
        'r.*',
        'b.id as active_ban_id',
        db.raw(`${STATUS_CASE} AS computed_status`),
      );

    // Per-tenant clear baseline — join only for non-admin tenant users
    if (tenantId && !isAdmin) {
      baseQuery.leftJoin('ip_reputation_tenant_clears as clr', function () {
        this.on('clr.ip', '=', 'r.ip').andOnVal('clr.tenant_id', '=', tenantId);
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

    if (filters.search) {
      baseQuery.whereRaw('r.ip::text ILIKE ?', [`%${filters.search}%`]);
    }

    if (filters.status) {
      baseQuery.whereRaw(`${STATUS_CASE} = ?`, [filters.status]);
    }

    // Count query (same joins + same filters, no limit/offset)
    const countQuery = db
      .from('ip_reputation as r')
      .leftJoin('ip_bans as b', function () {
        this.on('b.ip', '=', db.raw('r.ip::inet'))
          .andOn(db.raw('b.is_active = true'))
          .andOn(db.raw('(b.expires_at IS NULL OR b.expires_at > NOW())'));
      })
      .leftJoin('ip_whitelist as w', db.raw("r.ip <<= w.ip"))
      .count<Array<{ count: string }>>({ count: 'r.ip' });

    if (tenantId && !isAdmin) {
      countQuery.leftJoin('ip_reputation_tenant_clears as clr', function () {
        this.on('clr.ip', '=', 'r.ip').andOnVal('clr.tenant_id', '=', tenantId);
      });
      countQuery.whereExists(
        db('ip_events as e')
          .where('e.ip', db.raw('r.ip'))
          .where('e.tenant_id', tenantId)
          .select(db.raw('1')),
      );
    }

    if (filters.search) {
      countQuery.whereRaw('r.ip::text ILIKE ?', [`%${filters.search}%`]);
    }

    if (filters.status) {
      countQuery.whereRaw(`${STATUS_CASE} = ?`, [filters.status]);
    }

    const [countResult] = await countQuery;
    const total = Number(countResult?.count ?? 0);

    const rows = await baseQuery
      .orderBy('r.last_seen', 'desc')
      .limit(limit)
      .offset(offset);

    const data = (rows as Array<IpReputationRow & {
      computed_status: string;
      active_ban_id: number | null;
      cleared_for_tenant?: boolean;
    }>).map((row) => ({
      ...rowToReputation(row, row.computed_status as IpStatus, row.cleared_for_tenant ?? false),
      activeBanId: row.active_ban_id ?? null,
    }));

    return { data, total };
  }

  /**
   * Fetches a single IP reputation record by IP address.
   */
  async getByIp(ip: string, tenantId?: number, isAdmin?: boolean): Promise<IpReputation | null> {
    const row = await db<IpReputationRow>('ip_reputation').where({ ip }).first();
    if (!row) return null;

    // Compute status
    const ban = await db('ip_bans')
      .where({ is_active: true })
      .whereRaw('ip = ?::inet', [ip])
      .where(function () {
        this.whereNull('expires_at').orWhere('expires_at', '>', new Date());
      })
      .first();

    let status: IpStatus = 'clean';
    let cleared = false;

    if (ban) {
      status = 'banned';
    } else {
      const wl = await db('ip_whitelist').whereRaw('?::inet <<= ip', [ip]).first();
      if (wl) {
        status = 'whitelisted';
      } else if (Number(row.total_failures) > 0) {
        if (tenantId && !isAdmin) {
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

    return rowToReputation(row, status, cleared);
  }

  /**
   * Returns detailed info about a specific IP: reputation + recent events.
   */
  async getIpDetail(ip: string, tenantId?: number, isAdmin?: boolean): Promise<{ reputation: IpReputation | null; recentEvents: IpEvent[] } | null> {
    const row = await db<IpReputationRow>('ip_reputation').where({ ip }).first();
    const ban = await db('ip_bans').where({ is_active: true }).whereRaw('ip = ?::inet', [ip]).first();

    let status: IpStatus = 'clean';
    let cleared = false;

    if (ban) {
      status = 'banned';
    } else {
      const wl = await db('ip_whitelist').whereRaw('?::inet <<= ip', [ip]).first();
      if (wl) {
        status = 'whitelisted';
      } else if (row && Number(row.total_failures) > 0) {
        if (tenantId && !isAdmin) {
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

    const reputation = row ? rowToReputation(row, status, cleared) : null;

    const eventQ = db<IpEventRow>('ip_events as e')
      .leftJoin('agent_devices as d', 'd.id', 'e.device_id')
      .where('e.ip', ip)
      .select('e.*', 'd.hostname')
      .orderBy('e.timestamp', 'desc')
      .limit(50);
    if (tenantId && !isAdmin) { eventQ.where('e.tenant_id', tenantId); }
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
