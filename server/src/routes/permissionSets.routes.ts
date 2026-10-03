import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { requireStepUp } from '../middleware/stepUp';
import { AppError } from '../middleware/errorHandler';
import { permissionSetService } from '../services/permissionSet.service';
import { auditService } from '../services/audit.service';
import { MASTER_TENANT_ID } from '@obliview/shared';

const router = Router();

/**
 * Permission sets are the tenant roles (user_tenants.role = slug). They are
 * shared by every tenant: reads are open to any signed-in user (role
 * pickers), writes are platform-admin only. The admin / user / viewer sets
 * cannot be renamed or deleted.
 */

function parseId(v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError(400, 'Invalid ID');
  return n;
}

/**
 * GET /api/permission-sets
 * Returns all permission sets.
 */
router.get('/', requireAuth, async (_req, res, next) => {
  try {
    res.json({ success: true, data: await permissionSetService.getAll() });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/permission-sets/capabilities
 * The capability catalogue (key, category, label) from shared TENANT_CAPABILITIES.
 */
router.get('/capabilities', requireAuth, (_req, res) => {
  res.json({ success: true, data: permissionSetService.getAvailableCapabilities() });
});

/**
 * POST /api/permission-sets  { name, slug, capabilities[] }
 * Creates a permission set. Platform admin only.
 */
router.post('/', requireAuth, requireRole('admin'), requireStepUp('users.role'), async (req, res, next) => {
  try {
    const { name, slug, capabilities } = (req.body ?? {}) as { name?: unknown; slug?: unknown; capabilities?: unknown };
    const set = await permissionSetService.create({ name, slug, capabilities: capabilities ?? [] });
    // Permission sets are shared by every tenant: rows filed in the Default tenant.
    await auditService.logReq(req, {
      action: 'permission_set.created', targetType: 'permission_set', targetId: set.id, tenantId: MASTER_TENANT_ID,
      details: { name: set.name, slug: set.slug, capabilities: set.capabilities },
    });
    res.status(201).json({ success: true, data: set });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/permission-sets/:id  { name?, slug?, capabilities? }
 * Updates a permission set. Platform admin only.
 */
router.put('/:id', requireAuth, requireRole('admin'), requireStepUp('users.role'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { name, slug, capabilities } = (req.body ?? {}) as { name?: unknown; slug?: unknown; capabilities?: unknown };
    const before = (await permissionSetService.getAll()).find((s) => s.id === id) ?? null;
    const set = await permissionSetService.update(id, { name, slug, capabilities });
    await auditService.logReq(req, {
      action: 'permission_set.updated', targetType: 'permission_set', targetId: id, tenantId: MASTER_TENANT_ID,
      details: {
        name: set.name, slug: set.slug,
        ...(capabilities !== undefined ? {
          added: set.capabilities.map(String).filter((c) => !(before?.capabilities ?? []).map(String).includes(c)),
          removed: (before?.capabilities ?? []).map(String).filter((c) => !set.capabilities.map(String).includes(c)),
        } : {}),
      },
    });
    res.json({ success: true, data: set });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/permission-sets/:id
 * Deletes a custom permission set no membership holds. Platform admin only.
 */
router.delete('/:id', requireAuth, requireRole('admin'), requireStepUp('users.role'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const before = (await permissionSetService.getAll()).find((s) => s.id === id) ?? null;
    await permissionSetService.delete(id);
    await auditService.logReq(req, {
      action: 'permission_set.deleted', targetType: 'permission_set', targetId: id, tenantId: MASTER_TENANT_ID,
      details: { name: before?.name ?? null, slug: before?.slug ?? null },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
