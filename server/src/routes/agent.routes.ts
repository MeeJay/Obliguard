import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
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

// ── Admin routes (session auth + admin role + tenant required) ────────────────

router.get('/keys', requireAuth, requireRole('admin'), requireTenant, listKeys);
router.post('/keys', requireAuth, requireRole('admin'), requireTenant, createKey);
router.delete('/keys/:id', requireAuth, requireRole('admin'), requireTenant, deleteKey);

// ⚠️ Static routes MUST be declared before /:id routes — otherwise Express matches
//    the literal segment as a device ID and the wrong handler fires.
router.get('/devices/stats',          requireAuth, requireRole('admin'), requireTenant, getDeviceStats);
router.delete('/devices/bulk',        requireAuth, requireRole('admin'), requireTenant, bulkDeleteDevices);
router.patch('/devices/bulk',         requireAuth, requireRole('admin'), requireTenant, bulkUpdateDevices);
router.post('/devices/bulk-command',  requireAuth, requireRole('admin'), requireTenant, bulkDeviceCommand);

router.get('/devices', requireAuth, requireRole('admin'), requireTenant, listDevices);
router.get('/devices/:id', requireAuth, requireRole('admin'), requireTenant, getDevice);
router.get('/devices/:id/metrics', requireAuth, requireRole('admin'), requireTenant, getDeviceMetrics);
router.get('/devices/:id/templates', requireAuth, requireRole('admin'), requireTenant, getDeviceTemplates);
router.patch('/devices/:id', requireAuth, requireRole('admin'), requireTenant, updateDevice);
router.delete('/devices/:id', requireAuth, requireRole('admin'), requireTenant, deleteDevice);
router.post('/devices/:id/command', requireAuth, requireRole('admin'), requireTenant, sendDeviceCommand);

export default router;
