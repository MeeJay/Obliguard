import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  listWhitelist,
  createWhitelistEntry,
  deleteWhitelistEntry,
} from '../controllers/whitelist.controller';

const router = Router();

router.get('/', requireAuth, listWhitelist);
router.post('/', requireAuth, createWhitelistEntry);
router.delete('/:id', requireAuth, deleteWhitelistEntry);

export default router;
