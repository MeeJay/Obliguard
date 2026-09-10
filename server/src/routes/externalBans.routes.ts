import { Router } from 'express';
import { requireExternalAppDelegation, postExternalBan } from '../controllers/externalBans.controller';

const router = Router();

// No requireAuth (session) here — this endpoint is called by SIBLING APPS, not by browser
// users. Delegation token JWKS-verified in the controller middleware.
router.post('/', requireExternalAppDelegation, postExternalBan);

export default router;
