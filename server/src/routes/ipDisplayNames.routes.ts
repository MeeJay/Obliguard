import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { listLabels, upsertLabel, deleteLabel } from '../controllers/ipDisplayNames.controller';

const router = Router();

router.get('/',       requireAuth, listLabels);
router.post('/',      requireAuth, requireRole('admin'), upsertLabel);
router.delete('/:ip', requireAuth, requireRole('admin'), deleteLabel);

export default router;
