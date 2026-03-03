import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { agentService } from '../services/agent.service';
import type { AgentThresholds } from '@obliview/shared';

// ── Push endpoint (called by agent) ──────────────────────────────────────────

export async function agentPush(req: Request, res: Response): Promise<void> {
  try {
    // agentApiKeyId is set by agentAuth middleware
    const agentApiKeyId = (req as unknown as { agentApiKeyId: number }).agentApiKeyId;
    const deviceUuid = req.headers['x-device-uuid'] as string | undefined;

    if (!deviceUuid) {
      res.status(400).json({ error: 'X-Device-UUID header required' });
      return;
    }

    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      '';

    const result = await agentService.handlePush(
      agentApiKeyId,
      deviceUuid,
      clientIp,
      req.body,
    );

    const statusCode = result.status === 'ok' ? 200 : result.status === 'pending' ? 202 : 401;
    res.status(statusCode).json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Public: version + download ──────────────────────────────────────────────

export function agentVersion(_req: Request, res: Response): void {
  try {
    const info = agentService.getAgentVersion();
    res.json(info);
  } catch {
    res.status(503).json({ error: 'Agent version info unavailable' });
  }
}

export function desktopVersion(_req: Request, res: Response): void {
  try {
    const info = agentService.getDesktopVersion();
    res.json(info);
  } catch {
    res.status(503).json({ error: 'Desktop version info unavailable' });
  }
}

const ALLOWED_AGENT_BINARIES: Record<string, string> = {
  'obliview-agent.exe':             'obliview-agent.exe',
  'obliview-agent-linux-amd64':     'obliview-agent-linux-amd64',
  'obliview-agent-linux-arm64':     'obliview-agent-linux-arm64',
  'obliview-agent-darwin-amd64':    'obliview-agent-darwin-amd64',
  'obliview-agent-darwin-arm64':    'obliview-agent-darwin-arm64',
};

export function agentDownload(req: Request, res: Response): void {
  const { filename } = req.params;

  const binaryName = ALLOWED_AGENT_BINARIES[filename];
  if (!binaryName) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const filePath = path.resolve(__dirname, '../../../../agent/dist', binaryName);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Agent binary not available' });
    return;
  }

  const isExe = filename.endsWith('.exe');
  res.setHeader('Content-Type', isExe ? 'application/octet-stream' : 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(filePath);
}

export function agentInstallerLinux(req: Request, res: Response): void {
  const apiKey = req.query.key as string | undefined;

  const scriptPath = path.resolve(__dirname, '../../../../agent/installer/install.sh');
  if (!fs.existsSync(scriptPath)) {
    res.status(404).json({ error: 'Installer not available' });
    return;
  }

  let script = fs.readFileSync(scriptPath, 'utf-8');

  // Inject server URL and API key
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  script = script.replace('__SERVER_URL__', serverUrl);
  if (apiKey) {
    script = script.replace('__API_KEY__', apiKey);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="install.sh"');
  res.send(script);
}

export function agentInstallerWindows(req: Request, res: Response): void {
  const apiKey = req.query.key as string | undefined;

  const scriptPath = path.resolve(__dirname, '../../../../agent/installer/install.ps1');
  if (!fs.existsSync(scriptPath)) {
    res.status(404).json({ error: 'Installer not available' });
    return;
  }

  let script = fs.readFileSync(scriptPath, 'utf-8');

  const serverUrl = `${req.protocol}://${req.get('host')}`;
  script = script.replace('__SERVER_URL__', serverUrl);
  if (apiKey) {
    script = script.replace('__API_KEY__', apiKey);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="install.ps1"');
  res.send(script);
}

export function agentInstallerMacos(req: Request, res: Response): void {
  const apiKey = req.query.key as string | undefined;

  const scriptPath = path.resolve(__dirname, '../../../../agent/installer/install-macos.sh');
  if (!fs.existsSync(scriptPath)) {
    res.status(404).json({ error: 'macOS installer not available' });
    return;
  }

  let script = fs.readFileSync(scriptPath, 'utf-8');

  const serverUrl = `${req.protocol}://${req.get('host')}`;
  script = script.replace('__SERVER_URL__', serverUrl);
  if (apiKey) {
    script = script.replace('__API_KEY__', apiKey);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="install-macos.sh"');
  res.send(script);
}

export function agentInstallerWindowsMsi(_req: Request, res: Response): void {
  const msiPath = path.resolve(__dirname, '../../../../agent/dist/obliview-agent.msi');
  if (!fs.existsSync(msiPath)) {
    res.status(404).json({ error: 'MSI installer not available (not yet built)' });
    return;
  }

  res.setHeader('Content-Type', 'application/x-msi');
  res.setHeader('Content-Disposition', 'attachment; filename="obliview-agent.msi"');
  res.sendFile(msiPath);
}

// ── Admin: API Keys ──────────────────────────────────────────────────────────

export async function listKeys(_req: Request, res: Response): Promise<void> {
  const keys = await agentService.listKeys();
  res.json({ success: true, data: keys });
}

export async function createKey(req: Request, res: Response): Promise<void> {
  const { name } = req.body as { name: string };
  if (!name?.trim()) {
    res.status(400).json({ success: false, error: 'Name is required' });
    return;
  }
  const userId = req.session?.userId ?? 0;
  const key = await agentService.createKey(name.trim(), userId);
  res.status(201).json({ success: true, data: key });
}

export async function deleteKey(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const ok = await agentService.deleteKey(id);
  if (!ok) {
    res.status(404).json({ success: false, error: 'API key not found' });
    return;
  }
  res.json({ success: true });
}

// ── Admin: Devices ──────────────────────────────────────────────────────────

export async function getDevice(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const device = await agentService.getDeviceById(id);
  if (!device) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }
  res.json({ success: true, data: device });
}

export async function listDevices(req: Request, res: Response): Promise<void> {
  const status = req.query.status as string | undefined;
  const validStatuses = ['pending', 'approved', 'refused', 'suspended'];
  const devices = await agentService.listDevices(
    validStatuses.includes(status ?? '') ? (status as 'pending' | 'approved' | 'refused' | 'suspended') : undefined,
  );
  res.json({ success: true, data: devices });
}

export async function updateDevice(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const {
    status, groupId, checkIntervalSeconds, agentThresholds, name,
    heartbeatMonitoring, sensorDisplayNames, overrideGroupSettings, displayConfig,
  } = req.body as {
    status?: 'approved' | 'refused' | 'pending' | 'suspended';
    groupId?: number | null;
    checkIntervalSeconds?: number;
    agentThresholds?: AgentThresholds;
    name?: string | null;
    heartbeatMonitoring?: boolean;
    sensorDisplayNames?: Record<string, string> | null;
    overrideGroupSettings?: boolean;
    displayConfig?: import('@obliview/shared').AgentDisplayConfig | null;
  };

  // Special handling for approval
  if (status === 'approved') {
    const currentDevice = await agentService.getDeviceById(id);
    if (!currentDevice) {
      res.status(404).json({ success: false, error: 'Device not found' });
      return;
    }

    if (currentDevice.status === 'suspended') {
      // Reinstate a suspended device: re-activate its monitor, no new monitor created
      await agentService.reinstateDevice(id);
      const device = await agentService.updateDevice(id, { status: 'approved', name, heartbeatMonitoring });
      res.json({ success: true, data: device });
      return;
    }

    // First-time approval (pending → approved): create monitor
    const userId = req.session?.userId ?? 0;
    const device = await agentService.approveDevice(id, userId, groupId ?? null, agentThresholds);
    if (!device) {
      res.status(404).json({ success: false, error: 'Device not found' });
      return;
    }
    // Apply name/heartbeatMonitoring if provided alongside approval
    if (name !== undefined || heartbeatMonitoring !== undefined) {
      await agentService.updateDevice(id, { name, heartbeatMonitoring });
    }
    res.json({ success: true, data: device });
    return;
  }

  // Suspend: pause the agent monitor
  if (status === 'suspended') {
    await agentService.suspendDevice(id);
  }

  // Update thresholds if provided (device already approved)
  if (agentThresholds) {
    await agentService.updateDeviceThresholds(id, agentThresholds);
  }

  const device = await agentService.updateDevice(id, {
    status,
    groupId,
    checkIntervalSeconds,
    name,
    heartbeatMonitoring,
    sensorDisplayNames,
    overrideGroupSettings,
    displayConfig,
  });

  if (!device) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }

  res.json({ success: true, data: device });
}

// ── Admin: Device Metrics ────────────────────────────────────────────────────

export async function getDeviceMetrics(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  // Try in-memory first, fall back to DB (handles server restarts)
  const snapshot = agentService.getLatestMetrics(id) ?? await agentService.getMetricsFromDB(id);
  if (!snapshot) {
    res.status(404).json({ success: false, error: 'No metrics available yet for this device' });
    return;
  }
  res.json({
    success: true,
    data: {
      monitorId: snapshot.monitorId,
      receivedAt: snapshot.receivedAt instanceof Date
        ? snapshot.receivedAt.toISOString()
        : snapshot.receivedAt,
      metrics: snapshot.metrics,
      violations: snapshot.violations,
      overallStatus: snapshot.overallStatus,
    },
  });
}

export async function deleteDevice(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const ok = await agentService.deleteDevice(id);
  if (!ok) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }
  res.json({ success: true });
}
