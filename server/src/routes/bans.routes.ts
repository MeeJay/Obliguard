import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  listBans,
  createBan,
  liftBan,
  promoteBan,
  getBanStats,
} from '../controllers/bans.controller';

const router = Router();

// ⚠️ /stats must be before /:id
router.get('/stats', requireAuth, getBanStats);
router.get('/', requireAuth, listBans);
router.post('/', requireAuth, createBan);
router.delete('/:id', requireAuth, liftBan);
router.post('/:id/promote-global', requireAuth, requireRole('admin'), promoteBan);

export default router;
