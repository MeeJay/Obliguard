import type { Request, Response, NextFunction } from 'express';
import net from 'net';
import { ipReputationService, REPUTATION_SORT_KEYS } from '../services/ipReputation.service';
import type { IpReputationListItem } from '../services/ipReputation.service';
import { banService } from '../services/ban.service';
import { whitelistService } from '../services/whitelist.service';
import { AppError } from '../middleware/errorHandler';
import { parseTenantIds } from '../middleware/tenant';
import { parsePaging, parseLimitOffset, parseSort, queryString } from '../utils/pagination';
import { parseIpOrCidr } from '../utils/ipValidation';
import { auditService } from '../services/audit.service';
import { CSV_EXPORT_MAX, csvDate, csvFilename, csvMaskers, sendCsv, wantsAnon } from '../utils/csv';
import type { AddIpReputationRequest, BanScope, IpStatus, WhitelistScope } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';

/**
 * A global reputation reset (counter back to 0 for every tenant) is reserved to
 * a platform admin operating the Default tenant; everyone else, the platform
 * admin in another tenant included, clears for the operating tenant only.
 */
function clearsGlobally(req: Request): boolean {
  return req.session?.role === 'admin' && isMasterTenant(req.tenantId);
}

/** Largest page a single list request may pull. */
const MAX_REPUTATION_PAGE = 500;

/** Statuses accepted by the list filter (anything else is ignored). */
const LIST_STATUSES: readonly IpStatus[] = ['clean', 'suspicious', 'banned', 'whitelisted'];

/** The list filters shared by GET /api/ip-reputation and its CSV export. */
function parseReputationFilters(q: Record<string, unknown>): {
  status: IpStatus | undefined;
  search: string | undefined;
  tenantIds: number[] | undefined;
  sortBy: (typeof REPUTATION_SORT_KEYS)[number] | undefined;
  sortOrder: 'asc' | 'desc';
} {
  const statusRaw = queryString(q.status, 20);
  const status = LIST_STATUSES.includes(statusRaw as IpStatus) ? statusRaw as IpStatus : undefined;
  const search  = queryString(q.search, 64);
  const { sortBy, sortOrder, explicit } = parseSort(q, REPUTATION_SORT_KEYS, { sortBy: 'lastSeen', sortOrder: 'desc' });
  return {
    status,
    search,
    // God view tenant chips (Default only; ignored elsewhere by readTenantsFor).
    tenantIds: parseTenantIds(q.tenants),
    // No explicit key: the service default (lastSeen, or bannedAt on the banned list).
    sortBy: explicit ? sortBy : undefined,
    sortOrder,
  };
}

/**
 * GET /api/ip-reputation
 *   ?status=&search=  search: an IP (exact), a CIDR (containment) or a substring
 *   ?limit=&offset=   or ?page=&pageSize=   (max 500 per page)
 *   ?sortBy=lastSeen|failures|agents|country|firstSeen|bannedAt&sortOrder=asc|desc
 */
export async function listReputation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const filters = parseReputationFilters(q);
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
    const isAdmin = req.session?.role === 'admin';

    const result = await ipReputationService.list({
      ...filters, limit, offset, tenantId: req.tenantId, isAdmin,
    });
    res.json({ success: true, data: result.data, total: result.total, limit, offset });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ip-reputation/export — the reputation list as CSV: same filters
 * and tenant scope (god view on Default, own events elsewhere) as
 * listReputation, at most CSV_EXPORT_MAX rows (X-Truncated when capped).
 * The service pages by MAX_REPUTATION_PAGE, so the rows are read page by
 * page. `?anon=1` masks the addresses and the attempted usernames.
 */
