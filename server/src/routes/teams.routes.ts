import { Router } from 'express';
import { teamsController } from '../controllers/teams.controller';
import { requireAuth } from '../middleware/auth';
import { requireCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import {
  createTeamSchema,
  updateTeamSchema,
  setTeamMembersSchema,
  setTeamPermissionsSchema,
} from '../validators/team.schema';

const router = Router();

// Teams are managed with the tenant capability users.manage (W7-3). Writes
// follow the operating tenant (teams.controller loadTeam): a team of another
// tenant is read-only from Default and not found elsewhere.
router.use(requireAuth);
router.use(requireCapability('users.manage'));

// Team CRUD
router.get('/', teamsController.list);
router.get('/:id', teamsController.getById);
router.post('/', validate(createTeamSchema), teamsController.create);
router.put('/:id', validate(updateTeamSchema), teamsController.update);
router.delete('/:id', teamsController.delete);

// Members
router.get('/:id/members', teamsController.getMembers);
router.put('/:id/members', validate(setTeamMembersSchema), teamsController.setMembers);

// Permissions
router.get('/:id/permissions', teamsController.getPermissions);
router.put('/:id/permissions', validate(setTeamPermissionsSchema), teamsController.setPermissions);
router.delete('/:id/permissions/:permId', teamsController.removePermission);

export default router;
