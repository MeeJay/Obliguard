import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { isMasterTenant } from '@obliview/shared';
import { remoteBlocklistController } from '../controllers/remoteBlocklist.controller';
import { requireRole } from '../middleware/rbac';
import { AppError } from '../middleware/errorHandler';

const router = Router();

/**
 * Remote blocklists are an instance setting (owner decision 6): writes are
 * reserved to the platform admin operating the Default tenant. Reads stay
 * open to members (tenant-filtered by the service).
 */
function requireDefaultTenant(req: Request, _res: Response, next: NextFunction): void {
  if (!isMasterTenant(req.tenantId)) {
    next(new AppError(403, 'Remote blocklists can only be managed from the Default tenant'));
    return;
  }
  next();
}

const write = [requireRole('admin'), requireDefaultTenant];

router.get('/',           remoteBlocklistController.list);
router.post('/',          ...write, remoteBlocklistController.create);
router.put('/:id',        ...write, remoteBlocklistController.update);
router.delete('/:id',     ...write, remoteBlocklistController.delete);
router.post('/:id/sync',  ...write, remoteBlocklistController.forceSync);
router.get('/ips',         remoteBlocklistController.listIps);
router.put('/ips/:id/toggle',  ...write, remoteBlocklistController.toggleIp);
router.post('/ips/:id/toggle', ...write, remoteBlocklistController.toggleIp);
router.get('/stats',       remoteBlocklistController.stats);
router.post('/push-now',   ...write, remoteBlocklistController.forcePush);

export default router;
