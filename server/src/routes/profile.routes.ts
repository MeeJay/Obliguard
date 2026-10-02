import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { currentPasswordLimiter } from '../middleware/rateLimiter';
import { profileController } from '../controllers/profile.controller';
import { updateProfileSchema, changePasswordSchema } from '../validators/profile.schema';

const router = Router();

// All routes require authentication (any role)
router.use(requireAuth);

// The current-password checks (password change, e-mail change) share one
// per-account failure budget. A profile write without a current password
// never checks one: it neither counts nor gets throttled.
const throttleCurrentPassword: RequestHandler = (req, res, next) => {
  const body = req.body as { currentPassword?: unknown } | undefined;
  if (typeof body?.currentPassword !== 'string') { next(); return; }
  void currentPasswordLimiter(req, res, next);
};

router.get('/', profileController.get);
router.put('/', throttleCurrentPassword, validate(updateProfileSchema), profileController.update);
// Same partial-update semantics (preferences are merged): used by the NetMap
// tab store to persist its tabs.
router.patch('/', throttleCurrentPassword, validate(updateProfileSchema), profileController.update);
router.put('/password', currentPasswordLimiter, validate(changePasswordSchema), profileController.changePassword);

export default router;
