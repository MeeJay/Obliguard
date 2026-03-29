import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  listBans,
  getBanById,
  createBan,
  liftBan,
  promoteBan,
  excludeBan,
  removeExclusion,
  getBanStats,
  wipeAllBans,
  wipeAllReputation,
  bulkBan,
  bulkWhitelist,
} from '../controllers/bans.controller';

const router = Router();

// ⚠️ /stats and /wipe-* must be before /:id
router.get('/stats', requireAuth, getBanStats);
router.post('/wipe-bans', requireAuth, requireRole('admin'), wipeAllBans);
router.post('/wipe-reputation', requireAuth, requireRole('admin'), wipeAllReputation);
router.post('/bulk-ban', requireAuth, requireRole('admin'), bulkBan);
router.post('/bulk-whitelist', requireAuth, requireRole('admin'), bulkWhitelist);
router.get('/', requireAuth, listBans);
router.get('/:id', requireAuth, getBanById);
router.post('/', requireAuth, requireRole('admin'), createBan);
router.delete('/:id', requireAuth, requireRole('admin'), liftBan);
router.post('/:id/promote-global', requireAuth, requireRole('admin'), promoteBan);

// Per-tenant exclusions
router.post('/:id/exclude', requireAuth, requireRole('admin'), excludeBan);
router.delete('/:id/exclude', requireAuth, requireRole('admin'), removeExclusion);

export default router;
