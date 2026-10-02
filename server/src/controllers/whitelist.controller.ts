import type { Request, Response, NextFunction } from 'express';
import { whitelistService } from '../services/whitelist.service';
import { AppError } from '../middleware/errorHandler';
import type { WhitelistScope } from '@obliview/shared';
import { parsePaging } from '../utils/pagination';

export interface CreateWhitelistRequest {
  ip: string;
  label?: string | null;
  scope?: 'global' | 'tenant' | 'group' | 'agent';
  scopeId?: number | null;
}

export async function listWhitelist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const scopeParam = typeof query.scope === 'string' && query.scope !== '' ? query.scope : undefined;
    let scopeId: number | null = null;
    if (typeof query.scopeId === 'string' && query.scopeId !== '') {
      scopeId = Number(query.scopeId);
      if (!Number.isSafeInteger(scopeId) || scopeId <= 0) throw new AppError(400, 'Invalid scopeId');
    }
    let ip: string | undefined;
    if (query.ip !== undefined) {
      if (typeof query.ip !== 'string' || query.ip.length > 64) throw new AppError(400, 'Invalid ip filter');
      ip = query.ip;
    }
    // Callers that never page get the whole (capped) list in one response.
    const { page, pageSize, offset } = parsePaging(query, { defaultSize: 1000, max: 1000 });

    // Visibility follows the operating tenant (Default = god view); the
    // platform role grants nothing extra (W1-2).
    const result = await whitelistService.list({
      tenantId: req.tenantId,
      scope: scopeParam as WhitelistScope | 'all' | undefined,
      scopeId,
      ip,
      limit: pageSize,
      offset,
    });

    // Per-entry delete right for the operating tenant (A5). A4 must keep this call.
    const entries = await whitelistService.annotateDeletable(result.data, req.tenantId);

    res.json({ success: true, data: entries, total: result.total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

export async function createWhitelistEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as CreateWhitelistRequest;

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

    // Follows the operating tenant; the platform role grants nothing extra (A5).
    await whitelistService.delete(id, req.tenantId);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
