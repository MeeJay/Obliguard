import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { tenantService, tenantDeleteConfig, TenantHasAgentsError } from '../services/tenant.service';
import { permissionSetService } from '../services/permissionSet.service';
import { permissionService } from '../services/permission.service';
import { actorFromReq, type ScopeActor } from '../services/userScope.service';
import { setTenantMembership } from '../services/userAdmin.service';
import { AppError } from '../middleware/errorHandler';
import { userSessionsService } from '../services/userSessions.service';
import { auditService } from '../services/audit.service';
import { invalidateTenant, invalidateTenantAccess } from '../middleware/tenant';
import { requireStepUp } from '../middleware/stepUp';
import { obliguardHub } from '../services/obliguardHub.service';
import { mikrotikBanSync } from '../services/mikrotik/mikrotikBanSync.service';
import { logger } from '../utils/logger';
import { MASTER_TENANT_ID, TENANT_ROLE_DEFAULT } from '@obliview/shared';
import { db } from '../db';

const router = Router();

function parseId(v: unknown, what = 'id'): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError(400, `Invalid ${what}`);
  return n;
}

/**
 * A tenant role: 'admin' or the slug of an existing permission set; the
 * legacy 'member' is accepted as an alias of 'user' (400 otherwise).
 */
function parseRole(v: unknown): Promise<string> {
  return permissionSetService.resolveRole(v);
}

/** A unique violation (duplicate slug / name) is a 409, not a 500 (BROKEN-5). */
function mapUniqueViolation(err: unknown): unknown {
  const pg = err as { code?: string; constraint?: string } | null;
  if (pg?.code === '23505') {
    return /slug/.test(pg.constraint ?? '')
      ? new AppError(409, 'A tenant with this slug already exists', 'tenantSlugTaken')
      : new AppError(409, 'This tenant already exists', 'tenantConflict');
  }
  return err;
}

async function assertUserExists(id: number): Promise<void> {
  if (!(await db('users').where({ id }).first('id'))) throw new AppError(404, 'User not found');
}

// All tenant routes require auth
router.use(requireAuth);

// ── Tenant switch ──────────────────────────────────────────────────────────
// POST /api/tenant/switch  { tenantId: number }
router.post('/switch', async (req, res, next) => {
  try {
    const tenantId = (req.body as { tenantId?: unknown } | undefined)?.tenantId;
    if (typeof tenantId !== 'number' || !Number.isSafeInteger(tenantId) || tenantId <= 0) {
      throw new AppError(400, 'tenantId is required');
    }

    const userId = req.session.userId!;

    // Platform admins can switch to any existing tenant; others only to their own
    if (req.session.role === 'admin') {
      if (!(await tenantService.exists(tenantId))) throw new AppError(404, 'Tenant not found');
    } else {
      const hasAccess = await tenantService.userHasAccess(userId, tenantId);
      if (!hasAccess) throw new AppError(403, 'Access denied to this tenant');
      // The DB answer wins over a cached negative (e.g. membership just granted).
      invalidateTenantAccess(userId);
    }

    req.session.currentTenantId = tenantId;
    res.json({ success: true, data: { currentTenantId: tenantId } });
  } catch (err) {
    next(err);
  }
});

// ── Favourite tenant ───────────────────────────────────────────────────────
// POST /api/tenant/default  { tenantId: number | null }
// The favourite workspace opens at sign-in (tenantService.resolveLoginTenant);
// null clears it. Platform admins: any existing tenant; others: members only.
router.post('/default', async (req, res, next) => {
  try {
    const raw = (req.body as { tenantId?: unknown } | undefined)?.tenantId;
    const userId = req.session.userId!;
    let tenantId: number | null = null;
    if (raw !== null) {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
        throw new AppError(400, 'tenantId must be a tenant id or null');
      }
      tenantId = raw;
      const allowed = req.session.role === 'admin'
        ? await tenantService.exists(tenantId)
        : await tenantService.userHasAccess(userId, tenantId);
      if (!allowed) throw new AppError(403, 'Access denied to this tenant');
    }
    await tenantService.setPreferredTenant(userId, tenantId);
    res.json({ success: true, data: { preferredTenantId: tenantId } });
  } catch (err) {
    next(err);
  }
});

// ── List tenants ───────────────────────────────────────────────────────────
// GET /api/tenants  (admin: all, user: their tenants with role)
router.get('/', async (req, res, next) => {
  try {
    const userId = req.session.userId!;
    const isAdmin = req.session.role === 'admin';

    if (isAdmin) {
      const tenants = await tenantService.getAll();
      res.json({ success: true, data: tenants });
    } else {
      const tenants = await tenantService.getTenantsForUser(userId);
      res.json({ success: true, data: tenants });
    }
  } catch (err) {
    next(err);
  }
});

