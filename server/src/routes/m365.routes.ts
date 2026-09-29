import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { requireTenant } from '../middleware/tenant';
import {
  createM365Tenant,
  getM365Tenant,
  updateM365Tenant,
  issueM365Enrolment,
  verifyM365Tenant,
  rotateM365Certificate,
} from '../controllers/m365.controller';

const router = Router();

// Un tenant M365 détient les identifiants d'accès à la messagerie d'un client :
// sa gestion est réservée aux administrateurs du tenant Obliguard.
router.use(requireAuth);
router.use(requireTenant);
router.use(requireRole('admin'));

router.post('/', createM365Tenant);
router.get('/:id', getM365Tenant);
router.patch('/:id', updateM365Tenant);
router.post('/:id/enrol', issueM365Enrolment);
router.post('/:id/verify', verifyM365Tenant);
router.post('/:id/rotate-certificate', rotateM365Certificate);

export default router;
