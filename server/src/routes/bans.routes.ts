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
router.post('/', requireAuth, createBan);
router.delete('/:id', requireAuth, liftBan);
router.post('/:id/promote-global', requireAuth, requireRole('admin'), promoteBan);

// Per-tenant exclusions: any authenticated user can exclude/re-include a global ban
router.post('/:id/exclude', requireAuth, excludeBan);
router.delete('/:id/exclude', requireAuth, removeExclusion);

export default router;
