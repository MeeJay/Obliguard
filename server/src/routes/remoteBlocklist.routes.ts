import { Router } from 'express';
import { remoteBlocklistController } from '../controllers/remoteBlocklist.controller';

const router = Router();

router.get('/',           remoteBlocklistController.list);
router.post('/',          remoteBlocklistController.create);
router.put('/:id',        remoteBlocklistController.update);
router.delete('/:id',     remoteBlocklistController.delete);
router.post('/:id/sync',  remoteBlocklistController.forceSync);
router.get('/ips',         remoteBlocklistController.listIps);
router.put('/ips/:id/toggle', remoteBlocklistController.toggleIp);
router.get('/stats',       remoteBlocklistController.stats);
router.post('/push-now',   remoteBlocklistController.forcePush);

export default router;
