import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { foreignSsoController, requireObliviewSecret } from '../controllers/foreignSso.controller';

const router = Router();

/** POST /api/sso/generate-token — session auth — generates one-time token for current user */
router.post('/generate-token', requireAuth, foreignSsoController.generateToken);

/** GET /api/sso/validate-token?token=xxx — Bearer auth — validates a token from Obliguard */
router.get('/validate-token', requireObliviewSecret, foreignSsoController.validateToken);

/** GET /api/sso/users — Bearer auth — list of active Obliguard users */
router.get('/users', requireObliviewSecret, foreignSsoController.listUsers);

/** POST /api/sso/exchange — public — exchanges a foreign token for a local session */
router.post('/exchange', foreignSsoController.exchange);

/** POST /api/sso/set-password — session auth — set local password for SSO-only account */
router.post('/set-password', requireAuth, foreignSsoController.setPassword);

export default router;
