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
} from '../controllers/agent.controller';

const router = Router();

// ── Public routes (no session auth required) ──────────────────────────────────

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
router.patch('/devices/:id', requireAuth, requireRole('admin'), requireTenant, updateDevice);
router.delete('/devices/:id', requireAuth, requireRole('admin'), requireTenant, deleteDevice);
router.post('/devices/:id/command', requireAuth, requireRole('admin'), requireTenant, sendDeviceCommand);

export default router;
