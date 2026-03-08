import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  listBans,
  createBan,
  liftBan,
  promoteBan,
} from '../controllers/bans.controller';

const router = Router();

router.get('/', requireAuth, listBans);
router.post('/', requireAuth, createBan);
router.delete('/:id', requireAuth, liftBan);
router.post('/:id/promote-global', requireAuth, requireRole('admin'), promoteBan);

export default router;
