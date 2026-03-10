import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import {
  listTemplates,
  listLocalTemplates,
  getResolvedForGroup,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  upsertAssignment,
  deleteAssignment,
  requestSample,
} from '../controllers/serviceTemplates.controller';

const router = Router();

// ⚠️ Static routes before /:id to avoid Express shadowing
router.get('/local/:scope/:scopeId', requireAuth, listLocalTemplates);
router.get('/resolved/group/:groupId', requireAuth, getResolvedForGroup);

router.get('/', requireAuth, listTemplates);
router.get('/:id', requireAuth, getTemplate);
router.post('/', requireAuth, requireRole('admin'), createTemplate);
router.put('/:id', requireAuth, requireRole('admin'), updateTemplate);
router.delete('/:id', requireAuth, requireRole('admin'), deleteTemplate);

// NOTE: Assignment and sample routes use /:id sub-paths with additional segments.
// These must be declared before a plain /:id DELETE to avoid shadowing, but since
// Express matches by full path they are unambiguous here.
router.put('/:id/assign/:scope/:scopeId', requireAuth, requireRole('admin'), upsertAssignment);
router.delete('/:id/assign/:scope/:scopeId', requireAuth, requireRole('admin'), deleteAssignment);
router.post('/:id/sample/:deviceId', requireAuth, requireRole('admin'), requestSample);

export default router;
