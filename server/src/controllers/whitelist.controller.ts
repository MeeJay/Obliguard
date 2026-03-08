import type { Request, Response, NextFunction } from 'express';
import { whitelistService } from '../services/whitelist.service';
import { AppError } from '../middleware/errorHandler';

export interface CreateWhitelistRequest {
  ip: string;
  label?: string | null;
  scope?: 'global' | 'tenant' | 'group' | 'agent';
  scopeId?: number | null;
}

export async function listWhitelist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const scope = req.query.scope as string | undefined;
    const scopeId = req.query.scopeId !== undefined
      ? parseInt(req.query.scopeId as string, 10)
      : undefined;

    const entries = await whitelistService.list({ scope, scopeId, tenantId: req.tenantId });
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

    const entry = await whitelistService.create({
      ...body,
      tenantId: req.tenantId,
      createdBy: req.session?.userId,
    });

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

    const ok = await whitelistService.delete(id);
    if (!ok) {
      throw new AppError(404, 'Whitelist entry not found');
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