// ── Create tenant (platform admin only) ───────────────────────────────────
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, slug } = req.body as { name: string; slug: string };
    if (!name || !slug) throw new AppError(400, 'name and slug are required');
    const tenant = await tenantService.create({ name, slug });
    invalidateTenant(tenant.id);
    // Tenant lifecycle rows live in the Default tenant (they outlive a deleted tenant).
    await auditService.logReq(req, {
      action: 'tenant.created', targetType: 'tenant', targetId: tenant.id, tenantId: MASTER_TENANT_ID,
      details: { name: tenant.name, slug: tenant.slug },
    });
    res.status(201).json({ success: true, data: tenant });
  } catch (err) {
    next(mapUniqueViolation(err));
  }
});

// ── Get one tenant ─────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const tenant = await tenantService.getById(id);
    if (!tenant) throw new AppError(404, 'Tenant not found');

    // Non-admins can only see their own tenants
    if (req.session.role !== 'admin') {
      const hasAccess = await tenantService.userHasAccess(req.session.userId!, id);
      if (!hasAccess) throw new AppError(403, 'Access denied');
    }

    res.json({ success: true, data: tenant });
  } catch (err) {
    next(err);
  }
});

// ── Update tenant (platform admin only) ───────────────────────────────────
router.put('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { name, slug } = req.body as { name?: string; slug?: string };
    const tenant = await tenantService.update(id, { name, slug });
    if (!tenant) throw new AppError(404, 'Tenant not found');
    await auditService.logReq(req, {
      action: 'tenant.updated', targetType: 'tenant', targetId: id, tenantId: MASTER_TENANT_ID,
      details: { name: tenant.name, slug: tenant.slug, fields: Object.keys(req.body ?? {}) },
    });
    res.json({ success: true, data: tenant });
  } catch (err) {
    next(mapUniqueViolation(err));
  }
});

// ── Delete tenant (platform admin only, cannot delete tenant 1) ───────────
// Owner decision 13 (C13): the deletion is refused (409 TENANT_HAS_AGENTS)
// while enrolled agents remain, unless TENANT_DELETE_AGENT_POLICY is
// 'uninstall'. The admin types the tenant name (body.confirmName) and
// confirms with a step-up. The tenant's routers lose their Obliguard entries
// first, then every tenant-owned row goes in one transaction.

/** Positive tenant id of the path other than Default, else null (the handler answers). */
function deletableTenantId(req: Request): number | null {
  const n = Number(req.params.id);
  return Number.isSafeInteger(n) && n > 0 && n !== MASTER_TENANT_ID ? n : null;
}

function confirmNameOf(req: Request): string | null {
  const v = (req.body as { confirmName?: unknown } | undefined)?.confirmName;
  return typeof v === 'string' ? v.trim() : null;
}

/**
 * Step-up predicate: only a deletion that will go ahead asks for the proof
 * (existing tenant, matching name, no agent blocking it). A refused request
 * keeps its own 400/403/404/409 with no prompt.
 */
async function isDeletionAllowed(req: Request): Promise<boolean> {
  const allowed = await (async () => {
    const id = deletableTenantId(req);
    if (id === null) return false;
    const tenant = await tenantService.getById(id);
    if (!tenant || confirmNameOf(req) !== tenant.name.trim()) return false;
    if (tenantDeleteConfig.agentPolicy === 'uninstall') return true;
    return (await tenantService.agentSummary(id)).total === 0;
  })();
  if (!allowed) deleteStepUpSkipped.add(req);
  return allowed;
}

/**
 * Requests whose gate skipped the prompt (predicate false). The handler reads
 * the state again: when it would delete after all (agents removed, tenant
 * renamed between the two reads), it runs the gate inline instead of
 * deleting without a proof.
 */
const deleteStepUpSkipped = new WeakSet<Request>();
const deleteStepUpGate = requireStepUp('tenant.delete');

/** Runs the tenant.delete gate inline: true when it let the request through, false when it answered. */
function passDeleteStepUp(req: Request, res: Response): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const done = deleteStepUpGate(req, res, (err?: unknown) => (err ? reject(err) : resolve(true))) as unknown;
    Promise.resolve(done).then(() => resolve(false), reject);
  });
}

