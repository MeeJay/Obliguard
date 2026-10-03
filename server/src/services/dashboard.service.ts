/**
 * Dashboard summary (GET /api/dashboard/summary), mirroring Obliance's
 * deviceService.getFleetSummary: every number is computed server-side and
 * tenant-scoped, the Default tenant (master) aggregating the whole install.
 *
 * Bans: a non-Default tenant counts its own bans plus the global ones, since
 * global bans are enforced on its agents, minus the global bans it excluded
 * (ip_ban_exclusions). IP figures come from the tenant's own ip_events; the
 * Default tenant reads the global ip_reputation aggregates.
 *
 * Team scope (RBAC-8): for a user restricted by team grants (visibleAgentIds
 * is a list, permissionService.getVisibleAgentIds), the agent counters, the
 * per-agent table and every event-based figure (event totals, top IPs) only
 * cover the agents they see. Ban counters stay tenant-wide: bans are a tenant
 * policy, listed in full on the Bans page.
 *
 * W8-4 adds the trends (getSeries: snapshots of ipsSnapshot.service plus a
 * live current bucket), the day-over-day deltas of the summary, the
 * breakdowns and the per-group cards, under the same scoping rules.
 */
import type { Knex } from 'knex';
import { db } from '../db';
import { isMasterTenant } from '@obliview/shared';
import type {
  DashboardSummary, DashboardAgentStats, DashboardTopIp, DashboardDeltas,
  IpsSeriesPoint, DashboardBreakdown, DashboardBreakdownRow, DashboardGroupStats,
} from '@obliview/shared';
import { obliguardHub } from './obliguardHub.service';
import { getServedAgentVersion } from './agent.service';
import {
  banAudience, eventScope, computeFlows, computeGauges, bucketKeys, SNAPSHOT_TABLE,
} from './ipsSnapshot.service';
import type { SnapshotKind } from './ipsSnapshot.service';
import { isStrictlyNewerAgentVersion } from '../utils/agentUpdate';

const TOP_IPS = 5;
/** Upper bound of the per-agent table (busiest first). */
const MAX_PER_AGENT = 1000;

/** The ban's network: ip carries the address, cidr_prefix the mask (null = host). */
const BAN_NET = 'set_masklen(b.ip, COALESCE(b.cidr_prefix, masklen(b.ip)))';

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * Gauges of about 24 h ago for the day-over-day deltas: the hourly snapshot
 * of this hour yesterday, else yesterday's daily snapshot (state at its last
 * run). Null fields when no such snapshot holds them.
 */
async function referenceGauges(tenantId: number): Promise<{ activeBans: number | null; agentsConnected: number | null }> {
  const pick = (r: { active_bans: number | null; agents_connected: number | null } | undefined) => ({
    activeBans: r?.active_bans ?? null,
    agentsConnected: r?.agents_connected ?? null,
  });
  const hourly = await db(SNAPSHOT_TABLE.hourly)
    .where('tenant_id', tenantId)
    .whereRaw("bucket = date_trunc('hour', NOW()) - INTERVAL '24 hours'")
    .whereNotNull('active_bans')
    .first('active_bans', 'agents_connected');
  if (hourly) return pick(hourly);
  const daily = await db(SNAPSHOT_TABLE.daily)
    .where('tenant_id', tenantId)
    .whereRaw('bucket = CURRENT_DATE - 1')
    .first('active_bans', 'agents_connected');
  return pick(daily);
}

/** Top rows of a breakdown dimension. */
const BREAKDOWN_TOP = 8;

interface SnapshotRow {
  bucket: string | Date;
  events: number; failures: number; unique_ips: number; auto_bans: number; manual_bans: number;
  active_bans: number | null; agents_total: number | null; agents_connected: number | null;
}

interface DeviceRow {
  id: number;
  uuid: string;
  display_name: string;
  agent_version: string | null;
  device_type: string | null;
  eval_only: boolean;
}

