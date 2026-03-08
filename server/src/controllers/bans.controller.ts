import type { Request, Response, NextFunction } from 'express';
import { banService } from '../services/ban.service';
import { AppError } from '../middleware/errorHandler';

export interface CreateBanRequest {
  ip: string;
  cidrPrefix?: number | null;
  reason?: string | null;
  banType?: 'auto' | 'manual';
  scope?: 'global' | 'tenant' | 'group' | 'agent';
  scopeId?: number | null;
  expiresAt?: string | null;
}

export async function listBans(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const active = req.query.active !== undefined
      ? req.query.active === 'true'
      : undefined;
    const search = req.query.search as string | undefined;
    const page = req.query.page !== undefined ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.pageSize !== undefined ? parseInt(req.query.pageSize as string, 10) : 25;

    const result = await banService.list({ active, search, page, pageSize, tenantId: req.tenantId });
    res.json({ success: true, data: result.data, total: result.total });
  } catch (err) {
    next(err);
  }
}

export async function createBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body as CreateBanRequest;

    if (!body.ip) {
      throw new AppError(400, 'ip is required');
    }

    const ban = await banService.create({
      ...body,
      tenantId: req.tenantId,
      bannedByUserId: req.session?.userId,
    });

    res.status(201).json({ success: true, data: ban });
  } catch (err) {
    next(err);
  }
}

export async function liftBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      throw new AppError(400, 'Invalid ban ID');
    }

    const ok = await banService.lift(id);
    if (!ok) {
      throw new AppError(404, 'Ban not found');
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function promoteBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      throw new AppError(400, 'Invalid ban ID');
    }

    const ban = await banService.promoteToGlobal(id);
    if (!ban) {
      throw new AppError(404, 'Ban not found');
    }

    res.json({ success: true, data: ban });
  } catch (err) {
    next(err);
  }
}
