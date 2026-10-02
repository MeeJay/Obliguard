import type { Request, Response, NextFunction } from 'express';
import { ipReputationService, REPUTATION_SORT_KEYS } from '../services/ipReputation.service';
import { banService } from '../services/ban.service';
import { whitelistService } from '../services/whitelist.service';
import { AppError } from '../middleware/errorHandler';
import { parsePaging, parseLimitOffset, parseSort, queryString } from '../utils/pagination';
import { parseIpOrCidr } from '../utils/ipValidation';
import type { AddIpReputationRequest, BanScope, IpStatus, WhitelistScope } from '@obliview/shared';

/** Largest page a single list request may pull. */
const MAX_REPUTATION_PAGE = 500;

/** Statuses accepted by the list filter (anything else is ignored). */
const LIST_STATUSES: readonly IpStatus[] = ['clean', 'suspicious', 'banned', 'whitelisted'];

/**
 * GET /api/ip-reputation
 *   ?status=&search=  search: an IP (exact), a CIDR (containment) or a substring
 *   ?limit=&offset=   or ?page=&pageSize=   (max 500 per page)
 *   ?sortBy=lastSeen|failures|agents|country|firstSeen|bannedAt&sortOrder=asc|desc
 */
export async function listReputation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const statusRaw = queryString(q.status, 20);
    const status = LIST_STATUSES.includes(statusRaw as IpStatus) ? statusRaw as IpStatus : undefined;
    const search  = queryString(q.search, 64);
    // Both paging styles are accepted (the UI uses limit/offset, A16 page/pageSize).
    let limit: number;
    let offset: number;
    if (q.page !== undefined || q.pageSize !== undefined) {
      const p = parsePaging(q, { defaultSize: 50, max: MAX_REPUTATION_PAGE });
      limit = p.pageSize;
      offset = p.offset;
    } else {
      ({ limit, offset } = parseLimitOffset(q, { defaultLimit: 50, max: MAX_REPUTATION_PAGE }));
    }
    const { sortBy, sortOrder, explicit } = parseSort(q, REPUTATION_SORT_KEYS, { sortBy: 'lastSeen', sortOrder: 'desc' });
    const isAdmin = req.session?.role === 'admin';

    const result = await ipReputationService.list({
      status, search, limit, offset, tenantId: req.tenantId, isAdmin,
      // No explicit key: the service default (lastSeen, or bannedAt on the banned list).
      sortBy: explicit ? sortBy : undefined,
      sortOrder,
    });
    res.json({ success: true, data: result.data, total: result.total, limit, offset });
  } catch (err) {
    next(err);
  }
}

export async function getIpDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ip } = req.params;
    if (!ip) throw new AppError(400, 'IP address is required');
    // ip_reputation.ip is inet: anything that is not one address would be a 500.
    const parsed = parseIpOrCidr(ip);
    if (!parsed || parsed.prefix !== (parsed.family === 4 ? 32 : 128)) throw new AppError(400, 'Invalid IP address');

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
/**
 * POST /api/ip-reputation
 *
 * Manually adds an IP to the reputation module with a desired status.
 * Dispatches to the appropriate service based on status:
 *   - banned       → banService.create (creates ip_bans row)
 *   - whitelisted  → whitelistService.create (creates ip_whitelist row)
 *   - suspicious   → ipReputationService.markSuspicious (upsert ip_reputation)
 *   - clean        → ipReputationService.markClean (ensureExists + clearGlobal/clearForTenant)
 */
export async function addIp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body as AddIpReputationRequest;
    const isAdmin = req.session?.role === 'admin';
    const userId  = req.session?.userId ?? 0;
    const tenantId = req.tenantId;

    if (!body?.ip || typeof body.ip !== 'string') throw new AppError(400, 'IP address is required');
    if (!body.status) throw new AppError(400, 'status is required');

    switch (body.status) {
      case 'banned': {
        if (!tenantId) throw new AppError(403, 'No tenant context');
        const ban = await banService.create(
          {
            ip: body.ip,
            reason: body.reason ?? null,
            scope: body.scope as BanScope | undefined,
            scopeId: body.scopeId ?? null,
            expiresAt: body.expiresAt ?? null,
          },
          userId,
          tenantId,
          isAdmin,
        );
        res.json({ success: true, data: ban });
        return;
      }
      case 'whitelisted': {
        if (!tenantId) throw new AppError(403, 'No tenant context');
        const entry = await whitelistService.create(
          {
            ip: body.ip,
            label: body.label ?? null,
            scope: body.scope as WhitelistScope | undefined,
            scopeId: body.scopeId ?? null,
          },
          userId,
          tenantId,
        );
        res.json({ success: true, data: entry });
        return;
      }
      case 'suspicious': {
        await ipReputationService.markSuspicious(body.ip);
        res.json({ success: true, message: `${body.ip} marked as suspicious` });
        return;
      }
      case 'clean': {
        await ipReputationService.markClean(body.ip, tenantId, isAdmin, userId);
        res.json({ success: true, message: `${body.ip} marked as clean` });
        return;
      }
      default:
        throw new AppError(400, `Unknown status: ${body.status}`);
    }
  } catch (err) {
    next(err);
  }
}

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
