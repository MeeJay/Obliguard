import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { permissionSetService } from '../services/permissionSet.service';
import { logger } from '../utils/logger';

const router = Router();

/**
 * GET /api/permission-sets
 * Returns all permission sets. Requires authentication.
 */
router.get('/', requireAuth, async (_req, res) => {
  try {
    const sets = await permissionSetService.getAll();
    res.json({ success: true, data: sets });
  } catch (err) {
    logger.error(err, 'Failed to list permission sets');
    res.status(500).json({ success: false, error: 'Failed to list permission sets' });
  }
});

/**
 * GET /api/permission-sets/capabilities
 * Returns available capabilities for this app. Requires authentication.
 */
router.get('/capabilities', requireAuth, async (_req, res) => {
  try {
    const capabilities = permissionSetService.getAvailableCapabilities();
    res.json({ success: true, data: capabilities });
  } catch (err) {
    logger.error(err, 'Failed to list capabilities');
    res.status(500).json({ success: false, error: 'Failed to list capabilities' });
  }
});

/**
 * POST /api/permission-sets
 * Creates a new permission set. Admin only.
 */
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { name, slug, capabilities } = req.body as { name: string; slug: string; capabilities: string[] };
    if (!name || !slug || !Array.isArray(capabilities)) {
      res.status(400).json({ success: false, error: 'name, slug, and capabilities[] are required' });
      return;
    }
    const set = await permissionSetService.create({ name, slug, capabilities });
    res.status(201).json({ success: true, data: set });
  } catch (err: any) {
    logger.error(err, 'Failed to create permission set');
    const status = err.message?.includes('unique') || err.code === '23505' ? 409 : 500;
    res.status(status).json({ success: false, error: err.message || 'Failed to create permission set' });
  }
});

/**
 * PUT /api/permission-sets/:id
 * Updates a permission set. Admin only.
 */
router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid ID' }); return; }
    const { name, slug, capabilities } = req.body as { name?: string; slug?: string; capabilities?: string[] };
    const set = await permissionSetService.update(id, { name, slug, capabilities });
    res.json({ success: true, data: set });
  } catch (err: any) {
    logger.error(err, 'Failed to update permission set');
    const status = err.message === 'Permission set not found' ? 404 : 500;
    res.status(status).json({ success: false, error: err.message || 'Failed to update permission set' });
  }
});

/**
 * DELETE /api/permission-sets/:id
 * Deletes a non-default permission set. Admin only.
 */
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid ID' }); return; }
    await permissionSetService.delete(id);
    res.json({ success: true });
  } catch (err: any) {
    logger.error(err, 'Failed to delete permission set');
    const status = err.message === 'Permission set not found' ? 404
      : err.message?.includes('default') ? 400
      : 500;
    res.status(status).json({ success: false, error: err.message || 'Failed to delete permission set' });
  }
});

export default router;
