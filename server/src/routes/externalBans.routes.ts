import { Router } from 'express';
import { requireExternalAppDelegation, postExternalBan, deleteExternalBan, pingExternal } from '../controllers/externalBans.controller';

const router = Router();

// No requireAuth (session) here — this endpoint is called by SIBLING APPS, not by browser
// users. Delegation token JWKS-verified in the controller middleware.
router.post('/', requireExternalAppDelegation, postExternalBan);
// Sibling apps can withdraw the bans they pushed. Filtered by origin_app in the handler so
// an admin from one app cannot wipe another app's bans, even sharing this Obliguard tenant.
router.delete('/:ip', requireExternalAppDelegation, deleteExternalBan);
// End-to-end auth chain probe — validates the delegation token without side effects. Used by
// Oblihub's Settings "Test" button to distinguish "not configured" vs "config wrong" vs "OK".
router.get('/ping', requireExternalAppDelegation, pingExternal);

export default router;