export const dashboardService = {
  /**
   * `visibleAgentIds`: the caller's agent scope ('all' = no team restriction,
   * the default).
   */
  async getSummary(tenantId: number, visibleAgentIds: number[] | 'all' = 'all'): Promise<DashboardSummary> {
    const master = isMasterTenant(tenantId);
    const restricted = Array.isArray(visibleAgentIds);

    const activeBansQ = banAudience(
      db('ip_bans as b')
        .where('b.is_active', true)
        .whereRaw('(b.expires_at IS NULL OR b.expires_at > NOW())'),
      tenantId,
    ).count<Array<{ count: string }>>({ count: '*' });

    const bansTodayQ = banAudience(
      db('ip_bans as b').whereRaw('b.banned_at >= CURRENT_DATE').whereIn('b.ban_type', ['auto', 'manual']),
      tenantId,
    ).groupBy('b.ban_type').select('b.ban_type', db.raw('count(*) AS count'));

    // One pass over the last two days: today, rolling-24h figures and the
    // 24 h before them (day-over-day deltas).
    const eventTotalsQ = eventScope(db('ip_events as e'), tenantId, visibleAgentIds)
      .whereRaw("e.timestamp >= LEAST(CURRENT_DATE::timestamptz, NOW() - INTERVAL '48 hours')")
      .select(
        db.raw('count(*) FILTER (WHERE e.timestamp >= CURRENT_DATE) AS events_today'),
        db.raw("count(*) FILTER (WHERE e.timestamp >= CURRENT_DATE AND e.event_type = 'auth_failure') AS failures_today"),
        db.raw("count(DISTINCT e.ip) FILTER (WHERE e.timestamp >= CURRENT_DATE AND e.event_type = 'auth_failure') AS ips_today"),
        db.raw("count(*) FILTER (WHERE e.timestamp >= NOW() - INTERVAL '24 hours' AND e.event_type = 'auth_failure') AS failures_24h"),
        db.raw("count(DISTINCT e.ip) FILTER (WHERE e.timestamp >= NOW() - INTERVAL '24 hours' AND e.event_type = 'auth_failure') AS ips_24h"),
        db.raw(`count(*) FILTER (WHERE e.timestamp >= NOW() - INTERVAL '48 hours' AND e.timestamp < NOW() - INTERVAL '24 hours'
          AND e.event_type = 'auth_failure') AS failures_prev_24h`),
        db.raw(`count(DISTINCT e.ip) FILTER (WHERE e.timestamp >= NOW() - INTERVAL '48 hours' AND e.timestamp < NOW() - INTERVAL '24 hours'
          AND e.event_type = 'auth_failure') AS ips_prev_24h`),
      )
      .first();

    // Approved devices, with the effective evaluate-only flag (own flag or an
    // evaluate-only ancestor group through the closure table).
    const devicesQ = db('agent_devices as d')
      .where('d.status', 'approved')
      .modify((q) => {
        if (!master) q.where('d.tenant_id', tenantId);
        if (restricted) q.whereIn('d.id', visibleAgentIds);
      })
      .select(
        'd.id',
        'd.uuid',
        db.raw('COALESCE(d.name, d.hostname) AS display_name'),
        'd.agent_version',
        'd.device_type',
        db.raw(`(COALESCE(d.evaluate_only, false) OR EXISTS (
          SELECT 1 FROM group_closure gc JOIN monitor_groups g ON g.id = gc.ancestor_id
          WHERE gc.descendant_id = d.group_id AND g.evaluate_only = true
        )) AS eval_only`),
      );

    const perDeviceEventsQ = eventScope(db('ip_events as e'), tenantId, visibleAgentIds)
      .whereRaw("e.timestamp >= NOW() - INTERVAL '24 hours'")
      .whereNotNull('e.device_id')
      .groupBy('e.device_id')
      .select(
        'e.device_id',
        db.raw('count(*) AS events'),
        db.raw("count(*) FILTER (WHERE e.event_type = 'auth_failure') AS failures"),
      );

    // Bans of the last 24 h covering an IP the device saw in the same window.
    const perDeviceBansQ = banAudience(
      eventScope(
        db('ip_events as e')
          .joinRaw(`JOIN ip_bans AS b ON e.ip <<= ${BAN_NET}`)
          .whereRaw("e.timestamp >= NOW() - INTERVAL '24 hours'")
          .whereRaw("b.banned_at >= NOW() - INTERVAL '24 hours'")
          .whereNotNull('e.device_id'),
        tenantId,
        visibleAgentIds,
      ),
      tenantId,
    ).groupBy('e.device_id').select('e.device_id', db.raw('count(DISTINCT b.id) AS bans'));

    // Top IPs: global aggregates for Default, the tenant's own events otherwise
    // (and for a restricted user: the events of the agents they see).
    const topIpsQ = master && !restricted
      ? db('ip_reputation as r')
          .where('r.total_failures', '>', 0)
          .select(db.raw('host(r.ip) AS ip'), 'r.total_failures AS failures', 'r.geo_country_code', 'r.last_seen')
          .orderByRaw('r.total_failures DESC, r.last_seen DESC NULLS LAST')
          .limit(TOP_IPS)
      : db
          .from(
            eventScope(db('ip_events as e'), tenantId, visibleAgentIds)
              .where('e.event_type', 'auth_failure')
              .groupBy('e.ip')
              .select('e.ip', db.raw('count(*) AS failures'), db.raw('max(e.timestamp) AS last_seen'))
              .orderByRaw('count(*) DESC, max(e.timestamp) DESC')
              .limit(TOP_IPS)
              .as('t'),
          )
          .leftJoin('ip_reputation as r', 'r.ip', 't.ip')
          .select(db.raw('host(t.ip) AS ip'), 't.failures', 'r.geo_country_code', 't.last_seen')
          .orderByRaw('t.failures DESC, t.last_seen DESC');

    const [[activeRow], bansTodayRows, eventTotals, devices, perDeviceEvents, perDeviceBans, topRows, reference] = await Promise.all([
      activeBansQ,
      bansTodayQ as unknown as Promise<Array<{ ban_type: string; count: string }>>,
      eventTotalsQ as unknown as Promise<Record<string, string> | undefined>,
      devicesQ as unknown as Promise<DeviceRow[]>,
      perDeviceEventsQ as unknown as Promise<Array<{ device_id: number; events: string; failures: string }>>,
      perDeviceBansQ as unknown as Promise<Array<{ device_id: number; bans: string }>>,
      topIpsQ as unknown as Promise<Array<{ ip: string; failures: string; geo_country_code: string | null; last_seen: Date | null }>>,
      referenceGauges(tenantId),
    ]);

    const bansToday = { auto: 0, manual: 0 };
    for (const r of bansTodayRows) {
      if (r.ban_type === 'auto' || r.ban_type === 'manual') bansToday[r.ban_type] = Number(r.count);
    }

    // Agent counters: real agents only (MikroTik routers have no WS channel nor version).
    const served = getServedAgentVersion();
    let agentsTotal = 0;
    let agentsConnected = 0;
    let agentsEvaluateOnly = 0;
    let agentsOutdated = 0;
    for (const d of devices) {
      if ((d.device_type ?? 'agent') !== 'agent') continue;
      agentsTotal++;
      if (obliguardHub.isConnected(d.uuid)) agentsConnected++;
      if (d.eval_only) agentsEvaluateOnly++;
      if (served && d.agent_version && isStrictlyNewerAgentVersion(served, d.agent_version)) agentsOutdated++;
    }

    const evByDevice = new Map(perDeviceEvents.map((r) => [Number(r.device_id), r]));
    const bansByDevice = new Map(perDeviceBans.map((r) => [Number(r.device_id), Number(r.bans)]));
    const perAgent: DashboardAgentStats[] = devices
      .map((d) => {
        const ev = evByDevice.get(d.id);
        return {
          deviceId: d.id,
          name: d.display_name,
          events24h: Number(ev?.events ?? 0),
          failures24h: Number(ev?.failures ?? 0),
          bans24h: bansByDevice.get(d.id) ?? 0,
        };
      })
      .sort((a, b) => b.events24h - a.events24h || a.name.localeCompare(b.name) || a.deviceId - b.deviceId)
      .slice(0, MAX_PER_AGENT);

    const topIps: DashboardTopIp[] = topRows.map((r) => ({
      ip: r.ip,
      totalFailures: Number(r.failures),
      geoCountryCode: r.geo_country_code ?? null,
      lastSeen: iso(r.last_seen),
    }));

    const activeBans = Number(activeRow?.count ?? 0);
    const failures24h = Number(eventTotals?.failures_24h ?? 0);
    const uniqueIps24h = Number(eventTotals?.ips_24h ?? 0);
    const deltas: DashboardDeltas = {
      activeBans: reference?.activeBans == null ? null : activeBans - reference.activeBans,
      failures24h: failures24h - Number(eventTotals?.failures_prev_24h ?? 0),
      uniqueIps24h: uniqueIps24h - Number(eventTotals?.ips_prev_24h ?? 0),
      // The snapshots are tenant-wide: no reference for a team-restricted user.
      agentsConnected: restricted || reference?.agentsConnected == null ? null : agentsConnected - reference.agentsConnected,
    };

    return {
      activeBans,
      bansToday,
      eventsToday: Number(eventTotals?.events_today ?? 0),
      failuresToday: Number(eventTotals?.failures_today ?? 0),
      uniqueIpsToday: Number(eventTotals?.ips_today ?? 0),
      failures24h,
      uniqueIps24h,
      agentsTotal,
      agentsConnected,
      agentsEvaluateOnly,
      agentsOutdated,
      topIps,
      perAgent,
      deltas,
    };
  },

  /**
   * GET /api/dashboard/timeseries (daily) and /hourly: the last `count`
   * buckets, oldest first, the current one being a live point (Obliance
   * getFleetTimeseries / getFleetHourlySeries). Past buckets come from the
   * snapshots (a bucket without a snapshot row is left out). For a
   * team-restricted user the snapshots (tenant-wide) are not used: the event
   * flows are computed live over their agents, ban flows stay tenant-wide and
   * the gauges are only known for the current bucket.
   */
  async getSeries(
    tenantId: number,
    kind: SnapshotKind,
    count: number,
    visibleAgentIds: number[] | 'all' = 'all',
  ): Promise<IpsSeriesPoint[]> {
    const span = Math.max(1, count - 1);
    if (Array.isArray(visibleAgentIds)) {
      const [flows, gauges] = await Promise.all([
        computeFlows(tenantId, kind, span, visibleAgentIds),
        computeGauges(tenantId, visibleAgentIds),
      ]);
      const keys = [...flows.keys()];
      return keys.map((k, i) => {
        const f = flows.get(k)!;
        const g = i === keys.length - 1 ? gauges : null;
        return {
          bucket: k, ...f,
          activeBans: g?.activeBans ?? null, agentsTotal: g?.agentsTotal ?? null, agentsConnected: g?.agentsConnected ?? null,
        };
      });
    }

    const keys = await bucketKeys(kind, span);
    const current = keys[keys.length - 1];
    const [rows, live, gauges] = await Promise.all([
      db(SNAPSHOT_TABLE[kind])
        .where('tenant_id', tenantId)
        .where('bucket', '>=', keys[0])
        .where('bucket', '<', current)
        .orderBy('bucket', 'asc')
        .select(
          kind === 'daily' ? db.raw("to_char(bucket, 'YYYY-MM-DD') AS bucket") : 'bucket',
          'events', 'failures', 'unique_ips', 'auto_bans', 'manual_bans',
          'active_bans', 'agents_total', 'agents_connected',
        ) as Promise<SnapshotRow[]>,
      computeFlows(tenantId, kind, 0),
      computeGauges(tenantId),
    ]);
    const points: IpsSeriesPoint[] = rows.map((r) => ({
      bucket: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
      events: r.events,
      failures: r.failures,
      uniqueIps: r.unique_ips,
      autoBans: r.auto_bans,
      manualBans: r.manual_bans,
      activeBans: r.active_bans,
      agentsTotal: r.agents_total,
      agentsConnected: r.agents_connected,
    }));
    const now = live.get(current) ?? { events: 0, failures: 0, uniqueIps: 0, autoBans: 0, manualBans: 0 };
    points.push({ bucket: current, ...now, ...gauges });
    return points;
  },

  /**
   * GET /api/dashboard/breakdown: over the last `hours`, the most attacked
   * services and the attacking countries (auth failures of the tenant's
   * events, team scope applied), and the agents whose IPs got banned.
   */
  async getBreakdown(tenantId: number, hours: number, visibleAgentIds: number[] | 'all' = 'all'): Promise<DashboardBreakdown> {
    const windowSql = 'e.timestamp >= NOW() - make_interval(hours => ?::int)';
    const failures = () => eventScope(db('ip_events as e'), tenantId, visibleAgentIds)
      .where('e.event_type', 'auth_failure')
      .whereRaw(windowSql, [hours]);

    const servicesQ = failures()
      .groupBy('e.service')
      .select(db.raw("COALESCE(e.service, 'unknown') AS key"), db.raw('count(*) AS count'), db.raw('count(DISTINCT e.ip) AS unique_ips'))
      .orderByRaw('count(*) DESC, 1 ASC')
      .limit(BREAKDOWN_TOP);
    // '' = unknown country, reported as '??' (a literal '??' would read as a knex binding).
    const countryKey = "COALESCE(r.geo_country_code, '')";
    const countriesQ = failures()
      .leftJoin('ip_reputation as r', 'r.ip', 'e.ip')
      .groupByRaw(countryKey)
      .select(db.raw(`${countryKey} AS key`), db.raw('count(*) AS count'), db.raw('count(DISTINCT e.ip) AS unique_ips'))
      .orderByRaw('count(*) DESC, 1 ASC')
      .limit(BREAKDOWN_TOP);
    const bansQ = banAudience(
      eventScope(
        db('ip_events as e')
          .joinRaw(`JOIN ip_bans AS b ON e.ip <<= ${BAN_NET}`)
          .join('agent_devices as d', 'd.id', 'e.device_id')
          .whereRaw(windowSql, [hours])
          .whereRaw('b.banned_at >= NOW() - make_interval(hours => ?::int)', [hours]),
        tenantId,
        visibleAgentIds,
      ),
      tenantId,
    )
      .groupBy('d.id', 'd.name', 'd.hostname')
      .select('d.id', db.raw('COALESCE(d.name, d.hostname) AS label'), db.raw('count(DISTINCT b.id) AS count'), db.raw('count(DISTINCT e.ip) AS unique_ips'))
      .orderByRaw('count(DISTINCT b.id) DESC, d.id ASC')
      .limit(BREAKDOWN_TOP);

    type Row = { key: string; count: string; unique_ips: string };
    const [services, countries, bans] = await Promise.all([
      servicesQ as unknown as Promise<Row[]>,
      countriesQ as unknown as Promise<Row[]>,
      bansQ as unknown as Promise<Array<{ id: number; label: string; count: string; unique_ips: string }>>,
    ]);
    const row = (r: Row): DashboardBreakdownRow => ({ key: r.key, label: r.key, count: Number(r.count), uniqueIps: Number(r.unique_ips) });
    return {
      hours,
      topServices: services.map(row),
      topCountries: countries.map((r) => row({ ...r, key: r.key || '??' })),
      bansPerAgent: bans.map((r) => ({
        key: String(r.id), label: r.label, deviceId: Number(r.id), count: Number(r.count), uniqueIps: Number(r.unique_ips),
      })),
    };
  },

  /**
   * GET /api/dashboard/groups (groupsController.stats): per visible group, its
   * own approved agents (MikroTik routers excluded), how many are connected,
   * and the last 24 h of events / failures / bans on them (the summary's
   * per-agent definitions). The agents of no visible group (ungrouped, or in a
   * group the caller cannot see) form a groupId=null row. The Default tenant
   * sees every tenant's groups, tagged with their tenant.
   */
  async getGroupStats(
    tenantId: number,
    visibleGroupIds: number[] | 'all',
    visibleAgentIds: number[] | 'all' = 'all',
  ): Promise<DashboardGroupStats[]> {
    const master = isMasterTenant(tenantId);
    const groups = await db('monitor_groups as g')
      .leftJoin('tenants as t', 't.id', 'g.tenant_id')
      .modify((q) => {
        if (!master) q.where('g.tenant_id', tenantId);
        if (Array.isArray(visibleGroupIds)) q.whereIn('g.id', visibleGroupIds);
      })
      .select(
        'g.id', 'g.name', 'g.parent_id', 'g.sort_order', 'g.tenant_id', 't.name as tenant_name',
        db.raw(`EXISTS (
          SELECT 1 FROM group_closure gc JOIN monitor_groups a ON a.id = gc.ancestor_id
          WHERE gc.descendant_id = g.id AND a.evaluate_only = true
        ) AS eval_only`),
      )
      .orderBy([{ column: 'g.sort_order' }, { column: 'g.name' }]) as Array<{
        id: number; name: string; parent_id: number | null; sort_order: number | null;
        tenant_id: number | null; tenant_name: string | null; eval_only: boolean;
      }>;
    const groupIds = groups.map((g) => g.id);
    // Group of a device as shown here: its group when visible, else the null row.
    const shownGroup = `CASE WHEN d.group_id = ANY(?::int[]) THEN d.group_id END`;

    const devicesQ = db('agent_devices as d')
      .where('d.status', 'approved')
      .whereRaw("COALESCE(d.device_type, 'agent') = 'agent'")
      .modify((q) => {
        if (!master) q.where('d.tenant_id', tenantId);
        if (Array.isArray(visibleAgentIds)) q.whereIn('d.id', visibleAgentIds);
      })
      .select('d.id', 'd.uuid', db.raw(`${shownGroup} AS group_id`, [groupIds]));
    const agentEvents = (q: Knex.QueryBuilder) => eventScope(q, tenantId, visibleAgentIds)
      .join('agent_devices as d', 'd.id', 'e.device_id')
      .where('d.status', 'approved')
      .whereRaw("COALESCE(d.device_type, 'agent') = 'agent'")
      .whereRaw("e.timestamp >= NOW() - INTERVAL '24 hours'");
    const eventsQ = agentEvents(db('ip_events as e'))
      .groupByRaw('1') // the shown group (first select column)
      .select(
        db.raw(`${shownGroup} AS group_id`, [groupIds]),
        db.raw('count(*) AS events'),
        db.raw("count(*) FILTER (WHERE e.event_type = 'auth_failure') AS failures"),
      );
    const bansQ = banAudience(
      agentEvents(db('ip_events as e').joinRaw(`JOIN ip_bans AS b ON e.ip <<= ${BAN_NET}`))
        .whereRaw("b.banned_at >= NOW() - INTERVAL '24 hours'"),
      tenantId,
    )
      .groupByRaw('1') // the shown group (first select column)
      .select(db.raw(`${shownGroup} AS group_id`, [groupIds]), db.raw('count(DISTINCT b.id) AS bans'));

    const [devices, events, bans] = await Promise.all([
      devicesQ as unknown as Promise<Array<{ id: number; uuid: string; group_id: number | null }>>,
      eventsQ as unknown as Promise<Array<{ group_id: number | null; events: string; failures: string }>>,
      bansQ as unknown as Promise<Array<{ group_id: number | null; bans: string }>>,
    ]);

    const key = (id: number | null) => (id == null ? 'none' : String(id));
    const agents = new Map<string, { agents: number; connected: number }>();
    for (const d of devices) {
      const k = key(d.group_id);
      const a = agents.get(k) ?? { agents: 0, connected: 0 };
      a.agents++;
      if (obliguardHub.isConnected(d.uuid)) a.connected++;
      agents.set(k, a);
    }
    const ev = new Map(events.map((r) => [key(r.group_id), r]));
    const bn = new Map(bans.map((r) => [key(r.group_id), Number(r.bans)]));
    const stats = (k: string) => ({
      agents: agents.get(k)?.agents ?? 0,
      connected: agents.get(k)?.connected ?? 0,
      events24h: Number(ev.get(k)?.events ?? 0),
      failures24h: Number(ev.get(k)?.failures ?? 0),
      bans24h: bn.get(k) ?? 0,
    });

    const out: DashboardGroupStats[] = groups.map((g) => ({
      groupId: g.id,
      groupName: g.name,
      // A parent the caller cannot see makes the group a root.
      parentId: g.parent_id != null && groupIds.includes(g.parent_id) ? g.parent_id : null,
      sortOrder: g.sort_order ?? 0,
      tenantId: master ? g.tenant_id : null,
      tenantName: master ? g.tenant_name : null,
      evaluateOnly: !!g.eval_only,
      ...stats(key(g.id)),
    }));
    const loose = stats('none');
    if (loose.agents > 0) {
      out.push({
        groupId: null, groupName: null, parentId: null, sortOrder: Number.MAX_SAFE_INTEGER,
        tenantId: null, tenantName: null, evaluateOnly: false, ...loose,
      });
    }
    return out;
  },
};
