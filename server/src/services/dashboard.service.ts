/**
 * Dashboard summary (GET /api/dashboard/summary), mirroring Obliance's
 * deviceService.getFleetSummary: every number is computed server-side and
 * tenant-scoped, the Default tenant (master) aggregating the whole install.
 *
 * Bans: a non-Default tenant counts its own bans plus the global ones, since
 * global bans are enforced on its agents, minus the global bans it excluded
 * (ip_ban_exclusions). IP figures come from the tenant's own ip_events; the
 * Default tenant reads the global ip_reputation aggregates.
 */
import type { Knex } from 'knex';
import { db } from '../db';
import { isMasterTenant } from '@obliview/shared';
import type { DashboardSummary, DashboardAgentStats, DashboardTopIp } from '@obliview/shared';
import { obliguardHub } from './obliguardHub.service';
import { getServedAgentVersion } from './agent.service';
import { isStrictlyNewerAgentVersion } from '../utils/agentUpdate';

const TOP_IPS = 5;
/** Upper bound of the per-agent table (busiest first). */
const MAX_PER_AGENT = 1000;

/** The ban's network: ip carries the address, cidr_prefix the mask (null = host). */
const BAN_NET = 'set_masklen(b.ip, COALESCE(b.cidr_prefix, masklen(b.ip)))';

/** Bans that apply to the tenant: all for Default; else own + non-excluded global. */
function banAudience(q: Knex.QueryBuilder, tenantId: number): Knex.QueryBuilder {
  if (isMasterTenant(tenantId)) return q;
  return q.where((w) => {
    w.where('b.tenant_id', tenantId).orWhere((g) => {
      g.where('b.scope', 'global').whereNotExists(
        db('ip_ban_exclusions as bex').whereRaw('bex.ban_id = b.id').where('bex.tenant_id', tenantId).select(db.raw('1')),
      );
    });
  });
}

function eventScope(q: Knex.QueryBuilder, tenantId: number): Knex.QueryBuilder {
  return isMasterTenant(tenantId) ? q : q.where('e.tenant_id', tenantId);
}

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
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
  async getSummary(tenantId: number): Promise<DashboardSummary> {
    const master = isMasterTenant(tenantId);

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

    // One pass over the last day: today and rolling-24h figures.
    const eventTotalsQ = eventScope(db('ip_events as e'), tenantId)
      .whereRaw("e.timestamp >= LEAST(CURRENT_DATE::timestamptz, NOW() - INTERVAL '24 hours')")
      .select(
        db.raw('count(*) FILTER (WHERE e.timestamp >= CURRENT_DATE) AS events_today'),
        db.raw("count(*) FILTER (WHERE e.timestamp >= CURRENT_DATE AND e.event_type = 'auth_failure') AS failures_today"),
        db.raw("count(DISTINCT e.ip) FILTER (WHERE e.timestamp >= CURRENT_DATE AND e.event_type = 'auth_failure') AS ips_today"),
        db.raw("count(*) FILTER (WHERE e.timestamp >= NOW() - INTERVAL '24 hours' AND e.event_type = 'auth_failure') AS failures_24h"),
        db.raw("count(DISTINCT e.ip) FILTER (WHERE e.timestamp >= NOW() - INTERVAL '24 hours' AND e.event_type = 'auth_failure') AS ips_24h"),
      )
      .first();

    // Approved devices, with the effective evaluate-only flag (own flag or an
    // evaluate-only ancestor group through the closure table).
    const devicesQ = db('agent_devices as d')
      .where('d.status', 'approved')
      .modify((q) => { if (!master) q.where('d.tenant_id', tenantId); })
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

    const perDeviceEventsQ = eventScope(db('ip_events as e'), tenantId)
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
      ),
      tenantId,
    ).groupBy('e.device_id').select('e.device_id', db.raw('count(DISTINCT b.id) AS bans'));

    // Top IPs: global aggregates for Default, the tenant's own events otherwise.
    const topIpsQ = master
      ? db('ip_reputation as r')
          .where('r.total_failures', '>', 0)
          .select(db.raw('host(r.ip) AS ip'), 'r.total_failures AS failures', 'r.geo_country_code', 'r.last_seen')
          .orderByRaw('r.total_failures DESC, r.last_seen DESC NULLS LAST')
          .limit(TOP_IPS)
      : db
          .from(
            db('ip_events as e')
              .where('e.tenant_id', tenantId)
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

    const [[activeRow], bansTodayRows, eventTotals, devices, perDeviceEvents, perDeviceBans, topRows] = await Promise.all([
      activeBansQ,
      bansTodayQ as unknown as Promise<Array<{ ban_type: string; count: string }>>,
      eventTotalsQ as unknown as Promise<Record<string, string> | undefined>,
      devicesQ as unknown as Promise<DeviceRow[]>,
      perDeviceEventsQ as unknown as Promise<Array<{ device_id: number; events: string; failures: string }>>,
      perDeviceBansQ as unknown as Promise<Array<{ device_id: number; bans: string }>>,
      topIpsQ as unknown as Promise<Array<{ ip: string; failures: string; geo_country_code: string | null; last_seen: Date | null }>>,
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

    return {
      activeBans: Number(activeRow?.count ?? 0),
      bansToday,
      eventsToday: Number(eventTotals?.events_today ?? 0),
      failuresToday: Number(eventTotals?.failures_today ?? 0),
      uniqueIpsToday: Number(eventTotals?.ips_today ?? 0),
      failures24h: Number(eventTotals?.failures_24h ?? 0),
      uniqueIps24h: Number(eventTotals?.ips_24h ?? 0),
      agentsTotal,
      agentsConnected,
      agentsEvaluateOnly,
      agentsOutdated,
      topIps,
      perAgent,
    };
  },
};
