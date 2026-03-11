import type { Request, Response, NextFunction } from 'express';
import { ipReputationService } from '../services/ipReputation.service';
import { AppError } from '../middleware/errorHandler';

export async function listReputation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const status  = req.query.status as import('@obliview/shared').IpStatus | undefined;
    const search  = req.query.search as string | undefined;
    const limit   = req.query.limit  !== undefined ? parseInt(req.query.limit  as string, 10) : 50;
    const offset  = req.query.offset !== undefined ? parseInt(req.query.offset as string, 10) : 0;
    const isAdmin = req.session?.role === 'admin';

    const result = await ipReputationService.list({ status, search, limit, offset, tenantId: req.tenantId, isAdmin });
    res.json({ success: true, data: result.data, total: result.total });
  } catch (err) {
    next(err);
  }
}

export async function getIpDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ip } = req.params;
    if (!ip) throw new AppError(400, 'IP address is required');

    const isAdmin = req.session?.role === 'admin';
    const result  = await ipReputationService.getIpDetail(ip, req.tenantId, isAdmin);
    if (!result) throw new AppError(404, 'IP not found in reputation database');

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/ip-reputation/:ip/clear
 *
 * Clears the "suspicious" flag for an IP.
 *
 * - Tenant admin: creates a per-tenant baseline snapshot.
 *   The IP becomes suspicious again only when NEW failures arrive after the clear.
 * - Global admin: resets total_failures = 0 for everyone (nuclear option).
 */
export async function clearSuspicious(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ip      = decodeURIComponent(req.params.ip);
    const isAdmin = req.session?.role === 'admin';
    const userId  = req.session?.userId ?? 0;

    if (!ip) throw new AppError(400, 'IP address is required');

    if (isAdmin) {
      await ipReputationService.clearGlobal(ip);
      res.json({ success: true, message: `${ip} reputation cleared globally` });
    } else {
      if (!req.tenantId) throw new AppError(403, 'No tenant context');
      await ipReputationService.clearForTenant(ip, req.tenantId, userId);
      res.json({ success: true, message: `${ip} marked as cleared for your tenant` });
    }
  } catch (err) {
    next(err);
  }
}
