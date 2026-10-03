import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireCapability } from '../middleware/rbac';
import { requireCapabilitiesFor, ipReputationAddCapabilities } from '../middleware/routePermissions';
import {
  listReputation,
  getIpDetail,
  clearSuspicious,
  addIp,
  exportReputation,
} from '../controllers/ipReputation.controller';

const router = Router();

router.get('/', requireAuth, listReputation);

/**
 * GET /api/ip-reputation/export
 * CSV of the filtered list (same tenant scope as GET /, capped, audited).
 * Must come BEFORE the /:ip GET ('export' is not an address).
 */
router.get('/export', requireAuth, exportReputation);

/**
 * POST /api/ip-reputation
 * Manually adds an IP with a desired status, gated per target status:
 * banned → bans.create, whitelisted → whitelist.write, clean / suspicious →
 * ip.reputation.clear (scope rules in the controller).
 */
router.post('/', requireAuth, requireCapabilitiesFor(ipReputationAddCapabilities), addIp);

/**
 * POST /api/ip-reputation/:ip/clear
 * ip.reputation.clear: clears suspicious status for the operating tenant; a
 * global clear only for a platform admin operating the Default tenant.
 * Must come BEFORE the /:ip GET to avoid route conflict.
 */
router.post('/:ip/clear', requireAuth, requireCapability('ip.reputation.clear'), clearSuspicious);

/**
 * GET /api/ip-reputation/:ip
 */
router.get('/:ip', requireAuth, getIpDetail);

export default router;
