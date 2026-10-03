import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import type { IpEventStats } from '@obliview/shared';
import {
  parsePaging,
  parseLimitOffset,
  parseSort,
  queryString,
  queryDate,
  parseIpSearch,
  ipSearchSql,
} from '../utils/pagination';
import { parseIpOrCidr } from '../utils/ipValidation';
import { requestVisibleAgentIds } from '../services/agentScope.service';
import { resolveReadTenants, whereReadTenants } from '../middleware/tenant';
import { auditService } from '../services/audit.service';
import { CSV_EXPORT_MAX, csvDate, csvFilename, csvMaskers, sendCsv, wantsAnon } from '../utils/csv';

/** Largest page of ip_events a single request may pull. */
const MAX_EVENTS_PAGE = 500;
/** The total is counted over at most this many rows (DATA-REALTIME-14). */
const COUNT_CAP = 10_000;

const EVENT_COLUMNS = [
  'e.id',
  'e.device_id',
  'e.ip',
  'e.username',
  'e.service',
  'e.event_type',
  'e.timestamp',
  'e.raw_log',
  'e.track_only',
  'e.tenant_id',
  'e.created_at',
  'e.source_agent_id',
  'e.source_ip_type',
  'd.hostname',
  // Tenant attribution (W10-5): the client resolves it with TenantBadge.
  'tn.name as tenant_name',
] as const;

/** The joins EVENT_COLUMNS reads (agent hostname, tenant name). */
function joinEventColumns(qb: ReturnType<typeof db>): ReturnType<typeof db> {
  return qb
    .leftJoin('agent_devices as d', 'e.device_id', 'd.id')
    .leftJoin('tenants as tn', 'e.tenant_id', 'tn.id');
}

/** sortBy key → SQL column (whitelist; never the raw query value). */
const EVENT_SORT = {
  timestamp: 'e.timestamp',
  ip: 'e.ip',
  service: 'e.service',
  eventType: 'e.event_type',
} as const;
type EventSortKey = keyof typeof EVENT_SORT;
const EVENT_SORT_KEYS = Object.keys(EVENT_SORT) as EventSortKey[];

/** A keyset cursor: a positive ip_events id (bigint, kept as a digit string). */
const CURSOR_RE = /^[1-9][0-9]{0,17}$/;

/**
 * Team scope (RBAC-8) of an ip_events query: a user restricted by team
 * grants only reads the events of the agents they are granted (`allowed`
 * from requestVisibleAgentIds). Synchronous on purpose: a query builder is a
 * thenable, so returning it from an async function would run it.
 */
function scopeToAgents(qb: ReturnType<typeof db>, allowed: number[] | 'all'): void {
  if (allowed !== 'all') qb.whereIn('e.device_id', allowed);
}

/**
 * The filtered, tenant + team scoped ip_events base of listEvents and
 * exportEvents (query string: ip, service, eventType, deviceId, from, to,
 * tenants). Throws a 400 AppError on an invalid filter.
 */
async function filteredEvents(req: Request): Promise<{ base: ReturnType<typeof db>; filters: Record<string, string | number> }> {
  const q = req.query as Record<string, unknown>;
  const ip = queryString(q.ip, 64);
  const service = queryString(q.service, 50);
  const eventType = queryString(q.eventType, 20);
  const deviceRaw = queryString(q.deviceId, 12);
  const from = queryDate(q.from);
  const to = queryDate(q.to);

  if (from === null) throw new AppError(400, 'Invalid "from" date');
  if (to === null) throw new AppError(400, 'Invalid "to" date');
  let deviceId: number | undefined;
  if (deviceRaw !== undefined) {
    if (!/^[0-9]{1,10}$/.test(deviceRaw)) throw new AppError(400, 'Invalid deviceId');
    deviceId = Number(deviceRaw);
  }

  const base = db('ip_events as e');
  whereReadTenants(base, 'e.tenant_id', resolveReadTenants(req));
  scopeToAgents(base, await requestVisibleAgentIds(req, 'read'));
  if (ip) {
    const s = ipSearchSql('e.ip', parseIpSearch(ip));
    base.whereRaw(s.sql, s.bindings);
  }
  // Exact value (the client offers the known services in a select).
  if (service) base.where('e.service', service);
  if (eventType) base.where('e.event_type', eventType);
  if (deviceId !== undefined) base.where('e.device_id', deviceId);
  if (from) base.where('e.timestamp', '>=', from);
  if (to) base.where('e.timestamp', '<=', to);

  const filters: Record<string, string | number> = {};
  if (ip) filters.ip = ip;
  if (service) filters.service = service;
  if (eventType) filters.eventType = eventType;
  if (deviceId !== undefined) filters.deviceId = deviceId;
  if (from) filters.from = from.toISOString();
  if (to) filters.to = to.toISOString();
  return { base, filters };
}

