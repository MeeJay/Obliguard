import type { Request, Response, NextFunction } from 'express';
import { banService } from '../services/ban.service';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';

export interface CreateBanRequest {
  ip: string;
  cidrPrefix?: number | null;
  reason?: string | null;
  banType?: 'auto' | 'manual';
  scope?: 'global' | 'tenant' | 'group' | 'agent';
  scopeId?: number | null;
  expiresAt?: string | null;
}

export async function getBanStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const isAdmin = req.session?.role === 'admin';

    // Apply scope filter: admins see all bans; tenant users see global bans + their own
    function applyTenantScope(q: ReturnType<typeof db>) {
      if (isAdmin) return q;
      return q.where(function (this: ReturnType<typeof db>) {
        this.where('scope', 'global').orWhere('tenant_id', req.tenantId);
      });
    }

    const [[activeRow], [todayRow]] = await Promise.all([
      applyTenantScope(
        db('ip_bans')
          .where('is_active', true)
          .whereRaw('(expires_at IS NULL OR expires_at > NOW())'),
      ).count<Array<{ count: string }>>({ count: '*' }),
      applyTenantScope(
        db('ip_bans')
          .whereRaw('banned_at >= CURRENT_DATE'),
      ).count<Array<{ count: string }>>({ count: '*' }),
    ]);

    res.json({
      success: true,
      data: {
        active: Number(activeRow?.count ?? 0),
        today: Number(todayRow?.count ?? 0),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function listBans(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const active = req.query.active !== undefined
      ? req.query.active === 'true'
      : undefined;
    const search = req.query.search as string | undefined;
    const page = req.query.page !== undefined ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.pageSize !== undefined ? parseInt(req.query.pageSize as string, 10) : 25;
    const isAdmin = req.session?.role === 'admin';
    const offset = (page - 1) * pageSize;

    const result = await banService.list({ onlyActive: active, search, limit: pageSize, offset, tenantId: req.tenantId, isAdmin });
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

    const isAdmin = req.session?.role === 'admin';
    const ban = await banService.create(body, req.session?.userId ?? 0, req.tenantId, isAdmin);

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

    const isAdmin = req.session?.role === 'admin';
    await banService.lift(id, req.tenantId, isAdmin);

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

/**
 * POST /api/bans/:id/exclude
 * Create a per-tenant exclusion so this tenant's agents don't enforce the global ban.
 */
export async function excludeBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) throw new AppError(400, 'Invalid ban ID');

    await banService.excludeForTenant(id, req.tenantId, req.session?.userId ?? 0);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/bans/:id/exclude
 * Remove the per-tenant exclusion (this tenant's agents will enforce the ban again).
 */
export async function removeExclusion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) throw new AppError(400, 'Invalid ban ID');

    await banService.removeExclusion(id, req.tenantId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
