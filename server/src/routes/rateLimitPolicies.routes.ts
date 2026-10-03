import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole, requireCapability } from '../middleware/rbac';
import {
  listRateLimitPolicies,
  createRateLimitPolicy,
  updateRateLimitPolicy,
  deleteRateLimitPolicy,
  getRateLimitEnforcement,
  setRateLimitEnforcement,
} from '../controllers/rateLimitPolicy.controller';

const router = Router();

// Policies: rate_limit.write (W7-2). The service binds them to the operating
// tenant (global policies from the Default tenant only, group/agent targets of
// the tenant, owner-only edits).
const canWritePolicies = requireCapability('rate_limit.write');

router.get('/', requireAuth, listRateLimitPolicies);
router.post('/', requireAuth, canWritePolicies, createRateLimitPolicy);
// Global enforcement switch (W4-5): read by every member, written by the
// platform admin operating the Default tenant (checked in the controller).
router.get('/enforcement', requireAuth, getRateLimitEnforcement);
router.put('/enforcement', requireAuth, requireRole('admin'), setRateLimitEnforcement);
router.patch('/:id', requireAuth, canWritePolicies, updateRateLimitPolicy);
router.delete('/:id', requireAuth, canWritePolicies, deleteRateLimitPolicy);

export default router;