/**
 * GET /api/ip-events — the event log, tenant + team scoped: the Default tenant
 * sees every tenant (narrowed by `?tenants=1,2`), any other tenant itself
 * only, whatever the platform role (resolveReadTenants). Every row carries
 * tenant_id + tenant_name. Filters: ip (address, CIDR or prefix), service,
 * eventType, deviceId, from, to.
 *
 * Two pagination modes:
 *   - page mode (default): page/pageSize + sortBy/sortOrder, with a total
 *     counted over at most COUNT_CAP rows (totalCapped);
 *   - keyset mode (?before=<id>, or ?keyset=1 for the newest page): newest
 *     first by id, no count; limit+1 rows tell hasMore, and nextBefore is the
 *     cursor of the next (older) page. The live stream (ip:events) carries
 *     the same ids, so a client merges both by id.
 */
export async function listEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const beforeRaw = queryString(q.before, 20);
    const keysetRaw = queryString(q.keyset, 5);
    if (beforeRaw !== undefined && !CURSOR_RE.test(beforeRaw)) throw new AppError(400, 'Invalid "before" cursor');
    const keyset = beforeRaw !== undefined || keysetRaw === '1' || keysetRaw === 'true';

    const { page, pageSize, offset } = parsePaging(q, { defaultSize: 50, max: MAX_EVENTS_PAGE });
    const { sortBy, sortOrder } = parseSort(q, EVENT_SORT_KEYS, { sortBy: 'timestamp', sortOrder: 'desc' });

    // One filtered base, cloned for the page and for the capped count.
    const { base } = await filteredEvents(req);

    if (keyset) {
      // Page size: ?limit= (keyset idiom) or ?pageSize=.
      const size = q.limit !== undefined
        ? parseLimitOffset(q, { defaultLimit: pageSize, max: MAX_EVENTS_PAGE }).limit
        : pageSize;
      const rows = await base.clone()
        .modify((qb) => { if (beforeRaw !== undefined) qb.where('e.id', '<', beforeRaw); })
        .modify(joinEventColumns)
        .select(...EVENT_COLUMNS)
        .orderBy('e.id', 'desc')
        .limit(size + 1) as Array<{ id: number | string }>;
      const hasMore = rows.length > size;
      const data = hasMore ? rows.slice(0, size) : rows;
      const last = data[data.length - 1];
      res.json({
        success: true,
        data,
        hasMore,
        nextBefore: hasMore && last ? String(last.id) : null,
        pageSize: size,
      });
      return;
    }

    const pageQuery = base.clone()
      .modify(joinEventColumns)
      .select(...EVENT_COLUMNS)
      .orderByRaw(`${EVENT_SORT[sortBy]} ${sortOrder}, e.id ${sortOrder}`)
      .limit(pageSize)
      .offset(offset);

    // count(*) over a LIMIT COUNT_CAP+1 subquery: the scan stops early on big tables.
    const capped = base.clone().select(db.raw('1')).limit(COUNT_CAP + 1).as('capped');
    const countQuery = db.from(capped).count<Array<{ count: string }>>({ count: '*' }).first();

    const [rows, countResult] = await Promise.all([pageQuery, countQuery]);

    const counted = Number((countResult as { count?: string } | undefined)?.count ?? 0);
    const totalCapped = counted > COUNT_CAP;
    const total = totalCapped ? COUNT_CAP : counted;

    res.json({ success: true, data: rows, total, totalCapped, page, pageSize });
  } catch (err) {
    next(err);
  }
}

interface EventExportRow {
  id: number | string;
  timestamp: Date | string;
  ip: string;
  username: string | null;
  service: string;
  event_type: string;
  hostname: string | null;
  device_id: number | null;
  track_only: boolean | null;
  tenant_name: string | null;
  raw_log: string | null;
}

/**
 * GET /api/ip-events/export — the event log as CSV: same filters, tenant
 * (god view) and team scope as listEvents, sorted like page mode
 * (sortBy/sortOrder), at most CSV_EXPORT_MAX rows (X-Truncated when capped).
 * `?anon=1` masks addresses, usernames, hostnames and raw logs.
 */
