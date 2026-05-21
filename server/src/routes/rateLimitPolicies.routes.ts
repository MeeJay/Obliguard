import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  listRateLimitPolicies,
  createRateLimitPolicy,
  deleteRateLimitPolicy,
} from '../controllers/rateLimitPolicy.controller';

const router = Router();

router.get('/', requireAuth, listRateLimitPolicies);
router.post('/', requireAuth, requireRole('admin'), createRateLimitPolicy);
router.delete('/:id', requireAuth, requireRole('admin'), deleteRateLimitPolicy);

export default router;
