import { Router } from 'express';
import { appConfigController } from '../controllers/appConfig.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { requireStepUp, isSecretConfigKey } from '../middleware/stepUp';

const router = Router();

// GET is available to all authenticated users (needed for profile page to check allow_2fa)
router.get('/', requireAuth, appConfigController.getAll);

// Agent global defaults — admin only
router.get('/agent-global', requireAuth, requireRole('admin'), appConfigController.getAgentGlobal);
router.patch('/agent-global', requireAuth, requireRole('admin'), appConfigController.patchAgentGlobal);

// Obligate SSO gateway — admin only; writing it (URL / API key) needs a fresh
// step-up (appConfig.secrets, middleware/stepUp.ts).
router.get('/obligate',  requireAuth, requireRole('admin'), appConfigController.getObligateConfig);
router.put('/obligate',  requireAuth, requireRole('admin'), requireStepUp('appConfig.secrets'), appConfigController.setObligateConfig);

// Auto-ban duration policy (W12-3): read by every signed-in user (read-only
// summary on the Policies hub), written by the platform admin from the
// Default tenant (controller). Declared before /:key.
router.get('/ban-policy', requireAuth, appConfigController.getBanPolicy);
router.put('/ban-policy', requireAuth, requireRole('admin'), appConfigController.setBanPolicy);

// Data retention windows (W12-1): instance setting, platform admin on the
// Default tenant (controller). Shortening auditDays erases the audit trail,
// so the write needs a fresh step-up. Declared before /:key.
router.get('/retention', requireAuth, requireRole('admin'), appConfigController.getRetention);
router.put('/retention', requireAuth, requireRole('admin'), requireStepUp('appConfig.secrets'), appConfigController.setRetention);

// Generic key setter — MUST be LAST (/:key catches everything). Security
// settings and integration secrets (STEP_UP_CONFIG_KEYS: obli.tools key, 2FA
// policy, OTP SMTP server...) need a fresh step-up.
router.put('/:key', requireAuth, requireRole('admin'), requireStepUp('appConfig.secrets', isSecretConfigKey), appConfigController.set);

export default router;
