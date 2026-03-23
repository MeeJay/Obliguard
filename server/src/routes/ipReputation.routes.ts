import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  listReputation,
  getIpDetail,
  clearSuspicious,
} from '../controllers/ipReputation.controller';

const router = Router();

router.get('/', requireAuth, listReputation);

/**
 * POST /api/ip-reputation/:ip/clear
 * Clears suspicious status for the calling tenant (or globally for admins).
 * Must come BEFORE the /:ip GET to avoid route conflict.
 */
router.post('/:ip/clear', requireAuth, requireRole('admin'), clearSuspicious);

/**
 * GET /api/ip-reputation/:ip
 */
router.get('/:ip', requireAuth, getIpDetail);

export default router;
