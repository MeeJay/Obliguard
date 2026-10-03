import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole, requireCapability } from '../middleware/rbac';
import { requireMasterTenant } from '../middleware/routePermissions';
import { requireStepUp, isGlobalLift, isGlobalBulkLift, isActiveBan, operatingDefault } from '../middleware/stepUp';
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
  bulkLiftBans,
  exportBans,
} from '../controllers/bans.controller';

const router = Router();

// ⚠️ /stats, /export and /wipe-* must be before /:id
router.get('/stats', requireAuth, getBanStats);
// CSV of the filtered list (same visibility and team scope as GET /, capped, audited).
router.get('/export', requireAuth, exportBans);
// One capability per route (route-to-capability matrix: middleware/routePermissions.ts).
const canCreateBans = requireCapability('bans.create');
const canLiftBans = requireCapability('bans.lift');

// wipe-* are PLATFORM-WIDE resets: platform admin (bans.wipe) AND Default tenant (enforced in the controller).
// wipe-bans and DELETE /:id (Lift) deactivate through banService.deactivateBans (lifted_at, ban:lifted, MikroTik).
// Step-up (middleware/stepUp.ts, owner decision 14): wipes, the global Lift
// branch, promote and global whitelisting need a fresh second factor (or the
// password of an account without one), after the role / capability checks
// and only when the write can happen (wipes: from Default; outside it the
// controller refuses without a prompt).
router.post('/wipe-bans', requireAuth, requireRole('admin'), requireCapability('bans.wipe'),
  requireStepUp('bans.wipe', operatingDefault), wipeAllBans);
router.post('/wipe-reputation', requireAuth, requireRole('admin'), requireCapability('bans.wipe'),
  requireStepUp('ipReputation.wipe', operatingDefault), wipeAllReputation);
// Bulk ban: scope follows the operating tenant (Default = global, others = tenant); goes through banService.create.
router.post('/bulk-ban', requireAuth, canCreateBans, bulkBan);
// From Default the entries are global (whitelist.global step-up); elsewhere tenant-local.
router.post('/bulk-whitelist', requireAuth, requireCapability('whitelist.write'),
  requireStepUp('whitelist.global', operatingDefault), bulkWhitelist);
// Bulk Lift: the single Lift rule per row (Default = global deactivation, others = local exclusion).
router.post('/bulk-lift', requireAuth, canLiftBans, requireStepUp('bans.liftGlobal', isGlobalBulkLift), bulkLiftBans);
router.get('/', requireAuth, listBans);
router.get('/:id', requireAuth, getBanById);
router.post('/', requireAuth, canCreateBans, createBan);
// Lift: tenant-local for tenant members; a global Lift is Default-only (banService.lift).
router.delete('/:id', requireAuth, canLiftBans, requireStepUp('bans.liftGlobal', isGlobalLift), liftBan);
// Promote to global: bans.promote, from the Default tenant only (also enforced in banService.promoteToGlobal).
router.post('/:id/promote-global', requireAuth, requireCapability('bans.promote'),
  requireMasterTenant('Bans can only be promoted to global from the Default tenant'), requireStepUp('bans.promote', isActiveBan), promoteBan);

// Per-tenant exclusions (a ban-management action)
router.post('/:id/exclude', requireAuth, canLiftBans, excludeBan);
router.delete('/:id/exclude', requireAuth, canLiftBans, removeExclusion);

export default router;
