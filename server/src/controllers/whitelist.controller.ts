import type { Request, Response, NextFunction } from 'express';
import { whitelistService, WHITELIST_BULK_DELETE_MAX } from '../services/whitelist.service';
import type { WhitelistListSort } from '../services/whitelist.service';
import { requestVisibleAgentIds } from '../services/agentScope.service';
import { AppError } from '../middleware/errorHandler';
import type { WhitelistScope } from '@obliview/shared';
import { parsePaging, parseSort, queryString } from '../utils/pagination';
import { auditService } from '../services/audit.service';
import { db } from '../db';
import { CSV_EXPORT_MAX, csvDate, csvFilename, csvMaskers, sendCsv, wantsAnon } from '../utils/csv';

import { parseTenantIds } from '../middleware/tenant';

// `?tenants=1,2` (god view tenant filter) parsing lives in middleware/tenant
// (W10-5); re-exported for the controllers that import it from here.
export { parseTenantIds };

const WHITELIST_SORTS: readonly WhitelistListSort[] = ['createdAt', 'ip', 'scope'];

/** A bulk request's `ids`: 1..max unique positive integers, else 400. */
export function parseBulkIds(raw: unknown, max: number): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
    throw new AppError(400, `ids must be an array of 1 to ${max} entries`);
  }
  const ids = raw.map((v) => (typeof v === 'string' && /^[0-9]{1,10}$/.test(v) ? Number(v) : v));
  if (!ids.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 2147483647)) {
    throw new AppError(400, 'ids must be positive integers');
  }
  return [...new Set(ids as number[])];
}

export interface CreateWhitelistRequest {
  ip: string;
  label?: string | null;
  scope?: 'global' | 'tenant' | 'group' | 'agent';
  scopeId?: number | null;
}

/** The list filters of GET /api/whitelist (and its CSV export); 400 on an invalid value. */
function parseWhitelistFilters(query: Record<string, unknown>): {
  scope: WhitelistScope | 'all' | undefined;
  scopeId: number | null;
  ip: string | undefined;
  search: string | undefined;
  tenantIds: number[] | undefined;
  sortBy: WhitelistListSort | undefined;
  sortOrder: 'asc' | 'desc';
} {
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
  const search = queryString(query.search, 64);
  // No sortBy keeps the historical order (scope, created_at).
  const sort = parseSort(query, WHITELIST_SORTS, { sortBy: 'createdAt', sortOrder: 'desc' });
  return {
    scope: scopeParam as WhitelistScope | 'all' | undefined,
    scopeId,
    ip,
    search,
    tenantIds: parseTenantIds(query.tenants),
    sortBy: sort.explicit ? sort.sortBy : undefined,
    sortOrder: sort.sortOrder,
  };
}

export async function listWhitelist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = parseWhitelistFilters(query);
    // Callers that never page get the whole (capped) list in one response.
    const { page, pageSize, offset } = parsePaging(query, { defaultSize: 1000, max: 1000 });

    // Visibility follows the operating tenant (Default = god view); the
    // platform role grants nothing extra (W1-2). A user restricted by team
    // grants only sees the group/agent entries of their agents (RBAC-8).
    const result = await whitelistService.list({
      tenantId: req.tenantId,
      ...filters,
      visibleAgentIds: await requestVisibleAgentIds(req),
      limit: pageSize,
      offset,
    });

    // Per-entry delete right for the operating tenant (A5). A4 must keep this call.
    const entries = await whitelistService.annotateDeletable(result.data, req.tenantId, {
      visibleAgentIds: await requestVisibleAgentIds(req, 'write'),
    });

    res.json({ success: true, data: entries, total: result.total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/whitelist/export — the whitelist as CSV: same filters, visibility
 * (god view on Default; global, own and owned group/agent entries elsewhere)
 * and team scope as listWhitelist, at most CSV_EXPORT_MAX rows (X-Truncated
 * when capped). `?anon=1` masks the ranges, the author and agent names.
 */
export async function exportWhitelist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = parseWhitelistFilters(query);
    const anon = wantsAnon(query);
    const mask = csvMaskers(anon);

    const result = await whitelistService.list({
      tenantId: req.tenantId,
      ...filters,
      visibleAgentIds: await requestVisibleAgentIds(req),
      limit: CSV_EXPORT_MAX + 1,
      offset: 0,
    });
    const truncated = result.data.length > CSV_EXPORT_MAX;
    const data = truncated ? result.data.slice(0, CSV_EXPORT_MAX) : result.data;

    await auditService.logReq(req, {
      action: 'whitelist.exported', targetType: 'whitelist',
      details: {
        rows: data.length, truncated, anon,
        filters: {
          scope: filters.scope ?? null, scopeId: filters.scopeId, ip: filters.ip ?? null,
          search: filters.search ?? null, tenants: filters.tenantIds ?? null,
        },
      },
    });
    sendCsv(res, {
      filename: csvFilename('whitelist'),
      headers: ['IP / range', 'Label', 'Scope', 'Scope target', 'Tenant', 'Created by', 'Created at'],
      rows: data.map((e) => [
        mask.ip(e.ip),
        e.label,
        e.scope,
        e.scope === 'agent' ? mask.hostname(e.scopeName ?? null) : e.scopeName ?? null,
        e.tenantName ?? null,
        mask.username(e.createdByUsername ?? null),
        csvDate(e.createdAt),
      ]),
      truncated,
    });
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
    await auditService.logReq(req, {
      action: 'whitelist.created', targetType: 'whitelist', targetId: entry.id,
      deviceId: entry.scope === 'agent' ? entry.scopeId : null,
      details: { ip: entry.ip, scope: entry.scope, scopeId: entry.scopeId, label: entry.label },
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

    const before = await db('ip_whitelist').where({ id }).first('ip', 'scope', 'scope_id', 'label') as
      { ip: string; scope: string; scope_id: number | null; label: string | null } | undefined;
    // Follows the operating tenant; the platform role grants nothing extra (A5).
    await whitelistService.delete(id, req.tenantId, {
      visibleAgentIds: await requestVisibleAgentIds(req, 'write'),
    });
    await auditService.logReq(req, {
      action: 'whitelist.deleted', targetType: 'whitelist', targetId: id,
      deviceId: before?.scope === 'agent' ? before.scope_id : null,
      details: { ip: before?.ip ?? null, scope: before?.scope ?? null, scopeId: before?.scope_id ?? null, label: before?.label ?? null },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/whitelist/bulk-delete {ids[]} — 1..1000 entries, each under the
 * single delete rule (global entries locked outside Default, foreign entries
 * read-only from Default). Refusals are counted, never abort the batch.
 */
export async function bulkDeleteWhitelist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ids = parseBulkIds((req.body as { ids?: unknown } | undefined)?.ids, WHITELIST_BULK_DELETE_MAX);
    const result = await whitelistService.bulkDelete(ids, req.tenantId, {
      visibleAgentIds: await requestVisibleAgentIds(req, 'write'),
    });
    await auditService.logReq(req, {
      action: 'whitelist.bulk_deleted', targetType: 'whitelist',
      details: { ids, deleted: result.deleted, forbidden: result.forbidden, notFound: result.notFound },
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}
