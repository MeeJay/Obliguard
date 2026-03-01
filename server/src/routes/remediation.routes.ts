import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  listActions,
  createAction,
  updateAction,
  deleteAction,
  getBindings,
  getResolved,
  addBinding,
  updateBinding,
  deleteBinding,
  getRuns,
} from '../controllers/remediation.controller';

const router = Router();

router.use(requireAuth);

// ── Actions (admin only) ──────────────────────────────────────────────────────
router.get('/actions',     requireRole('admin'), listActions);
router.post('/actions',    requireRole('admin'), createAction);
router.put('/actions/:id', requireRole('admin'), updateAction);
router.delete('/actions/:id', requireRole('admin'), deleteAction);

// ── Bindings (any authenticated user can read; admin can write) ───────────────
router.get('/bindings',       getBindings);
router.get('/resolved',       getResolved);
router.post('/bindings',      requireRole('admin'), addBinding);
router.patch('/bindings/:id', requireRole('admin'), updateBinding);
router.delete('/bindings/:id', requireRole('admin'), deleteBinding);

// ── Run history ───────────────────────────────────────────────────────────────
router.get('/runs', getRuns);

export default router;
