import { Router } from 'express';
import { groupsController } from '../controllers/groups.controller';
import { requireAuth } from '../middleware/auth';
import { requireCapability, requireGroupWrite } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import {
  createGroupSchema,
  updateGroupSchema,
  moveGroupSchema,
} from '../validators/group.schema';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Read routes (visibility filtering in controller)
router.get('/', groupsController.list);
router.get('/tree', groupsController.tree);
router.get('/:id', groupsController.getById);

// Write routes: the tenant capability groups.manage on every write (W7-2),
// guards before validation so a refused caller learns nothing about the body.
//   create            + team canCreate OR RW on the parent (controller)
//   update/move/delete/agent-config + RW on the group (requireGroupWrite; move: also the new parent)
//   reorder           + groups of the operating tenant and RW on each (controller)
const canManageGroups = requireCapability('groups.manage');

router.post('/', canManageGroups, validate(createGroupSchema), groupsController.create);
router.put('/:id', canManageGroups, requireGroupWrite(), validate(updateGroupSchema), groupsController.update);
router.post('/reorder', canManageGroups, groupsController.reorder);
router.post('/:id/move', canManageGroups, requireGroupWrite(), validate(moveGroupSchema), groupsController.move);
router.delete('/:id', canManageGroups, requireGroupWrite(), groupsController.delete);
router.patch('/:id/agent-config', canManageGroups, requireGroupWrite(), groupsController.updateAgentGroupConfig);

export default router;
