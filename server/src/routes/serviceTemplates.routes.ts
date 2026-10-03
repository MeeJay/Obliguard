import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireCapability } from '../middleware/rbac';
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

// Writes: templates.write (W7-2). The controller binds every write to the
// operating tenant: own templates, platform templates from the Default tenant
// (or a platform admin) only, assignment / sample targets owned by the tenant.
const canWriteTemplates = requireCapability('templates.write');

// ⚠️ Static routes before /:id to avoid Express shadowing
router.get('/local/:scope/:scopeId', requireAuth, listLocalTemplates);
router.get('/resolved/group/:groupId', requireAuth, getResolvedForGroup);

router.get('/', requireAuth, listTemplates);
router.get('/:id', requireAuth, getTemplate);
router.post('/', requireAuth, canWriteTemplates, createTemplate);
router.put('/:id', requireAuth, canWriteTemplates, updateTemplate);
router.delete('/:id', requireAuth, canWriteTemplates, deleteTemplate);

// NOTE: Assignment and sample routes use /:id sub-paths with additional segments.
// These must be declared before a plain /:id DELETE to avoid shadowing, but since
// Express matches by full path they are unambiguous here.
router.put('/:id/assign/:scope/:scopeId', requireAuth, canWriteTemplates, upsertAssignment);
router.delete('/:id/assign/:scope/:scopeId', requireAuth, canWriteTemplates, deleteAssignment);
router.post('/:id/sample/:deviceId', requireAuth, canWriteTemplates, requestSample);

export default router;
