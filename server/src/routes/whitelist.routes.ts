import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireCapability } from '../middleware/rbac';
import {
  requireStepUp,
  isGlobalWhitelistCreate,
  isGlobalWhitelistDelete,
  isGlobalWhitelistBulkDelete,
} from '../middleware/stepUp';
import {
  listWhitelist,
  createWhitelistEntry,
  deleteWhitelistEntry,
  bulkDeleteWhitelist,
  exportWhitelist,
} from '../controllers/whitelist.controller';

const router = Router();

router.get('/', requireAuth, listWhitelist);
// CSV of the filtered list (same visibility and team scope as GET /, capped, audited).
router.get('/export', requireAuth, exportWhitelist);
// Writes: whitelist.write (Default = global entries, other tenants = their own).
// Global entries (written from Default) need a fresh step-up (middleware/stepUp.ts).
const globalStepUp = (when: Parameters<typeof requireStepUp>[1]) => requireStepUp('whitelist.global', when);
router.post('/', requireAuth, requireCapability('whitelist.write'), globalStepUp(isGlobalWhitelistCreate), createWhitelistEntry);
router.post('/bulk-delete', requireAuth, requireCapability('whitelist.write'), globalStepUp(isGlobalWhitelistBulkDelete), bulkDeleteWhitelist);
router.delete('/:id', requireAuth, requireCapability('whitelist.write'), globalStepUp(isGlobalWhitelistDelete), deleteWhitelistEntry);

export default router;
