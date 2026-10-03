import { Router } from 'express';
import { remoteBlocklistController } from '../controllers/remoteBlocklist.controller';
import { requireRole } from '../middleware/rbac';
import { requireStepUp } from '../middleware/stepUp';
import { requireMasterTenant } from '../middleware/routePermissions';

const router = Router();

/**
 * Remote blocklists are an instance setting (owner decision 6): writes are
 * reserved to the platform admin operating the Default tenant (bans they
 * import are global). The 'remote_blocklists' tenant capability is therefore
 * not honoured on its own here; reads stay open to members (tenant-filtered
 * by the service).
 */
const write = [
  requireRole('admin'),
  requireMasterTenant('Remote blocklists can only be managed from the Default tenant'),
];
/**
 * Configuration writes (create / edit / delete a list, toggle an imported IP)
 * also need a fresh step-up (middleware/stepUp.ts): a list can import global
 * bans. Sync / push-now only run the stored configuration.
 */
const configWrite = [...write, requireStepUp('remoteBlocklists.write')];

router.get('/',           remoteBlocklistController.list);
router.post('/',          ...configWrite, remoteBlocklistController.create);
router.put('/:id',        ...configWrite, remoteBlocklistController.update);
router.delete('/:id',     ...configWrite, remoteBlocklistController.delete);
router.post('/:id/sync',  ...write, remoteBlocklistController.forceSync);
router.get('/ips',         remoteBlocklistController.listIps);
router.put('/ips/:id/toggle',  ...configWrite, remoteBlocklistController.toggleIp);
router.post('/ips/:id/toggle', ...configWrite, remoteBlocklistController.toggleIp);
router.get('/stats',       remoteBlocklistController.stats);
router.post('/push-now',   ...write, remoteBlocklistController.forcePush);

export default router;
