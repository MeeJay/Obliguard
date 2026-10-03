import type { Request, Response, NextFunction } from 'express';
import type { CreateBanRequest, BanScope } from '@obliview/shared';
import { banService, BULK_LIFT_MAX } from '../services/ban.service';
import type { BanListSort, BanListState } from '../services/ban.service';
import { requestAgentScope, requestVisibleAgentIds, scopeAgentIds } from '../services/agentScope.service';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';
import { isMasterTenant } from '@obliview/shared';
import { parsePaging, parseSort, queryString } from '../utils/pagination';
import { parseBulkIds, parseTenantIds } from './whitelist.controller';
import { parseBanTarget } from '../utils/ipValidation';
import { isInetLiteral, notifyWhitelistChanged } from '../services/whitelist.service';
import { logger } from '../utils/logger';
import { auditService } from '../services/audit.service';
import { CSV_EXPORT_MAX, csvDate, csvFilename, csvMaskers, sendCsv, wantsAnon } from '../utils/csv';

/** Audit fields of one ban row (read before the action changes it). */
async function banAuditTarget(id: number): Promise<{ ip: string | null; scope: string | null; scopeId: number | null; deviceId: number | null; isActive: boolean | null }> {
  const row = await db('ip_bans').where({ id }).first('ip', 'cidr_prefix', 'scope', 'scope_id', 'is_active') as
    { ip: string; cidr_prefix: number | null; scope: string; scope_id: number | null; is_active: boolean } | undefined;
  if (!row) return { ip: null, scope: null, scopeId: null, deviceId: null, isActive: null };
  const ip = row.cidr_prefix != null && !String(row.ip).includes('/') ? `${row.ip}/${row.cidr_prefix}` : String(row.ip);
  return {
    ip,
    scope: row.scope,
    scopeId: row.scope_id,
    deviceId: row.scope === 'agent' ? row.scope_id : null,
    isActive: row.is_active,
  };
}

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
    // Deactivate (not delete) so agents receive the "remove" delta; lifted_at
    // keeps the BanEngine from re-minting them from the same failures.
    const count = await banService.wipeAll({ userId: req.session?.userId ?? null, tenantId: req.tenantId });
    await auditService.logReq(req, { action: 'bans.wiped', targetType: 'ban', details: { lifted: count } });
    res.json({ success: true, message: `Lifted ${count} active bans` });
  } catch (err) { next(err); }
}

export async function wipeAllReputation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!isMasterTenant(req.tenantId)) throw new AppError(403, 'Wipe is only available from the Default tenant');
    const evCount = await db('ip_events').del();
    const repCount = await db('ip_reputation').del();
    await auditService.logReq(req, { action: 'ip_reputation.wiped', targetType: 'ip_reputation', details: { reputationEntries: repCount, events: evCount } });
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

    await auditService.logReq(req, {
      action: 'bans.bulk_created', targetType: 'ban',
      details: { scope: isMasterTenant(tenantId) ? 'global' : 'tenant', created, skipped, invalid, ips: createdIps },
    });
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
    if (ips.length > 1000) throw new AppError(400, 'At most 1000 ips per request');
    let created = 0;
    let invalid = 0;
    for (const raw of ips) {
      if (typeof raw !== 'string' || !isInetLiteral(raw)) { invalid++; continue; }
      const ip = raw.trim();
      // Dedupe within the operating tenant's own scope only: another tenant's
      // local entry for the same address must not block this one (W1-2).
      try {
        const existing = await db('ip_whitelist')
          .whereRaw('ip = ?::cidr', [ip])
          .where({ scope })
          .whereNull('scope_id')
          .where((q) => { if (tenantId === null) q.whereNull('tenant_id'); else q.where('tenant_id', tenantId); })
          .first('id');
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
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;        // concurrent insert of the same entry
        if (code === '22P02') { invalid++; continue; } // host bits set, e.g. 10.0.0.1/8
        throw err;
      }
    }
    if (created > 0) notifyWhitelistChanged('created', [{ scope, tenantId }]);
    await auditService.logReq(req, {
      action: 'whitelist.bulk_created', targetType: 'whitelist',
      details: { scope, label: label || null, created, invalid, ips: ips.slice(0, 200) },
    });
    res.json({ success: true, created, ...(invalid > 0 ? { invalid } : {}) });
  } catch (err) { next(err); }
}

