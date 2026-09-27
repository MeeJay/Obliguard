import type { Request, Response, NextFunction } from 'express';
import type { CreateBanRequest } from '@obliview/shared';
import { banService } from '../services/ban.service';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';
import { isMasterTenant } from '@obliview/shared';
import { parsePaging } from '../utils/pagination';
import { parseBanTarget } from '../utils/ipValidation';
import { logger } from '../utils/logger';

export async function getBanById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!/^[0-9]{1,9}$/.test(String(req.params.id))) throw new AppError(400, 'Invalid ban ID');
    const id = Number(req.params.id);
    const data = await banService.getById(id, req.tenantId, req.session?.role === 'admin');
    if (!data) throw new AppError(404, 'Ban not found');
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

export async function wipeAllBans(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Platform-wide reset: platform admin (route) AND the Default tenant.
    if (!isMasterTenant(req.tenantId)) throw new AppError(403, 'Wipe is only available from the Default tenant');
    // Mark all active bans as inactive (not delete) so agents receive the "remove" delta
    const count = await db('ip_bans').where({ is_active: true }).update({ is_active: false });
    res.json({ success: true, message: `Lifted ${count} active bans` });
  } catch (err) { next(err); }
}

export async function wipeAllReputation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!isMasterTenant(req.tenantId)) throw new AppError(403, 'Wipe is only available from the Default tenant');
    const evCount = await db('ip_events').del();
    const repCount = await db('ip_reputation').del();
    res.json({ success: true, message: `Deleted ${repCount} reputation entries and ${evCount} events` });
  } catch (err) { next(err); }
}

const BULK_BAN_MAX = 1000;
const BULK_DETAIL_MAX = 50;

/**
 * POST /api/bans/bulk-ban — 1..1000 single IPs, each through banService.create
 * (same scope rule, validation, whitelist and duplicate checks as a single
 * ban). Per-entry errors are contained; MikroTik pushes are serialised after
 * the loop (tenant routers only for tenant-local bans).
 */
export async function bulkBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ips } = (req.body ?? {}) as { ips?: unknown };
    if (!Array.isArray(ips) || ips.length === 0 || ips.length > BULK_BAN_MAX) {
      throw new AppError(400, `ips must be an array of 1 to ${BULK_BAN_MAX} entries`);
    }
    const isAdmin = req.session?.role === 'admin';
    const userId = req.session?.userId ?? 0;
    const tenantId = req.tenantId;
    // One membership refusal for the whole request.
    await banService.assertOperatingMembership(userId, tenantId, isAdmin);

    const seen = new Set<string>();
    let created = 0;
    let skipped = 0;
    let invalid = 0;
    const skippedEntries: Array<{ ip: string; reason: string }> = [];
    const invalidEntries: Array<{ ip: string; reason: string }> = [];
    const createdIps: string[] = [];
    const skip = (entry: unknown, reason: string) => {
      skipped++;
      if (skippedEntries.length < BULK_DETAIL_MAX) skippedEntries.push({ ip: String(entry).slice(0, 64), reason });
    };
    const bad = (entry: unknown, reason: string) => {
      invalid++;
      if (invalidEntries.length < BULK_DETAIL_MAX) invalidEntries.push({ ip: String(entry).slice(0, 64), reason });
    };

    try {
      for (const entry of ips) {
        if (typeof entry !== 'string') { bad(entry, 'Invalid IP address'); continue; }
        const p = parseBanTarget(entry, { allowCidr: false });
        if (!p.ok) { bad(entry, p.message); continue; }
        if (seen.has(p.target.cidr)) { skip(entry, 'duplicate in request'); continue; }
        seen.add(p.target.cidr);
        try {
          const ban = await banService.create(
            { ip: p.target.address, reason: 'Bulk ban (IP Reputation)' },
            userId, tenantId, isAdmin,
            { deferMikrotik: true, membershipChecked: true },
          );
          created++;
          createdIps.push(ban.ip);
        } catch (e) {
          if (e instanceof AppError && e.statusCode === 409) skip(entry, e.message);
          else if (e instanceof AppError) bad(entry, e.message);
          else {
            logger.error({ err: e, ip: p.target.address }, 'bulk-ban entry failed');
            bad(entry, 'internal error');
          }
        }
      }
    } finally {
      if (createdIps.length) {
        void (async () => {
          const { mikrotikBanSync } = await import('../services/mikrotik/mikrotikBanSync.service');
          const audience = isMasterTenant(tenantId) ? undefined : { tenantId };
          for (const ip of createdIps) await mikrotikBanSync.pushBanToAll(ip, 'ban', audience);
        })().catch((err) => logger.warn({ err }, 'bulk-ban MikroTik push failed'));
      }
    }

    res.json({
      success: true,
      created,
      skipped,
      invalid,
      scope: isMasterTenant(tenantId) ? 'global' : 'tenant',
      skippedEntries,
      invalidEntries,
    });
  } catch (err) { next(err); }
}

export async function bulkWhitelist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ips, label } = req.body as { ips: string[]; label?: string };
    if (!Array.isArray(ips) || ips.length === 0) throw new AppError(400, 'ips array required');
    // Global-vs-local is decided by the operating tenant (mirrors whitelistService):
    // the Default/master tenant whitelists globally, any other tenant locally.
    const scope = isMasterTenant(req.tenantId) ? 'global' : 'tenant';
    const tenantId = scope === 'global' ? null : req.tenantId;
    let created = 0;
    for (const ip of ips) {
      const existing = await db('ip_whitelist').where({ ip }).first();
      if (existing) continue;
      await db('ip_whitelist').insert({
        ip: db.raw('?::cidr', [ip]),
        label: label || null,
        scope,
        scope_id: null,
        created_by: req.session?.userId,
        tenant_id: tenantId,
      });
      created++;
    }
    res.json({ success: true, created });
  } catch (err) { next(err); }
}

export async function getBanStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ success: true, data: await banService.stats(req.tenantId, req.session?.role === 'admin') });
  } catch (err) {
    next(err);
  }
}

export async function listBans(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const active = req.query.active !== undefined
      ? req.query.active === 'true'
      : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 64) : undefined;
    const { pageSize, offset } = parsePaging(req.query as Record<string, unknown>, { defaultSize: 25, max: 1000 });
    const isAdmin = req.session?.role === 'admin';

    const result = await banService.list({ onlyActive: active, search, limit: pageSize, offset, tenantId: req.tenantId, isAdmin });
    res.json({ success: true, data: result.data, total: result.total });
  } catch (err) {
    next(err);
  }
}

export async function createBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as CreateBanRequest;
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

    await banService.lift(id, req.tenantId, req.session?.userId ?? 0, req.session?.role === 'admin');

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

    const ban = await banService.promoteToGlobal(id, req.tenantId, req.session?.userId ?? 0, req.session?.role === 'admin');

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

    await banService.excludeForTenant(id, req.tenantId, req.session?.userId ?? 0, req.session?.role === 'admin');
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
