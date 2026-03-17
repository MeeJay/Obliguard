import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { listLabels, upsertLabel, deleteLabel } from '../controllers/ipDisplayNames.controller';

const router = Router();

router.get('/',       requireAuth, listLabels);
router.post('/',      requireAuth, upsertLabel);
router.delete('/:ip', requireAuth, deleteLabel);

export default router;