export async function getBanStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ success: true, data: await banService.stats(req.tenantId, req.session?.role === 'admin') });
  } catch (err) {
    next(err);
  }
}

const BAN_STATES: ReadonlyArray<BanListState | 'all'> = ['active', 'expired', 'lifted', 'all'];
const BAN_SCOPES: readonly BanScope[] = ['global', 'tenant', 'group', 'agent'];
const BAN_TYPES: readonly string[] = ['auto', 'manual', 'external', 'remote'];
const BAN_SORTS: readonly BanListSort[] = ['createdAt', 'expiresAt', 'ip'];

/** The list filters of GET /api/bans (and its CSV export); 400 on an invalid value. */
function parseBanListFilters(query: Record<string, unknown>): {
  state: BanListState | 'all';
  scope: BanScope | undefined;
  banType: string | undefined;
  search: string | undefined;
  tenantIds: number[] | undefined;
  sortBy: BanListSort;
  sortOrder: 'asc' | 'desc';
} {
  let state: BanListState | 'all' = 'active';
  if (query.state !== undefined) {
    if (typeof query.state !== 'string' || !(BAN_STATES as readonly string[]).includes(query.state)) {
      throw new AppError(400, `state must be one of ${BAN_STATES.join(', ')}`);
    }
    state = query.state as BanListState | 'all';
  } else if (query.active !== undefined) {
    state = query.active === 'true' ? 'active' : 'all';
  }
  let scope: BanScope | undefined;
  if (query.scope !== undefined && query.scope !== '' && query.scope !== 'all') {
    if (typeof query.scope !== 'string' || !(BAN_SCOPES as readonly string[]).includes(query.scope)) {
      throw new AppError(400, 'Invalid scope');
    }
    scope = query.scope as BanScope;
  }
  let banType: string | undefined;
  if (query.type !== undefined && query.type !== '' && query.type !== 'all') {
    if (typeof query.type !== 'string' || !BAN_TYPES.includes(query.type)) {
      throw new AppError(400, 'Invalid ban type');
    }
    banType = query.type;
  }
  const search = queryString(query.search, 64);
  const sort = parseSort(query, BAN_SORTS, { sortBy: 'createdAt', sortOrder: 'desc' });
  return {
    state, scope, banType, search,
    tenantIds: parseTenantIds(query.tenants),
    sortBy: sort.sortBy,
    sortOrder: sort.sortOrder,
  };
}

/**
 * GET /api/bans?state=active|expired|lifted|all&scope=&type=&search=&tenants=&sortBy=createdAt|expiresAt|ip&sortOrder=&page=&pageSize=
 * The legacy `active=true|false` still works (true = active, false = all)
 * when no state is given; the default is the active bans.
 */
