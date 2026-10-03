import { Router } from 'express';
import { twoFactorController } from '../controllers/twoFactor.controller';
import { requireAuth } from '../middleware/auth';
import { mfaLimiter, mfaAccountLimiter, currentPasswordLimiter } from '../middleware/rateLimiter';
import { stepUpStatus, stepUpVerify } from '../middleware/stepUp';

const router = Router();

// Profile 2FA routes (requires auth)
router.get('/status', requireAuth, twoFactorController.status);
// Adding, replacing or removing a factor needs a proof (current TOTP code, or
// the current password): wrong proofs share the per-account budget of the
// profile's current-password checks.
router.post('/totp/setup', requireAuth, currentPasswordLimiter, twoFactorController.totpSetup);
router.post('/totp/enable', requireAuth, twoFactorController.totpEnable);
router.delete('/totp', requireAuth, currentPasswordLimiter, twoFactorController.totpDisable);
router.post('/email/setup', requireAuth, currentPasswordLimiter, twoFactorController.emailSetup);
router.post('/email/enable', requireAuth, twoFactorController.emailEnable);
router.delete('/email', requireAuth, currentPasswordLimiter, twoFactorController.emailDisable);

// Step-up for sensitive actions (middleware/stepUp.ts): status of the session,
// and the proof (TOTP code, e-mail code, or the password for an account
// without a second factor) valid 10 minutes. Wrong proofs share the
// per-account budget of the current-password checks.
router.get('/step-up', requireAuth, stepUpStatus);
router.post('/step-up', requireAuth, currentPasswordLimiter, stepUpVerify);

// Auth 2FA routes (rate-limited, no requireAuth — session has pendingMfaUserId).
// verify: per IP AND per pending account (new pending sessions from other
// addresses do not buy more guesses); resend: per IP.
router.post('/verify', mfaLimiter, mfaAccountLimiter, twoFactorController.verify);
router.post('/resend-email', mfaLimiter, twoFactorController.resendEmail);

export default router;
