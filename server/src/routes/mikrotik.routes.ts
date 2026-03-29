import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
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

// All MikroTik routes require authenticated admin with tenant
router.use(requireAuth);
router.use(requireTenant);
router.use(requireRole('admin'));

router.post('/', createMikroTikDevice);
router.get('/:id/credentials', getMikroTikCredentials);
router.put('/:id/credentials', updateMikroTikCredentials);
router.post('/:id/test', testMikroTikConnection);
router.post('/:id/sync-bans', syncMikroTikBans);
router.post('/:id/clear-log-cache', clearMikroTikLogCache);
router.get('/:id/debug-logs', debugMikroTikLogs);
router.post('/import/poll', pollMikroTikImport);

export default router;
