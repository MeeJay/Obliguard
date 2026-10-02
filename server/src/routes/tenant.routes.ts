import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { tenantService } from '../services/tenant.service';
import { AppError } from '../middleware/errorHandler';
import { userSessionsService } from '../services/userSessions.service';
import { invalidateTenant, invalidateTenantAccess } from '../middleware/tenant';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { db } from '../db';

const router = Router();

function parseId(v: unknown, what = 'id'): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError(400, `Invalid ${what}`);
  return n;
}

function parseRole(v: unknown): 'admin' | 'member' {
  if (v === 'admin' || v === 'member') return v;
  throw new AppError(400, "role must be 'admin' or 'member'");
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
    res.json({ success: true, data: tenant });
  } catch (err) {
    next(mapUniqueViolation(err));
  }
});

// ── Delete tenant (platform admin only, cannot delete tenant 1) ───────────
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === MASTER_TENANT_ID) throw new AppError(400, 'Cannot delete the default tenant');
    const memberIds = (await tenantService.getMembers(id)).map((m) => m.id);
    await tenantService.delete(id);
    invalidateTenant(id);
    // Platform-admin tabs sitting on the deleted tenant resync.
    userSessionsService.disconnectTenantSockets(id);
    for (const uid of memberIds) userSessionsService.onMembershipChanged(uid);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Tenant members ─────────────────────────────────────────────────────────
// GET /api/tenants/:id/members
router.get('/:id/members', requireRole('admin'), async (req, res, next) => {
  try {
    const tenantId = parseId(req.params.id);
    const members = await tenantService.getMembers(tenantId);
    res.json({ success: true, data: members });
  } catch (err) {
    next(err);
  }
});

// POST /api/tenants/:id/members  { userId, role }
router.post('/:id/members', requireRole('admin'), async (req, res, next) => {
  try {
    const tenantId = parseId(req.params.id);
    const body = (req.body ?? {}) as { userId?: unknown; role?: unknown };
    const userId = parseId(body.userId, 'userId');
    const role = body.role === undefined ? 'member' : parseRole(body.role);
    if (!(await tenantService.exists(tenantId))) throw new AppError(404, 'Tenant not found');
    await assertUserExists(userId);
    await tenantService.addUser(tenantId, userId, role);
    userSessionsService.onMembershipChanged(userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/tenants/:id/members/:uid  { role }
router.put('/:id/members/:uid', requireRole('admin'), async (req, res, next) => {
  try {
    const tenantId = parseId(req.params.id);
    const userId = parseId(req.params.uid, 'userId');
    const role = parseRole((req.body as { role?: unknown } | undefined)?.role);
    await tenantService.updateUserRole(tenantId, userId, role);
    userSessionsService.onMembershipChanged(userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tenants/:id/members/:uid
router.delete('/:id/members/:uid', requireRole('admin'), async (req, res, next) => {
  try {
    const tenantId = parseId(req.params.id);
    const userId = parseId(req.params.uid, 'userId');
    await tenantService.removeUser(tenantId, userId);
    // Next tenant call answers 403 at once; live sockets leave the tenant rooms.
    userSessionsService.onMembershipChanged(userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
