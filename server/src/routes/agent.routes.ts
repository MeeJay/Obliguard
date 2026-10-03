import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requireRole, requireCapability } from '../middleware/rbac';
import {
  requireCapabilitiesFor,
  deviceCommandCapabilities,
  deviceEditCapabilities,
} from '../middleware/routePermissions';
import { agentAuth } from '../middleware/agentAuth';
import { requireTenant } from '../middleware/tenant';
import {
  requireStepUp,
  allOf,
  isDeviceInTenant,
  hasDevicesInTenant,
  isUninstallCommand,
  isKeyInTenant,
  isKeyActivationChange,
} from '../middleware/stepUp';
import {
  agentPush,
  notifyingUpdate,
  agentVersion,
  desktopVersion,
  agentDownload,
  agentInstallerLinux,
  agentInstallerWindows,
  agentInstallerWindowsMsi,
  agentInstallerMacos,
  agentInstallerFreeBSD,
  agentInstallerWizard,
  agentInstallerWizardLinux,
  getDevice,
  getDeviceStats,
  listDevices,
  updateDevice,
  deleteDevice,
  getDeviceMetrics,
  sendDeviceCommand,
  listDeviceCommands,
  createDeviceCommand,
  bulkDeleteDevices,
  bulkUpdateDevices,
  bulkDeviceCommand,
  getDeviceTemplates,
  requestDeviceUpdate,
  retryDeviceUpdate,
  cancelDeviceUpdate,
  bulkRequestUpdate,
  requestGroupUpdateHandler,
  getDeviceVersionDistribution,
  getTenantUpdatePolicy,
  patchTenantUpdatePolicy,
  getUpdateRolloutPreview,
  updateAllOutdatedAgents,
  cancelAllAgentUpdates,
} from '../controllers/agent.controller';
import { listKeys, createKey, updateKey, revealKey, deleteKey } from '../controllers/agentKeys.controller';
import { AppError } from '../middleware/errorHandler';
import { readTenantsFor } from '../middleware/tenant';
import { permissionService } from '../services/permission.service';
import { resolveRequestAgent, requestViewer } from '../services/agentScope.service';
import { agentTimelineService, agentTimelineQuerySchema } from '../services/agentTimeline.service';
import type { CapabilityKey } from '@obliview/shared';

/**
 * GET /devices/:id/timeline (W13-2). The audit-backed kinds need audit.read
 * in the operating tenant; their rows are read like /audit-log/device/:id
 * (own tenant, Default: every tenant; ?tenants= chips ignored).
 */
async function getDeviceTimeline(req: Request, res: Response): Promise<void> {
  const outcome = await resolveRequestAgent(req, req.params.id, 'read');
  if (!outcome.ok) throw new AppError(outcome.status, outcome.error);
  const parsed = agentTimelineQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, parsed.error.issues[0]?.message ?? 'Invalid query');

  const viewer = requestViewer(req);
  const canReadAudit = viewer.userId != null
    && await permissionService.hasCapability(viewer.userId, !!viewer.isAdmin, viewer.tenantId, 'audit.read');
  const timeline = await agentTimelineService.getTimeline(outcome.agent.id, {
    ...parsed.data,
    auditTenants: canReadAudit ? readTenantsFor(viewer.tenantId) : null,
    callerTenantId: viewer.tenantId,
  });
  if (!timeline) throw new AppError(404, 'Device not found');
  res.json({ success: true, data: timeline });
}

const router = Router();

// ── Public routes (no session auth required) ──────────────────────────────────

// Safety net for misconfigured reverse proxies.
// The real /ws endpoint is a WebSocket upgrade handled by the 'upgrade' event
// listener in index.ts — it never reaches Express.  If a proxy (e.g. Nginx
// Proxy Manager) does NOT have WebSocket Support enabled it strips the Upgrade
// header, Node.js emits 'request' instead of 'upgrade', and Express processes
// it as a plain GET.  Without this route it would fall through to the
// tenant-scoped router (requireAuth) and return a confusing 401.
// With this route the agent gets a clear 400 + explanation instead.
router.get('/ws', (_req, res) => {
  res.status(400).json({
    error: 'WebSocket upgrade required — enable WebSocket Support on the reverse-proxy host for this service',
  });
});

// Agent push — authenticated via X-API-Key header
router.post('/push', agentAuth, agentPush);

// Pre-update notification — agent calls this before self-updating
router.post('/notifying-update', agentAuth, notifyingUpdate);

// Agent auto-update endpoints
router.get('/version', agentVersion);
router.get('/download/:filename', agentDownload);

// Desktop app version (used by the React app to show update banner)
router.get('/desktop-version', desktopVersion);

// Installer scripts (with API key injected)
router.get('/installer/linux', agentInstallerLinux);
router.get('/installer/windows', agentInstallerWindows);
router.get('/installer/macos', agentInstallerMacos);
router.get('/installer/freebsd', agentInstallerFreeBSD);

// Pre-built Windows MSI (static, SERVERURL + APIKEY passed via msiexec properties)
router.get('/installer/windows.msi', agentInstallerWindowsMsi);

