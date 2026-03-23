import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  listBans,
  createBan,
  liftBan,
  promoteBan,
  excludeBan,
  removeExclusion,
  getBanStats,
} from '../controllers/bans.controller';

const router = Router();

// ⚠️ /stats must be before /:id
router.get('/stats', requireAuth, getBanStats);
router.get('/', requireAuth, listBans);
router.post('/', requireAuth, requireRole('admin'), createBan);
router.delete('/:id', requireAuth, requireRole('admin'), liftBan);
router.post('/:id/promote-global', requireAuth, requireRole('admin'), promoteBan);

// Per-tenant exclusions
router.post('/:id/exclude', requireAuth, requireRole('admin'), excludeBan);
router.delete('/:id/exclude', requireAuth, requireRole('admin'), removeExclusion);

export default router;
