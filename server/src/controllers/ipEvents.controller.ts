import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { isMasterTenant } from '@obliview/shared';
import type { IpEventStats } from '@obliview/shared';
import {
  parsePaging,
  parseSort,
  queryString,
  queryDate,
  parseIpSearch,
  ipSearchSql,
} from '../utils/pagination';
import { parseIpOrCidr } from '../utils/ipValidation';

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
] as const;

/** sortBy key → SQL column (whitelist; never the raw query value). */
const EVENT_SORT = {
  timestamp: 'e.timestamp',
  ip: 'e.ip',
  service: 'e.service',
  eventType: 'e.event_type',
} as const;
type EventSortKey = keyof typeof EVENT_SORT;
const EVENT_SORT_KEYS = Object.keys(EVENT_SORT) as EventSortKey[];

export async function listEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
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

    const { page, pageSize, offset } = parsePaging(q, { defaultSize: 50, max: MAX_EVENTS_PAGE });
    const { sortBy, sortOrder } = parseSort(q, EVENT_SORT_KEYS, { sortBy: 'timestamp', sortOrder: 'desc' });

    const tenantId = req.tenantId;

    // One filtered base, cloned for the page and for the capped count.
    const base = db('ip_events as e');
    if (!isMasterTenant(tenantId)) base.where('e.tenant_id', tenantId);
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

    const pageQuery = base.clone()
      .leftJoin('agent_devices as d', 'e.device_id', 'd.id')
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

/**
 * GET /api/ip-events/stats — event counters for the dashboard, tenant-scoped
 * (the Default tenant sees every tenant). byDevice covers the last 24 hours.
 */
export async function getEventStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.tenantId;
    const scoped = <T extends ReturnType<typeof db>>(qb: T): T => {
      if (!isMasterTenant(tenantId)) qb.where('e.tenant_id', tenantId);
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

    const tenantId = req.tenantId;

    let q = db('ip_events as e')
      .leftJoin('agent_devices as d', 'e.device_id', 'd.id')
      .select(...EVENT_COLUMNS);

    if (!isMasterTenant(tenantId)) q = q.where('e.tenant_id', tenantId);

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