// MikroTik HTTP syslog ingestion (authenticated via per-device ingest token, no session needed)
import { ingestMikroTikSyslog } from '../controllers/mikrotik.controller';
import express from 'express';
router.post('/mikrotik/ingest', express.text({ type: '*/*', limit: '1mb' }), ingestMikroTikSyslog);

// ── Session routes (session auth + tenant + one capability each) ─────────────
// Route-to-capability matrix: middleware/routePermissions.ts (suite 67).

// Enrolment keys (W10-2, agentKeys.controller): tenant-scoped in the service,
// no master bypass. The list is masked; the full value is returned by the
// create call and by /reveal (active keys, Add-Agent install commands).
// PUT renames, disables / re-enables (closes the key's live sessions) and sets
// the default enrolment group.
// Creating, disabling / re-enabling and deleting a key needs a fresh step-up
// (keys.manage, middleware/stepUp.ts); a rename or a default group does not.
// Keys of another tenant are refused by the controller without a prompt.
const canManageKeys = requireCapability('agents.keys');
router.get('/keys', requireAuth, requireTenant, canManageKeys, listKeys);
router.post('/keys', requireAuth, requireTenant, canManageKeys, requireStepUp('keys.manage'), createKey);
router.get('/keys/:id/reveal', requireAuth, requireTenant, canManageKeys, revealKey);
router.put('/keys/:id', requireAuth, requireTenant, canManageKeys, requireStepUp('keys.manage', isKeyActivationChange), updateKey);
router.delete('/keys/:id', requireAuth, requireTenant, canManageKeys, requireStepUp('keys.manage', isKeyInTenant), deleteKey);

// Offline install wizard downloads — pre-baked with the selected API key + server
// URL (OBLI_CFG tail-blob). Same capability and tenant scope as /keys.
router.get('/installer/wizard.exe', requireAuth, requireTenant, canManageKeys, asyncHandler(agentInstallerWizard));
router.get('/installer/wizard-linux-amd64', requireAuth, requireTenant, canManageKeys, asyncHandler(agentInstallerWizardLinux));

// ⚠️ Static routes MUST be declared before /:id routes — otherwise Express matches
//    the literal segment as a device ID and the wrong handler fires.
//
// READ endpoints are tenant-scoped (requireTenant) but intentionally NOT
// admin-only: any authenticated member of the tenant may VIEW its devices.
// This matches the "View monitors, groups, events" capability granted to the
// User/Viewer permission sets, and mirrors the bans / ip-reputation read routes
// (which are requireAuth only). Previously these were requireRole('admin'),
// so every non-admin got a 403 → empty Dashboard/NetMap (agents, online count).
//
// WRITE endpoints each require one tenant capability (W7-2): agents.manage for
// edits, agents.approve for status changes (approve / refuse / suspend),
// agents.update for update requests, agents.delete for delete and uninstall.
// requireTenant runs before the capability check, so a missing tenant answers
// 403 noTenantAccess and capabilities are computed on the validated tenant.
const canUpdateAgents = requireCapability('agents.update');
const canDeleteAgents = requireCapability('agents.delete');
/** PATCH: status → agents.approve, any other field → agents.manage. */
const canEditAgents = requireCapabilitiesFor(deviceEditCapabilities);
/** Commands: uninstall → agents.delete, update → agents.update, else agents.manage. */
const canCommandAgents = requireCapabilitiesFor(deviceCommandCapabilities);
// Step-up (middleware/stepUp.ts): deleting and uninstalling agents of the
// operating tenant (foreign ids are refused by the controller, no prompt).
const deleteStepUp = requireStepUp('agents.delete', isDeviceInTenant);
const bulkDeleteStepUp = requireStepUp('agents.delete', hasDevicesInTenant);
const uninstallStepUp = requireStepUp('agents.uninstall', allOf(isUninstallCommand, isDeviceInTenant));
const bulkUninstallStepUp = requireStepUp('agents.uninstall', allOf(isUninstallCommand, hasDevicesInTenant));

// Command queue (W14-1): POST /devices/:id/commands { type }. Same matrix as
// /command, read from `type`: uninstall → agents.delete + step-up, update →
// agents.update, restart / firewall_resync (and anything else) → agents.manage.
const COMMAND_TYPE_CAPABILITIES: Readonly<Record<string, CapabilityKey>> = {
  uninstall: 'agents.delete',
  update: 'agents.update',
};
function commandTypeOf(req: Request): unknown {
  const b = req.body as unknown;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>).type : undefined;
}
const canQueueCommand = requireCapabilitiesFor((req) => {
  const type = commandTypeOf(req);
  return [typeof type === 'string' && Object.prototype.hasOwnProperty.call(COMMAND_TYPE_CAPABILITIES, type)
    ? COMMAND_TYPE_CAPABILITIES[type]
    : 'agents.manage'];
});
const queueUninstallStepUp = requireStepUp(
  'agents.uninstall',
  allOf(async (req) => commandTypeOf(req) === 'uninstall', isDeviceInTenant),
);

