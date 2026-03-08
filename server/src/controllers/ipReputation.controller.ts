import type { Request, Response, NextFunction } from 'express';
import { ipReputationService } from '../services/ipReputation.service';
import { AppError } from '../middleware/errorHandler';

export async function listReputation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const status = req.query.status as import('@obliview/shared').IpStatus | undefined;
    const search = req.query.search as string | undefined;
    const limit = req.query.limit !== undefined ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset !== undefined ? parseInt(req.query.offset as string, 10) : 0;

    const result = await ipReputationService.list({ status, search, limit, offset, tenantId: req.tenantId });
    res.json({ success: true, data: result.data, total: result.total });
  } catch (err) {
    next(err);
  }
}

export async function getIpDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ip } = req.params;

    if (!ip) {
      throw new AppError(400, 'IP address is required');
    }

    const result = await ipReputationService.getIpDetail(ip, req.tenantId);
    if (!result) {
      throw new AppError(404, 'IP not found in reputation database');
    }

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
