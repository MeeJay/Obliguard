import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { agentAuth } from '../middleware/agentAuth';
import {
  agentPush,
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

// ── Admin routes (session auth + admin role required) ─────────────────────────

router.get('/keys', requireAuth, requireRole('admin'), listKeys);
router.post('/keys', requireAuth, requireRole('admin'), createKey);
router.delete('/keys/:id', requireAuth, requireRole('admin'), deleteKey);

// ⚠️ Bulk routes MUST be declared before /:id routes — otherwise Express matches
//    "bulk" as a device ID and the wrong handler fires.
router.delete('/devices/bulk',        requireAuth, requireRole('admin'), bulkDeleteDevices);
router.patch('/devices/bulk',         requireAuth, requireRole('admin'), bulkUpdateDevices);
router.post('/devices/bulk-command',  requireAuth, requireRole('admin'), bulkDeviceCommand);

router.get('/devices', requireAuth, requireRole('admin'), listDevices);
router.get('/devices/:id', requireAuth, requireRole('admin'), getDevice);
router.get('/devices/:id/metrics', requireAuth, requireRole('admin'), getDeviceMetrics);
router.patch('/devices/:id', requireAuth, requireRole('admin'), updateDevice);
router.delete('/devices/:id', requireAuth, requireRole('admin'), deleteDevice);
router.post('/devices/:id/command', requireAuth, requireRole('admin'), sendDeviceCommand);

export default router;
