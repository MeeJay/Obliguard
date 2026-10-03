import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireCapability } from '../middleware/rbac';
import { listLabels, upsertLabel, deleteLabel } from '../controllers/ipDisplayNames.controller';

const router = Router();

router.get('/',       requireAuth, listLabels);
// ip.labels (W7-2): Default tenant → global labels, other tenants → their own.
router.post('/',      requireAuth, requireCapability('ip.labels'), upsertLabel);
router.delete('/:ip', requireAuth, requireCapability('ip.labels'), deleteLabel);

export default router;
