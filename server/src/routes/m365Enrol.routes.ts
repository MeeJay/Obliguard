import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { m365EnrolLimiter } from '../middleware/rateLimiter';
import {
  getM365EnrolScript,
  getM365EnrolPlan,
  completeM365Enrolment,
} from '../controllers/m365.controller';

/**
 * Routes de l'enrôlement M365, sans session.
 *
 * Le script tourne sur le poste de l'opérateur et ne dispose que du jeton à usage
 * unique émis par l'interface. Ces routes sont donc montées hors du routeur à
 * tenant, et portent leur propre limiteur de débit : le jeton fait 32 octets,
 * mais une route publique qui valide un secret se protège quand même du bruit.
 */

const router = Router();

// Le script est du contenu public : il ne porte ni jeton ni identifiant, et son
// exécution ne fait rien sans un jeton valide.
router.get('/script', getM365EnrolScript);

router.post('/plan', m365EnrolLimiter, asyncHandler(getM365EnrolPlan));
router.post('/complete', m365EnrolLimiter, completeM365Enrolment);

export default router;
