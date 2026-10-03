import { Router } from 'express';
import { z } from 'zod';
import { usersController } from '../controllers/users.controller';
import { requireAuth } from '../middleware/auth';
import { requireCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { requireStepUp, isPrivilegedUserCreate, isUserRoleChange } from '../middleware/stepUp';
import {
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
} from '../validators/user.schema';

const router = Router();

/** Creation may also carry the role of the new account in the operating tenant. */
const createUserWithTenantRoleSchema = createUserSchema.extend({
  tenantRole: z.string().min(1).max(64).optional(),
});

// Delegated management (W7-3): holders of the tenant capability users.manage
// (tenant admins, custom sets) manage the accounts of their tenant; the
// domination rules are enforced per target (services/userScope.service.ts).
// Platform-only operations (platform role, admin accounts, other tenants'
// rows) stay refused to them inside the controller.
router.use(requireAuth);
router.use(requireCapability('users.manage'));

// Step-up (middleware/stepUp.ts, after validation): granting a role (platform
// role, tenant memberships, an admin account) is users.role; resetting
// another account's password or second factors is users.credentials.
const roleStepUp = requireStepUp('users.role');
const credentialsStepUp = requireStepUp('users.credentials');

router.get('/', usersController.list);
router.get('/:id', usersController.getById);
router.post('/', validate(createUserWithTenantRoleSchema), requireStepUp('users.role', isPrivilegedUserCreate), usersController.create);
router.put('/:id', validate(updateUserSchema), requireStepUp('users.role', isUserRoleChange), usersController.update);
router.put('/:id/password', validate(changePasswordSchema), credentialsStepUp, usersController.changePassword);
router.delete('/:id/2fa', credentialsStepUp, usersController.resetMfa);
router.delete('/:id', usersController.delete);

// Team membership listing
router.get('/:id/teams', usersController.getTeams);

// Tenant assignment management
router.get('/:id/tenants', usersController.getTenants);
router.put('/:id/tenants', roleStepUp, usersController.setTenants);

export default router;
