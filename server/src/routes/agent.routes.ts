import { Router } from 'express';
import { CAPABILITIES } from '@obliview/shared';
import { requireAuth } from '../middleware/auth';
import { requireRole, requireCapability } from '../middleware/rbac';
import { agentAuth } from '../middleware/agentAuth';
import { requireTenant } from '../middleware/tenant';
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
  listKeys,
  createKey,
  deleteKey,
  getDevice,
  getDeviceStats,
  listDevices,
  updateDevice,
  deleteDevice,
  getDeviceMetrics,
  sendDeviceCommand,
  bulkDeleteDevices,
  bulkUpdateDevices,
  bulkDeviceCommand,
  getDeviceTemplates,
} from '../controllers/agent.controller';

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

// ── Admin routes (session auth + admin role + tenant required) ────────────────

router.get('/keys', requireAuth, requireRole('admin'), requireTenant, listKeys);
router.post('/keys', requireAuth, requireRole('admin'), requireTenant, createKey);
router.delete('/keys/:id', requireAuth, requireRole('admin'), requireTenant, deleteKey);

// Offline install wizard downloads — pre-baked with the selected API key + server
// URL (OBLI_CFG tail-blob). Admin-gated + tenant-scoped, same policy as /keys.
router.get('/installer/wizard.exe', requireAuth, requireRole('admin'), requireTenant, agentInstallerWizard);
router.get('/installer/wizard-linux-amd64', requireAuth, requireRole('admin'), requireTenant, agentInstallerWizardLinux);

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
// WRITE endpoints (bulk, patch, delete, command, firewall, keys, wizard) stay
// admin-only: non-admin SSO users all collapse to local role 'user' (an Obligate
// "Viewer" included), so we must not grant mutation rights on role alone here.
// Device management (edit/delete/command/bulk/firewall) → 'monitor_rw' capability.
const canManageAgents = requireCapability(CAPABILITIES.MONITOR_RW);

router.get('/devices/stats',          requireAuth, requireTenant, getDeviceStats);
router.delete('/devices/bulk',        requireAuth, canManageAgents, requireTenant, bulkDeleteDevices);
router.patch('/devices/bulk',         requireAuth, canManageAgents, requireTenant, bulkUpdateDevices);
router.post('/devices/bulk-command',  requireAuth, canManageAgents, requireTenant, bulkDeviceCommand);

router.get('/devices', requireAuth, requireTenant, listDevices);
router.get('/devices/:id', requireAuth, requireTenant, getDevice);
router.get('/devices/:id/metrics', requireAuth, requireTenant, getDeviceMetrics);
router.get('/devices/:id/templates', requireAuth, requireTenant, getDeviceTemplates);
router.patch('/devices/:id', requireAuth, canManageAgents, requireTenant, updateDevice);
router.delete('/devices/:id', requireAuth, canManageAgents, requireTenant, deleteDevice);
router.post('/devices/:id/command', requireAuth, canManageAgents, requireTenant, sendDeviceCommand);

// Firewall rule management (real-time via agent WS) — device management → monitor_rw.
import { getFirewallRules, addFirewallRule, deleteFirewallRule, toggleFirewallRule } from '../controllers/firewall.controller';
router.get('/devices/:id/firewall/rules', requireAuth, canManageAgents, requireTenant, getFirewallRules);
router.post('/devices/:id/firewall/rules', requireAuth, canManageAgents, requireTenant, addFirewallRule);
router.delete('/devices/:id/firewall/rules/:ruleId', requireAuth, canManageAgents, requireTenant, deleteFirewallRule);
router.patch('/devices/:id/firewall/rules/:ruleId', requireAuth, canManageAgents, requireTenant, toggleFirewallRule);

export default router;