export async function exportEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const { base, filters } = await filteredEvents(req);
    const { sortBy, sortOrder } = parseSort(q, EVENT_SORT_KEYS, { sortBy: 'timestamp', sortOrder: 'desc' });
    const anon = wantsAnon(q);
    const mask = csvMaskers(anon);

    const rows = await base
      .modify(joinEventColumns)
      .select('e.id', 'e.timestamp', 'e.ip', 'e.username', 'e.service', 'e.event_type', 'e.device_id',
        'e.track_only', 'e.raw_log', 'd.hostname', 'tn.name as tenant_name')
      .orderByRaw(`${EVENT_SORT[sortBy]} ${sortOrder}, e.id ${sortOrder}`)
      .limit(CSV_EXPORT_MAX + 1) as EventExportRow[];
    const truncated = rows.length > CSV_EXPORT_MAX;
    const data = truncated ? rows.slice(0, CSV_EXPORT_MAX) : rows;

    await auditService.logReq(req, {
      // Filed in the operating tenant (no deviceId): the filter may name any id.
      action: 'ip_events.exported', targetType: 'ip_event',
      details: { rows: data.length, truncated, anon, filters },
    });
    sendCsv(res, {
      filename: csvFilename('events'),
      headers: ['Timestamp', 'IP', 'Username', 'Service', 'Event type', 'Agent', 'Agent ID', 'Track only', 'Tenant', 'Raw log'],
      rows: data.map((r) => [
        csvDate(r.timestamp),
        mask.ip(String(r.ip)),
        mask.username(r.username),
        r.service,
        r.event_type,
        mask.hostname(r.hostname),
        r.device_id,
        r.track_only === true,
        r.tenant_name,
        mask.log(r.raw_log),
      ]),
      truncated,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ip-events/stats — event counters for the dashboard, tenant + team
 * scoped (resolveReadTenants: the Default tenant sees every tenant, narrowed
 * by `?tenants=`). byDevice covers the last 24 hours.
 */
export async function getEventStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenants = resolveReadTenants(req);
    const allowed = await requestVisibleAgentIds(req, 'read');
    const scoped = <T extends ReturnType<typeof db>>(qb: T): T => {
      whereReadTenants(qb, 'e.tenant_id', tenants);
      scopeToAgents(qb, allowed);
      return qb;
    };

    const [totals, byDeviceRows] = await Promise.all([
      scoped(db('ip_events as e'))
        .whereRaw("e.timestamp >= LEAST(CURRENT_DATE::timestamptz, NOW() - INTERVAL '24 hours')")
        .select(
          db.raw('count(*) FILTER (WHERE e.timestamp >= CURRENT_DATE) AS today'),
          db.raw("count(*) FILTER (WHERE e.timestamp >= NOW() - INTERVAL '24 hours') AS last24h"),
        )
        .first() as Promise<{ today: string; last24h: string } | undefined>,
      scoped(db('ip_events as e'))
        .whereRaw("e.timestamp >= NOW() - INTERVAL '24 hours'")
        .whereNotNull('e.device_id')
        .groupBy('e.device_id')
        .select('e.device_id', db.raw('count(*) AS count'))
        .orderBy('count', 'desc') as Promise<Array<{ device_id: number; count: string }>>,
    ]);

    const data: IpEventStats = {
      today: Number(totals?.today ?? 0),
      last24h: Number(totals?.last24h ?? 0),
      byDevice: byDeviceRows.map((r) => ({ deviceId: Number(r.device_id), count: Number(r.count) })),
    };
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/** GET /api/ip-events/:ip — the latest events of one address, same scope as listEvents. */
export async function getEventsByIp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ip } = req.params;

    if (!ip) {
      throw new AppError(400, 'IP address is required');
    }
    // Validated and canonical, so the ::inet cast below can never throw.
    if (!parseIpOrCidr(ip)) throw new AppError(400, 'Invalid IP address');
    const search = parseIpSearch(ip);
    const cond = ipSearchSql('e.ip', search);

    const q = joinEventColumns(db('ip_events as e')).select(...EVENT_COLUMNS);
    whereReadTenants(q, 'e.tenant_id', resolveReadTenants(req));
    scopeToAgents(q, await requestVisibleAgentIds(req, 'read'));

    // inet comparison (e.ip::text would render '1.2.3.4/32' and never match).
    const rows = await q
      .whereRaw(cond.sql, cond.bindings)
      .orderBy('e.timestamp', 'desc')
      .limit(200);

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
}