export async function listBans(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = parseBanListFilters(query);
    const { page, pageSize, offset } = parsePaging(query, { defaultSize: 25, max: 1000 });
    const isAdmin = req.session?.role === 'admin';
    const agentScope = await requestAgentScope(req);

    const result = await banService.list({
      tenantId: req.tenantId,
      isAdmin,
      ...filters,
      // A user restricted by team grants only sees the group/agent bans of their agents.
      visibleAgentIds: scopeAgentIds(agentScope),
      // Rows outside the writable agents are listed without a Lift.
      writableAgentIds: scopeAgentIds(agentScope, 'write'),
      limit: pageSize,
      offset,
    });
    res.json({ success: true, data: result.data, total: result.total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bans/export — the ban list as CSV: same filters, visibility (god
 * view on Default, global + own bans elsewhere) and team scope as listBans,
 * at most CSV_EXPORT_MAX rows (X-Truncated when capped). `?anon=1` masks
 * the addresses, the author and agent names.
 */
export async function exportBans(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = parseBanListFilters(query);
    const anon = wantsAnon(query);
    const mask = csvMaskers(anon);

    const result = await banService.list({
      tenantId: req.tenantId,
      isAdmin: req.session?.role === 'admin',
      ...filters,
      visibleAgentIds: await requestVisibleAgentIds(req, 'read'),
      limit: CSV_EXPORT_MAX + 1,
      offset: 0,
    });
    const truncated = result.data.length > CSV_EXPORT_MAX;
    const data = truncated ? result.data.slice(0, CSV_EXPORT_MAX) : result.data;

    await auditService.logReq(req, {
      action: 'bans.exported', targetType: 'ban',
      details: {
        rows: data.length, truncated, anon,
        filters: {
          state: filters.state, scope: filters.scope ?? null, type: filters.banType ?? null,
          search: filters.search ?? null, tenants: filters.tenantIds ?? null,
        },
      },
    });
    sendCsv(res, {
      filename: csvFilename('bans'),
      headers: ['IP', 'State', 'Type', 'Scope', 'Scope target', 'Tenant', 'Reason', 'Banned at', 'Expires at',
        'Lifted at', 'Created by', 'Excluded by this tenant', 'Origin'],
      rows: data.map((b) => [
        mask.ip(b.cidrPrefix != null && !b.ip.includes('/') ? `${b.ip}/${b.cidrPrefix}` : b.ip),
        b.state,
        b.banType,
        b.scope,
        // An agent-scoped ban names the agent: masked like a hostname.
        b.scope === 'agent' ? mask.hostname(b.scopeName) : b.scopeName,
        // Owner tenant, else (global ban, god view) the tenant it came from.
        b.tenantName ?? b.originTenantName ?? null,
        b.reason,
        csvDate(b.bannedAt),
        csvDate(b.expiresAt),
        csvDate(b.liftedAt),
        mask.username(b.createdByUsername),
        b.isExcludedByTenant === true,
        b.originApp ?? b.originRef ?? null,
      ]),
      truncated,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/bans/bulk-lift {ids[]} — 1..1000 bans, each under the single
 * Lift rule: from Default an authoritative deactivation, from another tenant
 * a local exclusion of a global ban (its own scoped bans are deactivated).
 */
export async function bulkLiftBans(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ids = parseBulkIds((req.body as { ids?: unknown } | undefined)?.ids, BULK_LIFT_MAX);
    const result = await banService.bulkLift(ids, req.tenantId, req.session?.userId ?? 0, req.session?.role === 'admin', {
      writableAgentIds: await requestVisibleAgentIds(req, 'write'),
    });
    await auditService.logReq(req, {
      action: 'bans.bulk_lifted', targetType: 'ban',
      details: { ids, lifted: result.lifted, excluded: result.excluded, skipped: result.skipped, refused: result.refused },
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function createBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as CreateBanRequest;
    const isAdmin = req.session?.role === 'admin';
    const ban = await banService.create(body, req.session?.userId ?? 0, req.tenantId, isAdmin);
    await auditService.logReq(req, {
      action: 'bans.created', targetType: 'ban', targetId: ban.id,
      deviceId: ban.scope === 'agent' ? ban.scopeId : null,
      details: {
        ip: ban.cidrPrefix != null && !ban.ip.includes('/') ? `${ban.ip}/${ban.cidrPrefix}` : ban.ip,
        scope: ban.scope, scopeId: ban.scopeId, reason: ban.reason, expiresAt: ban.expiresAt ?? null,
      },
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

    const target = await banAuditTarget(id);
    await banService.lift(id, req.tenantId, req.session?.userId ?? 0, req.session?.role === 'admin', {
      writableAgentIds: await requestVisibleAgentIds(req, 'write'),
    });
    // A global ban lifted from another tenant stays active: it became a local exclusion.
    const after = await db('ip_bans').where({ id }).first('is_active') as { is_active: boolean } | undefined;
    await auditService.logReq(req, {
      action: after?.is_active ? 'bans.excluded' : 'bans.lifted', targetType: 'ban', targetId: id,
      deviceId: target.deviceId,
      details: { ip: target.ip, scope: target.scope, scopeId: target.scopeId, via: 'lift' },
    });

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

    const target = await banAuditTarget(id);
    const ban = await banService.promoteToGlobal(id, req.tenantId, req.session?.userId ?? 0, req.session?.role === 'admin');
    await auditService.logReq(req, {
      action: 'bans.promoted', targetType: 'ban', targetId: ban.id,
      details: { ip: target.ip ?? ban.ip, fromScope: target.scope, fromScopeId: target.scopeId, sourceBanId: id },
    });

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
    const target = await banAuditTarget(id);
    await auditService.logReq(req, { action: 'bans.excluded', targetType: 'ban', targetId: id, details: { ip: target.ip, scope: target.scope } });
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
    const target = await banAuditTarget(id);
    await auditService.logReq(req, { action: 'bans.exclusion_removed', targetType: 'ban', targetId: id, details: { ip: target.ip, scope: target.scope } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
