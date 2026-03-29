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
import ipDisplayNamesRoutes from './ipDisplayNames.routes';
import serviceTemplatesRoutes from './serviceTemplates.routes';
import geoRoutes from './geo.routes';
import obligateCallbackRoutes from './obligateCallback.routes';
import oblitoolsRoutes from './oblitools.routes';
import systemRoutes from './system.routes';
import permissionSetsRoutes from './permissionSets.routes';
import mikrotikRoutes from './mikrotik.routes';
import remoteBlocklistRoutes from './remoteBlocklist.routes';

const router = Router();

// ── Global (no tenant required) ──────────────────────────────────────────────
router.use('/auth', authRoutes);
router.use('/auth', obligateCallbackRoutes);      // Obligate SSO callback, sso-config, connected-apps
router.use('/agent', agentRoutes);           // agent push (authenticated via API key)
router.use('/admin/config', appConfigRoutes);
router.use('/system', systemRoutes);         // system info / about (admin only, no tenant required)
router.use('/profile/2fa', twoFactorRoutes); // must be before /profile
router.use('/live-alerts', liveAlertRouter);
router.use('/oblitools', oblitoolsRoutes);   // ObliTools desktop manifest (auth required)
router.use('/permission-sets', permissionSetsRoutes);

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
  tenantRouter.use('/ip-labels', ipDisplayNamesRoutes);
tenantRouter.use('/service-templates', serviceTemplatesRoutes);
tenantRouter.use('/geo', geoRoutes);
tenantRouter.use('/mikrotik', mikrotikRoutes);
tenantRouter.use('/remote-blocklists', remoteBlocklistRoutes);

router.use('/', tenantRouter);

export { router as routes };