router.get('/devices/stats',          requireAuth, requireTenant, asyncHandler(getDeviceStats));
// Agent update control (C17-1): version distribution (read) and bulk "Update now".
router.get('/devices/versions',       requireAuth, requireTenant, getDeviceVersionDistribution);
router.post('/devices/bulk-request-update', requireAuth, requireTenant, canUpdateAgents, bulkRequestUpdate);
router.delete('/devices/bulk',        requireAuth, requireTenant, canDeleteAgents, bulkDeleteStepUp, asyncHandler(bulkDeleteDevices));
router.patch('/devices/bulk',         requireAuth, requireTenant, canEditAgents, asyncHandler(bulkUpdateDevices));
router.post('/devices/bulk-command',  requireAuth, requireTenant, canCommandAgents, bulkUninstallStepUp, bulkDeviceCommand);

// Tenant level of the update policy (W2-1): read by members, written by platform
// admins only (same rule as the group and global levels), operating tenant only.
router.get('/update-policy/tenant',   requireAuth, requireTenant, getTenantUpdatePolicy);
router.patch('/update-policy/tenant', requireAuth, requireTenant, requireRole('admin'), patchTenantUpdatePolicy);

// Paced fleet rollout (W12-4): preview, "update all outdated", "cancel all
// pending" — agents.update, no step-up. Operating tenant (Default = every
// tenant); the update policy stays authoritative (frozen agents never offered).
router.get('/updates/preview',     requireAuth, requireTenant, canUpdateAgents, getUpdateRolloutPreview);
router.post('/updates/all',        requireAuth, requireTenant, canUpdateAgents, updateAllOutdatedAgents);
router.post('/updates/cancel-all', requireAuth, requireTenant, canUpdateAgents, cancelAllAgentUpdates);

router.get('/devices', requireAuth, requireTenant, asyncHandler(listDevices));
router.get('/devices/:id', requireAuth, requireTenant, asyncHandler(getDevice));
router.get('/devices/:id/metrics', requireAuth, requireTenant, getDeviceMetrics);
router.get('/devices/:id/templates', requireAuth, requireTenant, asyncHandler(getDeviceTemplates));
// Activity timeline (W13-2, Obliance change-events): bans reaching the agent,
// attack bursts, updates, outages, approvals and (audit.read) its audit rows.
// Agent read scope (agentScope): own tenant, Default god view, team grant;
// any other agent answers 404. Window <= 30 days, limit <= 500, truncated flag.
router.get('/devices/:id/timeline', requireAuth, requireTenant, asyncHandler(getDeviceTimeline));
router.patch('/devices/:id', requireAuth, requireTenant, canEditAgents, asyncHandler(updateDevice));
router.delete('/devices/:id', requireAuth, requireTenant, canDeleteAgents, deleteStepUp, asyncHandler(deleteDevice));
router.post('/devices/:id/command', requireAuth, requireTenant, canCommandAgents, uninstallStepUp, sendDeviceCommand);
// Command queue with ack, result and history (W14-1). The history is read
// with the agent (own tenant, Default god view, team grant).
router.get('/devices/:id/commands', requireAuth, requireTenant, listDeviceCommands);
router.post('/devices/:id/commands', requireAuth, requireTenant, canQueueCommand, queueUninstallStepUp, createDeviceCommand);
// Explicit agent update request (C17-1) — 'agent-update' avoids any confusion with PATCH device updates.
router.post('/devices/:id/agent-update', requireAuth, requireTenant, canUpdateAgents, requestDeviceUpdate);
router.delete('/devices/:id/agent-update', requireAuth, requireTenant, canUpdateAgents, cancelDeviceUpdate);
// Retry a failed / abandoned update attempt (W2-1) — same permission as 'Update now'.
router.post('/devices/:id/update/retry', requireAuth, requireTenant, canUpdateAgents, retryDeviceUpdate);
router.post('/groups/:groupId/agent-update', requireAuth, requireTenant, canUpdateAgents, requestGroupUpdateHandler);

// Firewall rule management (real-time via agent WS): reading the host rules is
// firewall.rules.read; adding / deleting / toggling them is firewall.rules.write
// (RDP/SSH lockout or an opened port), outside the default 'user' set, and
// needs a fresh step-up (firewall.write, middleware/stepUp.ts).
import { getFirewallRules, addFirewallRule, deleteFirewallRule, toggleFirewallRule } from '../controllers/firewall.controller';
const canReadFirewall = requireCapability('firewall.rules.read');
const canWriteFirewall = requireCapability('firewall.rules.write');
const firewallStepUp = requireStepUp('firewall.write', isDeviceInTenant);
router.get('/devices/:id/firewall/rules', requireAuth, requireTenant, canReadFirewall, getFirewallRules);
router.post('/devices/:id/firewall/rules', requireAuth, requireTenant, canWriteFirewall, firewallStepUp, addFirewallRule);
router.delete('/devices/:id/firewall/rules/:ruleId', requireAuth, requireTenant, canWriteFirewall, firewallStepUp, deleteFirewallRule);
router.patch('/devices/:id/firewall/rules/:ruleId', requireAuth, requireTenant, canWriteFirewall, firewallStepUp, toggleFirewallRule);

export default router;
