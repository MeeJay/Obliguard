import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import authRoutes from './auth.routes';
import tenantRoutes from './tenant.routes';
import groupsRoutes from './groups.routes';
import settingsRoutes from './settings.routes';
import notificationsRoutes from './notifications.routes';
import usersRoutes from './users.routes';
import profileRoutes from './profile.routes';
import teamsRoutes from './teams.routes';
import agentRoutes from './agent.routes';
import smtpServerRoutes from './smtpServer.routes';
import appConfigRoutes from './appConfig.routes';
import twoFactorRoutes from './twoFactor.routes';
import { liveAlertRouter } from './liveAlert.routes';
// Obliguard IPS routes
import bansRoutes from './bans.routes';
import whitelistRoutes from './whitelist.routes';
import ipEventsRoutes from './ipEvents.routes';
import ipReputationRoutes from './ipReputation.routes';
import serviceTemplatesRoutes from './serviceTemplates.routes';
import geoRoutes from './geo.routes';
import foreignSsoRoutes from './foreignSso.routes';
import obliviewRoutes from './obliview.routes';
import systemRoutes from './system.routes';
import oblimapRoutes from './oblimap.routes';
import oblianceRoutes from './obliance.routes';

const router = Router();

// ── Global (no tenant required) ──────────────────────────────────────────────
router.use('/auth', authRoutes);
router.use('/agent', agentRoutes);           // agent push (authenticated via API key)
router.use('/admin/config', appConfigRoutes);
router.use('/system', systemRoutes);         // system info / about (admin only, no tenant required)
router.use('/profile/2fa', twoFactorRoutes); // must be before /profile
router.use('/live-alerts', liveAlertRouter);
router.use('/sso', foreignSsoRoutes);        // Cross-platform SSO (generate-token, validate-token, exchange, users)
router.use('/obliguard', obliviewRoutes);    // Obliview cross-platform lookup (Bearer-authenticated)
router.use('/oblimap', oblimapRoutes);       // Oblimap cross-platform lookup (Bearer-authenticated)
router.use('/obliance', oblianceRoutes);    // Obliance cross-platform lookup (Bearer-authenticated)

// ── Tenant management ─────────────────────────────────────────────────────────
router.use('/tenants', tenantRoutes);
router.use('/tenant', tenantRoutes);

// ── Tenant-scoped routes (requireAuth + requireTenant) ────────────────────────
const tenantRouter = Router();
tenantRouter.use(requireAuth);
tenantRouter.use(requireTenant);

// Infrastructure (retained from Obliview base)
tenantRouter.use('/groups', groupsRoutes);
tenantRouter.use('/settings', settingsRoutes);
tenantRouter.use('/notifications', notificationsRoutes);
tenantRouter.use('/users', usersRoutes);
tenantRouter.use('/profile', profileRoutes);
tenantRouter.use('/teams', teamsRoutes);
tenantRouter.use('/admin/smtp-servers', smtpServerRoutes);

// Obliguard IPS
tenantRouter.use('/bans', bansRoutes);
tenantRouter.use('/whitelist', whitelistRoutes);
tenantRouter.use('/ip-events', ipEventsRoutes);
tenantRouter.use('/ip-reputation', ipReputationRoutes);
tenantRouter.use('/service-templates', serviceTemplatesRoutes);
tenantRouter.use('/geo', geoRoutes);

router.use('/', tenantRouter);

export { router as routes };
