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

const router = Router();

// ── Global (no tenant required) ──────────────────────────────────────────────
router.use('/auth', authRoutes);
router.use('/agent', agentRoutes);           // agent push (authenticated via API key)
router.use('/admin/config', appConfigRoutes);
router.use('/profile/2fa', twoFactorRoutes); // must be before /profile
router.use('/live-alerts', liveAlertRouter);

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

router.use('/', tenantRouter);

export { router as routes };
