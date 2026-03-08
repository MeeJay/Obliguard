import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  listReputation,
  getIpDetail,
} from '../controllers/ipReputation.controller';

const router = Router();

router.get('/', requireAuth, listReputation);
router.get('/:ip', requireAuth, getIpDetail);

export default router;
