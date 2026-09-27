import { Router } from 'express';
import { CAPABILITIES } from '@obliview/shared';
import { requireAuth } from '../middleware/auth';
import { requireRole, requireCapability } from '../middleware/rbac';
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
// wipe-* are PLATFORM-WIDE resets: platform admin AND Default tenant (enforced in the controller).
router.post('/wipe-bans', requireAuth, requireRole('admin'), wipeAllBans);
router.post('/wipe-reputation', requireAuth, requireRole('admin'), wipeAllReputation);
// Bulk ban: scope follows the operating tenant (Default = global, others = tenant); goes through banService.create.
router.post('/bulk-ban', requireAuth, requireCapability(CAPABILITIES.BANS), bulkBan);
router.post('/bulk-whitelist', requireAuth, requireCapability(CAPABILITIES.WHITELIST), bulkWhitelist);
router.get('/', requireAuth, listBans);
router.get('/:id', requireAuth, getBanById);
router.post('/', requireAuth, requireCapability(CAPABILITIES.BANS), createBan);
router.delete('/:id', requireAuth, requireCapability(CAPABILITIES.BANS), liftBan);
// Promote to global: Default tenant only (enforced in banService.promoteToGlobal).
router.post('/:id/promote-global', requireAuth, requireCapability(CAPABILITIES.BANS), promoteBan);

// Per-tenant exclusions (a ban-management action)
router.post('/:id/exclude', requireAuth, requireCapability(CAPABILITIES.BANS), excludeBan);
router.delete('/:id/exclude', requireAuth, requireCapability(CAPABILITIES.BANS), removeExclusion);

export default router;