export async function exportReputation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const filters = parseReputationFilters(q);
    const anon = wantsAnon(q);
    const mask = csvMaskers(anon);
    const isAdmin = req.session?.role === 'admin';

    const data: IpReputationListItem[] = [];
    let total = 0;
    for (let offset = 0; offset < CSV_EXPORT_MAX; offset += MAX_REPUTATION_PAGE) {
      const page = await ipReputationService.list({
        ...filters, limit: MAX_REPUTATION_PAGE, offset, tenantId: req.tenantId, isAdmin,
      });
      if (offset === 0) total = page.total;
      data.push(...page.data);
      if (page.data.length < MAX_REPUTATION_PAGE) break;
    }
    const truncated = total > CSV_EXPORT_MAX || data.length > CSV_EXPORT_MAX;
    if (data.length > CSV_EXPORT_MAX) data.length = CSV_EXPORT_MAX;

    await auditService.logReq(req, {
      action: 'ip_reputation.exported', targetType: 'ip_reputation',
      details: {
        rows: data.length, truncated, anon,
        filters: { status: filters.status ?? null, search: filters.search ?? null, tenants: filters.tenantIds ?? null },
      },
    });
    sendCsv(res, {
      filename: csvFilename('ip-reputation'),
      headers: ['IP', 'Status', 'Failures', 'Successes', 'Agents', 'Services', 'Usernames', 'Country', 'City', 'ASN',
        'First seen', 'Last seen', 'Ban scope', 'Tenant', 'Tenant IDs'],
      rows: data.map((r) => [
        mask.ip(String(r.ip)),
        r.status ?? null,
        Number(r.totalFailures ?? 0),
        Number(r.totalSuccesses ?? 0),
        Number(r.affectedAgentsCount ?? 0),
        (r.affectedServices ?? []).join(';'),
        (r.attemptedUsernames ?? []).map((u) => mask.username(u)).join(';'),
        r.geoCountryCode,
        r.geoCity,
        r.asn,
        csvDate(r.firstSeen),
        csvDate(r.lastSeen),
        r.activeBanScope ?? null,
        r.tenantName,
        (r.tenantIds ?? []).join(';'),
      ]),
      truncated,
    });
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
        await auditService.logReq(req, {
          action: 'bans.created', targetType: 'ban', targetId: ban.id,
          deviceId: ban.scope === 'agent' ? ban.scopeId : null,
          details: { ip: ban.ip, scope: ban.scope, scopeId: ban.scopeId, reason: ban.reason, expiresAt: ban.expiresAt ?? null, via: 'ip_reputation' },
        });
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
        await auditService.logReq(req, {
          action: 'whitelist.created', targetType: 'whitelist', targetId: entry.id,
          deviceId: entry.scope === 'agent' ? entry.scopeId : null,
          details: { ip: entry.ip, scope: entry.scope, scopeId: entry.scopeId, label: entry.label, via: 'ip_reputation' },
        });
        res.json({ success: true, data: entry });
        return;
      }
      case 'suspicious': {
        // Global effect (drops every tenant's clear baseline): Default tenant only.
        if (!isMasterTenant(tenantId)) {
          throw new AppError(403, 'An IP can only be marked suspicious from the Default tenant');
        }
        if (net.isIP(body.ip) === 0) throw new AppError(400, 'Invalid IP address');
        await ipReputationService.markSuspicious(body.ip);
        await auditService.logReq(req, { action: 'ip_reputation.marked_suspicious', targetType: 'ip', targetId: body.ip, details: { ip: body.ip } });
        res.json({ success: true, message: `${body.ip} marked as suspicious` });
        return;
      }
      case 'clean': {
        if (net.isIP(body.ip) === 0) throw new AppError(400, 'Invalid IP address');
        await ipReputationService.markClean(body.ip, tenantId, clearsGlobally(req), userId);
        await auditService.logReq(req, {
          action: 'ip_reputation.cleared', targetType: 'ip', targetId: body.ip,
          details: { ip: body.ip, global: clearsGlobally(req), via: 'mark_clean' },
        });
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
    const userId  = req.session?.userId ?? 0;

    if (!ip) throw new AppError(400, 'IP address is required');
    if (net.isIP(ip) === 0) throw new AppError(400, 'Invalid IP address');

    // ip.reputation.clear (route): tenant clear, global only for the platform admin on Default.
    if (clearsGlobally(req)) {
      await ipReputationService.clearGlobal(ip);
      await auditService.logReq(req, { action: 'ip_reputation.cleared', targetType: 'ip', targetId: ip, details: { ip, global: true } });
      res.json({ success: true, message: `${ip} reputation cleared globally` });
    } else {
      if (!req.tenantId) throw new AppError(403, 'No tenant context');
      await ipReputationService.clearForTenant(ip, req.tenantId, userId);
      await auditService.logReq(req, { action: 'ip_reputation.cleared', targetType: 'ip', targetId: ip, details: { ip, global: false } });
      res.json({ success: true, message: `${ip} marked as cleared for your tenant` });
    }
  } catch (err) {
    next(err);
  }
}
