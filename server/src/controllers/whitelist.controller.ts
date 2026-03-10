import type { Request, Response, NextFunction } from 'express';
import { whitelistService } from '../services/whitelist.service';
import { AppError } from '../middleware/errorHandler';
import type { IpWhitelist, WhitelistScope } from '@obliview/shared';

export interface CreateWhitelistRequest {
  ip: string;
  label?: string | null;
  scope?: 'global' | 'tenant' | 'group' | 'agent';
  scopeId?: number | null;
}

export async function listWhitelist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const scopeParam = req.query.scope as string | undefined;
    const scopeId = req.query.scopeId !== undefined && req.query.scopeId !== ''
      ? parseInt(req.query.scopeId as string, 10)
      : null;
    const isAdmin = req.session?.role === 'admin';

    let entries: IpWhitelist[];
    if (!scopeParam || scopeParam === 'all') {
      entries = await whitelistService.listAll(req.tenantId, isAdmin);
    } else {
      entries = await whitelistService.listByScope(scopeParam as WhitelistScope, scopeId, req.tenantId, isAdmin);
    }

    res.json({ success: true, data: entries });
  } catch (err) {
    next(err);
  }
}

export async function createWhitelistEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body as CreateWhitelistRequest;

    if (!body.ip) {
      throw new AppError(400, 'ip is required');
    }

    const entry = await whitelistService.create(body, req.session?.userId ?? 0, req.tenantId);

    res.status(201).json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
}

export async function deleteWhitelistEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      throw new AppError(400, 'Invalid whitelist entry ID');
    }

    const isAdmin = req.session?.role === 'admin';
    await whitelistService.delete(id, req.tenantId, isAdmin);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
