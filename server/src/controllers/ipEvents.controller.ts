import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { isMasterTenant } from '@obliview/shared';

export async function listEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const {
      ip,
      service,
      eventType,
      deviceId,
      from,
      to,
    } = req.query as Record<string, string | undefined>;

    const page = req.query.page !== undefined ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.pageSize !== undefined ? parseInt(req.query.pageSize as string, 10) : 50;

    const offset = (page - 1) * pageSize;

    const tenantId = req.tenantId;

    let query = db('ip_events as e')
      .leftJoin('agent_devices as d', 'e.device_id', 'd.id')
      .select(
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
      );

    let countQuery = db('ip_events as e');

    if (!isMasterTenant(tenantId)) {
      query = query.where('e.tenant_id', tenantId);
      countQuery = countQuery.where('e.tenant_id', tenantId);
    }

    if (ip) {
      query = query.whereRaw('e.ip::text ILIKE ?', [`%${ip}%`]);
      countQuery = countQuery.whereRaw('ip::text ILIKE ?', [`%${ip}%`]);
    }

    if (service) {
      query = query.where('e.service', service);
      countQuery = countQuery.where('service', service);
    }

    if (eventType) {
      query = query.where('e.event_type', eventType);
      countQuery = countQuery.where('event_type', eventType);
    }

    if (deviceId) {
      const devId = parseInt(deviceId, 10);
      if (!isNaN(devId)) {
        query = query.where('e.device_id', devId);
        countQuery = countQuery.where('device_id', devId);
      }
    }

    if (from) {
      query = query.where('e.timestamp', '>=', new Date(from));
      countQuery = countQuery.where('timestamp', '>=', new Date(from));
    }

    if (to) {
      query = query.where('e.timestamp', '<=', new Date(to));
      countQuery = countQuery.where('timestamp', '<=', new Date(to));
    }

    const [rows, countResult] = await Promise.all([
      query.orderBy('e.timestamp', 'desc').limit(pageSize).offset(offset),
      countQuery.count<{ count: string }[]>('e.id as count').first(),
    ]);

    const total = countResult ? parseInt(countResult.count as unknown as string, 10) : 0;

    res.json({ success: true, data: rows, total, page, pageSize });
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

    const tenantId = req.tenantId;

    let q = db('ip_events as e')
      .leftJoin('agent_devices as d', 'e.device_id', 'd.id')
      .select(
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
      );

    if (!isMasterTenant(tenantId)) q = q.where('e.tenant_id', tenantId);

    const rows = await q
      .whereRaw('e.ip::text = ?', [ip])
      .orderBy('e.timestamp', 'desc')
      .limit(200);

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
}