function tenantHasAgents(res: Response, count: number): void {
  res.status(409).json({
    success: false,
    error: `This workspace still has ${count} agent(s). Uninstall them first.`,
    code: 'TENANT_HAS_AGENTS',
    count,
  });
}

/** Tenant of the path for the lifecycle routes: 403 Default, 404 unknown. */
async function lifecycleTenant(req: Request) {
  const id = parseId(req.params.id);
  if (id === MASTER_TENANT_ID) throw new AppError(403, 'The default tenant cannot be deleted', 'defaultTenant');
  const tenant = await tenantService.getById(id);
  if (!tenant) throw new AppError(404, 'Tenant not found');
  return tenant;
}

// GET /api/tenants/:id/agents-summary — what blocks a deletion (agent counts).
router.get('/:id/agents-summary', requireRole('admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await tenantService.exists(id))) throw new AppError(404, 'Tenant not found');
    res.json({ success: true, data: { ...(await tenantService.agentSummary(id)), policy: tenantDeleteConfig.agentPolicy } });
  } catch (err) {
    next(err);
  }
});

// POST /api/tenants/:id/uninstall-agents — queue 'uninstall' on every approved
// agent of the tenant (delivered now to connected agents, at reconnection to
// the others). The rows disappear once the agents acknowledged (cleanup job).
router.post('/:id/uninstall-agents', requireRole('admin'), requireStepUp('agents.uninstall', (req) => deletableTenantId(req) !== null), async (req, res, next) => {
  try {
    const tenant = await lifecycleTenant(req);
    const queued = await tenantService.queueUninstallAll(tenant.id);
    const delivered = queued.length > 0 ? await obliguardHub.deliverUninstallToTenant(tenant.id) : 0;
    const summary = await tenantService.agentSummary(tenant.id);
    await auditService.logReq(req, {
      action: 'tenant.agents_uninstall_requested', targetType: 'tenant', targetId: tenant.id, tenantId: MASTER_TENANT_ID,
      details: { name: tenant.name, queued: queued.length, delivered, suspended: summary.suspended, deviceIds: queued.slice(0, 500) },
    });
    res.json({ success: true, data: { queued: queued.length, delivered, summary } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tenants/:id  { confirmName }
router.delete('/:id', requireRole('admin'), requireStepUp('tenant.delete', isDeletionAllowed), async (req, res, next) => {
  try {
    const tenant = await lifecycleTenant(req);
    const id = tenant.id;
    if (confirmNameOf(req) !== tenant.name.trim()) {
      throw new AppError(400, 'Type the workspace name to confirm the deletion', 'TENANT_CONFIRM_MISMATCH');
    }
    const policy = tenantDeleteConfig.agentPolicy;
    const before = await tenantService.agentSummary(id);
    if (policy === 'refuse' && before.total > 0) { tenantHasAgents(res, before.total); return; }
    // The gate skipped the prompt on an earlier read: never delete without it.
    if (deleteStepUpSkipped.has(req) && !(await passDeleteStepUp(req, res))) return;

    // 'uninstall' policy: connected agents get the command before their
    // channel closes; offline ones stay installed, locked out (key deleted).
    let uninstall: { queued: number; delivered: number } | null = null;
    if (policy === 'uninstall' && before.total > 0) {
      const queued = await tenantService.queueUninstallAll(id);
      uninstall = { queued: queued.length, delivered: await obliguardHub.deliverUninstallToTenant(id) };
    }

    // Routers first: their credentials go with their rows.
    const routers = before.routers > 0 ? await mikrotikBanSync.purgeTenant(id) : null;

    const memberIds = (await tenantService.getMembers(id)).map((m) => m.id);
    let counts;
    try {
      counts = await tenantService.deleteWithData(id, policy);
    } catch (err) {
      // An agent enrolled between the check above and the row lock.
      if (err instanceof TenantHasAgentsError) { tenantHasAgents(res, err.count); return; }
      throw err;
    }
    if (!counts) throw new AppError(404, 'Tenant not found');

    const closed = obliguardHub.closeByTenant(id);
    invalidateTenant(id);
    await auditService.logReq(req, {
      action: 'tenant.deleted', targetType: 'tenant', targetId: id, tenantId: MASTER_TENANT_ID,
      details: {
        name: tenant.name, slug: tenant.slug, members: memberIds.length, policy,
        agents: before.total, uninstall, channelsClosed: closed,
        routers: routers ? { devices: routers.devices, removed: routers.removed, failed: routers.failed } : null,
        rows: counts,
      },
    });
    if (routers && routers.failed.length > 0) {
      logger.warn({ tenantId: id, failed: routers.failed }, 'Tenant deleted: some MikroTik routers kept their Obliguard entries');
    }
    // Platform-admin tabs sitting on the deleted tenant resync.
    userSessionsService.disconnectTenantSockets(id);
    for (const uid of memberIds) userSessionsService.onMembershipChanged(uid);
    res.json({
      success: true,
      data: {
        uninstall,
        routers: routers ? { devices: routers.devices, removed: routers.removed, failed: routers.failed.length } : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Tenant members ─────────────────────────────────────────────────────────
// Platform admins manage the members of any tenant (unchanged). A holder of
// users.manage IN THAT TENANT (tenant admin, custom set) manages its local
// members under the domination rules of services/userScope.service.ts: never
// a platform admin nor an SSO (og_) account (Obligate pushes their role),
// never itself, only a role whose capabilities it holds ('admin' only as a
// tenant admin), and only accounts that are already members (bringing an
// existing account into a tenant stays a platform operation).

/** Platform admin, or users.manage held in the tenant of the path (403 otherwise). */
function requireMembersManager() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') { next(); return; }
      const tenantId = Number(req.params.id);
      const ok = Number.isSafeInteger(tenantId) && tenantId > 0
        && await permissionService.hasCapability(req.session.userId!, false, tenantId, 'users.manage');
      if (!ok) { next(new AppError(403, 'Insufficient permissions')); return; }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The delegated actor of a members route (operating on the tenant of the path). */
function delegatedActor(req: Request, tenantId: number): ScopeActor | null {
  return req.session.role === 'admin' ? null : actorFromReq(req, tenantId);
}

// GET /api/tenants/:id/members
router.get('/:id/members', requireMembersManager(), async (req, res, next) => {
  try {
    const tenantId = parseId(req.params.id);
    const members = await tenantService.getMembers(tenantId);
    res.json({ success: true, data: members });
  } catch (err) {
    next(err);
  }
});

// Role writes confirm with a step-up (W11-2, users.role), after the guard.
const memberRoleStepUp = requireStepUp('users.role');

// POST /api/tenants/:id/members  { userId, role }
router.post('/:id/members', requireMembersManager(), memberRoleStepUp, async (req, res, next) => {
  try {
    const tenantId = parseId(req.params.id);
    const body = (req.body ?? {}) as { userId?: unknown; role?: unknown };
    const userId = parseId(body.userId, 'userId');
    const role = body.role === undefined ? TENANT_ROLE_DEFAULT : await parseRole(body.role);
    if (!(await tenantService.exists(tenantId))) throw new AppError(404, 'Tenant not found');
    const actor = delegatedActor(req, tenantId);
    if (actor) {
      await setTenantMembership(actor, userId, role);
    } else {
      await assertUserExists(userId);
      await tenantService.addUser(tenantId, userId, role);
      userSessionsService.onMembershipChanged(userId);
    }
    await auditService.logReq(req, {
      action: 'tenant.member_added', targetType: 'user', targetId: userId, tenantId,
      details: { role },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/tenants/:id/members/:uid  { role }
router.put('/:id/members/:uid', requireMembersManager(), memberRoleStepUp, async (req, res, next) => {
  try {
    const tenantId = parseId(req.params.id);
    const userId = parseId(req.params.uid, 'userId');
    const role = await parseRole((req.body as { role?: unknown } | undefined)?.role);
    const actor = delegatedActor(req, tenantId);
    if (actor) {
      await setTenantMembership(actor, userId, role);
    } else {
      await tenantService.updateUserRole(tenantId, userId, role);
      userSessionsService.onMembershipChanged(userId);
    }
    await auditService.logReq(req, {
      action: 'tenant.member_role_changed', targetType: 'user', targetId: userId, tenantId,
      details: { role },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tenants/:id/members/:uid
router.delete('/:id/members/:uid', requireMembersManager(), async (req, res, next) => {
  try {
    const tenantId = parseId(req.params.id);
    const userId = parseId(req.params.uid, 'userId');
    const actor = delegatedActor(req, tenantId);
    if (actor) {
      await setTenantMembership(actor, userId, null);
    } else {
      await tenantService.removeUser(tenantId, userId);
      // Next tenant call answers 403 at once; live sockets leave the tenant rooms.
      userSessionsService.onMembershipChanged(userId);
    }
    await auditService.logReq(req, { action: 'tenant.member_removed', targetType: 'user', targetId: userId, tenantId });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
