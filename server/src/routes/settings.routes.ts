import { Router } from 'express';
import { settingsController as c } from '../controllers/settings.controller';
import { requireAuth } from '../middleware/auth';
import { requireCapability, requireRole } from '../middleware/rbac';
import { requireMasterTenant } from '../middleware/routePermissions';

const router = Router();

router.use(requireAuth);

// IPS settings cascade (W13-1): settings rows are tenant-scoped, each level
// has its own guard (middleware/routePermissions.ts):
//   global  platform admin (writes from the Default tenant only)
//   tenant  'settings' capability on the operating tenant
//   group   groups.manage + RW on the group (controller)
//   agent   agents.manage + RW on the agent (controller)
// Reads below global: any member, scope access checked by the controller.
// The Obliview /monitor scope is gone.
const platform = requireRole('admin');
const fromDefault = requireMasterTenant('Switch to the Default tenant to change the global settings');

router.get('/global/resolved', platform, c.getResolved('global'));
router.get('/tenant/resolved', c.getResolved('tenant'));
router.get('/group/:scopeId/resolved', c.getResolved('group'));
router.get('/agent/:scopeId/resolved', c.getResolved('agent'));

router.put('/global/:scopeId', platform, fromDefault, c.set('global'));
router.put('/global/:scopeId/bulk', platform, fromDefault, c.set('global', true));
router.delete('/global/:scopeId/:key', platform, fromDefault, c.reset('global'));

const tenantGuard = requireCapability('settings');
router.put('/tenant/:scopeId', tenantGuard, c.set('tenant'));
router.put('/tenant/:scopeId/bulk', tenantGuard, c.set('tenant', true));
router.delete('/tenant/:scopeId/:key', tenantGuard, c.reset('tenant'));

const groupGuard = requireCapability('groups.manage');
router.put('/group/:scopeId', groupGuard, c.set('group'));
router.put('/group/:scopeId/bulk', groupGuard, c.set('group', true));
router.delete('/group/:scopeId/:key', groupGuard, c.reset('group'));

const agentGuard = requireCapability('agents.manage');
router.put('/agent/:scopeId', agentGuard, c.set('agent'));
router.put('/agent/:scopeId/bulk', agentGuard, c.set('agent', true));
router.delete('/agent/:scopeId/:key', agentGuard, c.reset('agent'));

export default router;
