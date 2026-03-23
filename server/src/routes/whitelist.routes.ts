import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  listWhitelist,
  createWhitelistEntry,
  deleteWhitelistEntry,
} from '../controllers/whitelist.controller';

const router = Router();

router.get('/', requireAuth, listWhitelist);
router.post('/', requireAuth, requireRole('admin'), createWhitelistEntry);
router.delete('/:id', requireAuth, requireRole('admin'), deleteWhitelistEntry);

export default router;
