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

export async function getBanById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await db('ip_bans').where({ id }).first();
    if (!row) throw new AppError(404, 'Ban not found');
    // Resolve username if manual ban
    let bannedByUsername: string | null = null;
    if (row.banned_by_user_id) {
      const user = await db('users').where({ id: row.banned_by_user_id }).select('username', 'display_name').first();
      bannedByUsername = user?.display_name || user?.username || null;
    }
    res.json({
      success: true,
      data: {
        id: row.id,
        ip: row.ip,
        banType: row.ban_type,
        reason: row.reason,
        scope: row.scope,
        scopeId: row.scope_id,
        bannedByUserId: row.banned_by_user_id,
        bannedByUsername,
        bannedAt: row.banned_at,
        expiresAt: row.expires_at,
        isActive: row.is_active,
      },
    });
  } catch (err) { next(err); }
}

export async function wipeAllBans(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Mark all active bans as inactive (not delete) so agents receive the "remove" delta
    const count = await db('ip_bans').where({ is_active: true }).update({ is_active: false });
    res.json({ success: true, message: `Lifted ${count} active bans` });
  } catch (err) { next(err); }
}

export async function wipeAllReputation(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const evCount = await db('ip_events').del();
    const repCount = await db('ip_reputation').del();
    res.json({ success: true, message: `Deleted ${repCount} reputation entries and ${evCount} events` });
  } catch (err) { next(err); }
}

export async function bulkBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ips } = req.body as { ips: string[] };
    if (!Array.isArray(ips) || ips.length === 0) throw new AppError(400, 'ips array required');
    let created = 0;
    for (const ip of ips) {
      const existing = await db('ip_bans').where({ ip, is_active: true }).first();
      if (existing) continue;
      await db('ip_bans').insert({ ip, ban_type: 'manual', scope: 'global', is_active: true, banned_by_user_id: req.session?.userId });
      created++;
    }
    res.json({ success: true, created });
  } catch (err) { next(err); }
}

export async function bulkWhitelist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ips, label } = req.body as { ips: string[]; label?: string };
    if (!Array.isArray(ips) || ips.length === 0) throw new AppError(400, 'ips array required');
    let created = 0;
    for (const ip of ips) {
      const existing = await db('ip_whitelist').where({ ip }).first();
      if (existing) continue;
      await db('ip_whitelist').insert({ ip, label: label || null, scope: 'global', created_by: req.session?.userId, tenant_id: req.tenantId });
      created++;
    }
    res.json({ success: true, created });
  } catch (err) { next(err); }
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
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'This IP is already banned') {
      next(new AppError(409, err.message));
    } else {
      next(err);
    }
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
