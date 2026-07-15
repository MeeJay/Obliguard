import { Router } from 'express';
import { CAPABILITIES } from '@obliview/shared';
import { requireAuth } from '../middleware/auth';
import { requireCapability } from '../middleware/rbac';
import {
  listWhitelist,
  createWhitelistEntry,
  deleteWhitelistEntry,
} from '../controllers/whitelist.controller';

const router = Router();

router.get('/', requireAuth, listWhitelist);
router.post('/', requireAuth, requireCapability(CAPABILITIES.WHITELIST), createWhitelistEntry);
router.delete('/:id', requireAuth, requireCapability(CAPABILITIES.WHITELIST), deleteWhitelistEntry);

export default router;
