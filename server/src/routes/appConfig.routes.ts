import { Router } from 'express';
import { appConfigController } from '../controllers/appConfig.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';

const router = Router();

// GET is available to all authenticated users (needed for profile page to check allow_2fa)
router.get('/', requireAuth, appConfigController.getAll);
// PUT is admin only
router.put('/:key', requireAuth, requireRole('admin'), appConfigController.set);

// Agent global defaults — admin only
router.get('/agent-global', requireAuth, requireRole('admin'), appConfigController.getAgentGlobal);
router.patch('/agent-global', requireAuth, requireRole('admin'), appConfigController.patchAgentGlobal);

// Obliview integration — admin only for config; any authenticated user for agent link proxy
router.get('/obliview/agent-link/:uuid', requireAuth, appConfigController.proxyObliviewAgentLink);
router.get('/obliview',   requireAuth, requireRole('admin'), appConfigController.getObliview);
router.patch('/obliview', requireAuth, requireRole('admin'), appConfigController.patchObliview);

export default router;
