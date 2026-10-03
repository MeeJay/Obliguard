import { Router } from 'express';
import type { Request } from 'express';
import { requireCapability, requireRole } from '../middleware/rbac';
import { requireMasterTenant } from '../middleware/routePermissions';
import { resolveReadTenants } from '../middleware/tenant';
import { AppError } from '../middleware/errorHandler';
import { auditService, AUDIT_MAX_PAGE_SIZE } from '../services/audit.service';
import { resolveRequestAgent } from '../services/agentScope.service';
import { parsePaging, queryDate, queryString } from '../utils/pagination';

/**
 * Audit log API (W11-1), mounted on tenantRouter at /audit-log (requireAuth +
 * requireTenant + require2faSetup). Ported from Obliance routes/audit.routes.ts.
 *
 * Reads need audit.read (part of the protected 'admin' set). The Default
 * tenant reads every tenant's rows plus the instance-level ones (god view,
 * narrowed by ?tenants= chips); any other tenant reads only its own rows,
 * platform admins included (W10 decision 5).
 * Deleting rows (purge) is platform-admin only, from the Default tenant, and
 * leaves an 'audit.purged' row behind: destroying the trail is itself traced.
 */

const router = Router();

const requireAuditRead = requireCapability('audit.read');

function parseOptionalId(raw: unknown, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) {
    throw new AppError(400, `Invalid ${name}`);
  }
  return Number(raw);
}

function parseDate(raw: unknown, name: string): Date | undefined {
  const d = queryDate(raw);
  if (d === null) throw new AppError(400, `Invalid ${name}`);
  return d;
}

function parseSuccess(raw: unknown): boolean | undefined {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

function listParams(req: Request) {
  const q = req.query as Record<string, unknown>;
  const { page, pageSize } = parsePaging(q, { defaultSize: 50, max: AUDIT_MAX_PAGE_SIZE });
  return {
    tenants: resolveReadTenants(req),
    userId: parseOptionalId(q.userId, 'userId'),
    actor: queryString(q.actor, 255),
    action: queryString(q.action, 100),
    targetType: queryString(q.targetType, 50),
    targetId: queryString(q.targetId, 255),
    deviceId: parseOptionalId(q.deviceId, 'deviceId'),
    success: parseSuccess(q.success),
    from: parseDate(q.from, 'from'),
    to: parseDate(q.to, 'to'),
    search: queryString(q.search, 255),
    page,
    pageSize,
  };
}

// GET /api/audit-log?actor=&action=bans.&targetType=&targetId=&deviceId=&success=&from=&to=&search=&tenants=&page=&pageSize=
router.get('/', requireAuditRead, async (req, res, next) => {
  try {
    const result = await auditService.list(listParams(req));
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/audit-log/distinct-actions — distinct actions of the readable rows (filter dropdown)
router.get('/distinct-actions', requireAuditRead, async (req, res, next) => {
  try {
    res.json({ success: true, data: await auditService.distinctActions(resolveReadTenants(req)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/audit-log/device/:deviceId — latest rows of one agent (agent detail Activity tab).
// The agent must be readable by the caller (tenant rule + team scope, agentScope).
router.get('/device/:deviceId', requireAuditRead, async (req, res, next) => {
  try {
    const outcome = await resolveRequestAgent(req, req.params.deviceId, 'read');
    if (!outcome.ok) throw new AppError(outcome.status, outcome.error);
    const { pageSize } = parsePaging(req.query as Record<string, unknown>, { defaultSize: 100, max: AUDIT_MAX_PAGE_SIZE, sizeParam: 'limit' });
    const items = await auditService.getByDevice(outcome.agent.id, resolveReadTenants(req), pageSize);
    res.json({ success: true, data: items });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/audit-log?olderThanDays=N[&tenants=] — purge (0 or absent = every row
// of the selected tenants). Platform admin, Default tenant only.
router.delete('/', requireRole('admin'), requireMasterTenant(), async (req, res, next) => {
  try {
    const q = req.query as Record<string, unknown>;
    let olderThanDays = 0;
    if (q.olderThanDays !== undefined && q.olderThanDays !== '') {
      if (typeof q.olderThanDays !== 'string' || !/^[0-9]{1,5}$/.test(q.olderThanDays)) {
        throw new AppError(400, 'Invalid olderThanDays');
      }
      olderThanDays = Number(q.olderThanDays);
    }
    const tenants = resolveReadTenants(req);
    const deleted = await auditService.purge(tenants, olderThanDays);
    await auditService.logReq(req, {
      action: 'audit.purged',
      targetType: 'audit_log',
      tenantId: null,
      details: { deleted, olderThanDays, tenants: tenants === 'all' ? 'all' : tenants },
    });
    res.json({ success: true, data: { deleted } });
  } catch (err) {
    next(err);
  }
});

export default router;
