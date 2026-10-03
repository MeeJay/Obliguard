import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole, requireCapability } from '../middleware/rbac';
import { requireTenant } from '../middleware/tenant';
import {
  createMikroTikDevice,
  getMikroTikCredentials,
  updateMikroTikCredentials,
  testMikroTikConnection,
  syncMikroTikBans,
  pollMikroTikImport,
  clearMikroTikLogCache,
  debugMikroTikLogs,
} from '../controllers/mikrotik.controller';

const router = Router();

// All MikroTik routes: authenticated member of the tenant holding
// integrations.mikrotik (W7-2). Every :id handler only reaches a router of the
// operating tenant (controller: requireOwnMikrotik, 403 from Default, 404 elsewhere).
router.use(requireAuth);
router.use(requireTenant);
router.use(requireCapability('integrations.mikrotik'));

router.post('/', createMikroTikDevice);
router.get('/:id/credentials', getMikroTikCredentials);
router.put('/:id/credentials', updateMikroTikCredentials);
router.post('/:id/test', testMikroTikConnection);
router.post('/:id/sync-bans', syncMikroTikBans);
router.post('/:id/clear-log-cache', clearMikroTikLogCache);
router.get('/:id/debug-logs', debugMikroTikLogs);
// Polls the address lists of every tenant's routers: platform admin only.
router.post('/import/poll', requireRole('admin'), pollMikroTikImport);

export default router;
