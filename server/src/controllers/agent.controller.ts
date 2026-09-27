import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { agentService } from '../services/agent.service';
import { serviceTemplateService } from '../services/serviceTemplate.service';
import { configuredPublicOrigins, requestAuthority, requestProto } from '../utils/publicOrigin';
import type { AgentThresholds, AgentDevice } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';

/**
 * Resolve a device by :id and enforce that it belongs to the caller's tenant
 * (the master tenant sees all). Returns null and writes a 404 otherwise — we
 * never reveal the existence of another tenant's device. Use on every
 * device-by-id handler now that reads/writes are open to non-admin members.
 */
async function requireDeviceInTenant(
  req: Request,
  res: Response,
  id: number,
): Promise<AgentDevice | null> {
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid device ID' });
    return null;
  }
  const device = await agentService.getDeviceById(id);
  if (!device || (!isMasterTenant(req.tenantId) && device.tenantId !== req.tenantId)) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return null;
  }
  return device;
}

// ── Push endpoint (called by agent) ──────────────────────────────────────────

export async function agentPush(req: Request, res: Response): Promise<void> {
  try {
    // agentApiKeyId and agentTenantId are set by agentAuth middleware
    const agentApiKeyId = (req as unknown as { agentApiKeyId: number; agentTenantId: number }).agentApiKeyId;
    const agentTenantId = (req as unknown as { agentApiKeyId: number; agentTenantId: number }).agentTenantId;
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
      agentTenantId,
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

// ── Pre-update notification (called by agent before self-updating) ────────────

export async function notifyingUpdate(req: Request, res: Response): Promise<void> {
  try {
    const agentApiKeyId = (req as unknown as { agentApiKeyId: number; agentTenantId: number }).agentApiKeyId;
    const agentTenantId = (req as unknown as { agentApiKeyId: number; agentTenantId: number }).agentTenantId;
    const deviceUuid = req.headers['x-device-uuid'] as string | undefined;
    if (!deviceUuid) {
      res.status(400).json({ error: 'X-Device-UUID header required' });
      return;
    }
    // Identify device — must belong to the authenticated API key
    const device = await agentService.getDeviceByUuid(deviceUuid);
    if (!device || device.apiKeyId !== agentApiKeyId) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    await agentService.setDeviceUpdating(device.id, agentTenantId);
    res.json({ ok: true });
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
  // Windows: full MSI installer (handles service, PawnIO driver, etc.)
  'obliguard-agent.msi':             'obliguard-agent.msi',
  // Windows: bare exe (kept for manual / legacy use)
  'obliguard-agent.exe':             'obliguard-agent.exe',
  'obliguard-agent-linux-amd64':     'obliguard-agent-linux-amd64',
  'obliguard-agent-linux-arm64':     'obliguard-agent-linux-arm64',
  'obliguard-agent-darwin-amd64':    'obliguard-agent-darwin-amd64',
  'obliguard-agent-darwin-arm64':    'obliguard-agent-darwin-arm64',
  'obliguard-agent-freebsd-amd64':  'obliguard-agent-freebsd-amd64',
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

export function agentInstallerFreeBSD(req: Request, res: Response): void {
  const apiKey = req.query.key as string | undefined;

  const scriptPath = path.resolve(__dirname, '../../../../agent/installer/install-freebsd.sh');
  if (!fs.existsSync(scriptPath)) {
    res.status(404).json({ error: 'FreeBSD installer not available' });
    return;
  }

  let script = fs.readFileSync(scriptPath, 'utf-8');

  const serverUrl = `${req.protocol}://${req.get('host')}`;
  script = script.replace('__SERVER_URL__', serverUrl);
  if (apiKey) {
    script = script.replace('__API_KEY__', apiKey);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="install-freebsd.sh"');
  res.send(script);
}

export function agentInstallerWindowsMsi(_req: Request, res: Response): void {
  const msiPath = path.resolve(__dirname, '../../../../agent/dist/obliguard-agent.msi');
  if (!fs.existsSync(msiPath)) {
    res.status(404).json({ error: 'MSI installer not available (not yet built)' });
    return;
  }

  res.setHeader('Content-Type', 'application/x-msi');
  res.setHeader('Content-Disposition', 'attachment; filename="obliguard-agent.msi"');
  res.sendFile(msiPath);
}

// ── Offline install wizard (self-contained EXE / binary) ─────────────────────
//
// The base wizard (built separately into agent/dist/) embeds the MSI / agent
// binary via //go:embed. These endpoints append an "OBLI_CFG" tail-blob with
// the selected API key + server URL so the downloaded wizard boots with its
// fields pre-filled — the admin never pastes a key, and the target box needs
// no network to GET the installer (USB / RDP clipboard / scp it across).
//
// Wire format appended to the binary:
//   [json {serverUrl, apiKey}][magic 8B "OBLI_CFG"][len uint32 LE]
//
// Appending bytes breaks the wrapper's Authenticode signature (the embedded
// MSI stays signed) — operators see a single SmartScreen "Run anyway" prompt.
// Key lookup is tenant-scoped, mirroring listKeys, and the route is admin-gated.
const CFG_MAGIC = Buffer.from('OBLI_CFG', 'utf8');

/**
 * The ?server= override embedded in a wizard, validated: it ends up as the
 * agents' server (enrollment key + auto-update source), so a crafted download
 * link must not be able to plant a server (another host, another port, or an
 * http downgrade of the admin's own host). It is honoured only when:
 *   - the browser says the request comes from the app itself
 *     (Sec-Fetch-Site: same-origin — a link opened from a mail or another site
 *     arrives as "none" / "cross-site"), i.e. GlobalAddAgentModal sending
 *     window.location.origin;
 *   - it is a bare http(s) origin on the hostname in use or a configured one;
 *   - it does not downgrade https to http.
 * Otherwise it is ignored (APP_URL / request headers are used).
 */
function validatedServerOverride(req: Request): string | null {
  const raw = typeof req.query.server === 'string' ? req.query.server.trim() : '';
  if (!raw || raw.length > 2048) return null;
  if (req.headers['sec-fetch-site'] !== 'same-origin') return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (u.protocol === 'http:' && requestProto(req) === 'https') return null;
  const allowed = new Set<string>(configuredPublicOrigins().entries.map((e) => e.hostname));
  const here = requestAuthority(req)?.hostname;
  if (here) allowed.add(here);
  return allowed.has(u.hostname.toLowerCase()) ? u.origin : null;
}

function inferServerUrl(req: Request): string {
  // 1. Validated ?server= (the client sends window.location.origin, i.e. the
  //    exact public URL the admin is using, port included).
  const override = validatedServerOverride(req);
  if (override) return override;
  // 2. The configured public URL of this instance.
  if (process.env.APP_URL) {
    try { return new URL(process.env.APP_URL.includes('://') ? process.env.APP_URL : `https://${process.env.APP_URL}`).origin; } catch { /* malformed: fall through */ }
  }
  // 3. Best effort from the request (first X-Forwarded-Proto value, Host authority).
  const authority = requestAuthority(req)?.authority ?? '';
  return authority ? `${requestProto(req)}://${authority}` : '';
}

async function buildWizardPayload(req: Request, baseBin: Buffer): Promise<Buffer> {
  const keyIdRaw = req.query.keyId;
  const keyId = typeof keyIdRaw === 'string' ? parseInt(keyIdRaw, 10) : NaN;
  if (!Number.isFinite(keyId)) return baseBin;

  const apiKey = await agentService.getKeyById(keyId, req.tenantId);
  if (!apiKey) return baseBin;

  const cfg = JSON.stringify({ serverUrl: inferServerUrl(req), apiKey });
  const cfgBuf = Buffer.from(cfg, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(cfgBuf.length, 0);
  return Buffer.concat([baseBin, cfgBuf, CFG_MAGIC, lenBuf]);
}

export async function agentInstallerWizard(req: Request, res: Response): Promise<void> {
  const exePath = path.resolve(__dirname, '../../../../agent/dist/obliguard-installer-wizard.exe');
  if (!fs.existsSync(exePath)) {
    res.status(404).json({ error: 'Wizard installer not available (not yet built)' });
    return;
  }
  const payload = await buildWizardPayload(req, fs.readFileSync(exePath));
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="obliguard-installer-wizard.exe"');
  res.setHeader('Content-Length', String(payload.length));
  res.send(payload);
}

export async function agentInstallerWizardLinux(req: Request, res: Response): Promise<void> {
  const binPath = path.resolve(__dirname, '../../../../agent/dist/obliguard-installer-wizard-linux-amd64');
  if (!fs.existsSync(binPath)) {
    res.status(404).json({ error: 'Linux wizard not available (not yet built)' });
    return;
  }
  const payload = await buildWizardPayload(req, fs.readFileSync(binPath));
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="obliguard-installer-wizard-linux-amd64"');
  res.setHeader('Content-Length', String(payload.length));
  res.send(payload);
}

// ── Admin: Device Stats ──────────────────────────────────────────────────────

export async function getDeviceStats(req: Request, res: Response): Promise<void> {
  const online = await agentService.countOnlineDevices(req.tenantId);
  res.json({ success: true, data: { online } });
}

// ── Admin: API Keys ──────────────────────────────────────────────────────────

export async function listKeys(req: Request, res: Response): Promise<void> {
  const keys = await agentService.listKeys(req.tenantId);
  res.json({ success: true, data: keys });
}

export async function createKey(req: Request, res: Response): Promise<void> {
  const { name } = req.body as { name: string };
  if (!name?.trim()) {
    res.status(400).json({ success: false, error: 'Name is required' });
    return;
  }
  const userId = req.session?.userId ?? 0;
  const key = await agentService.createKey(name.trim(), userId, req.tenantId);
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
  const device = await requireDeviceInTenant(req, res, Number(req.params.id));
  if (!device) return;
  res.json({ success: true, data: device });
}

export async function listDevices(req: Request, res: Response): Promise<void> {
  const status = req.query.status as string | undefined;
  const validStatuses = ['pending', 'approved', 'refused', 'suspended'];
  const devices = await agentService.listDevices(
    req.tenantId,
    validStatuses.includes(status ?? '') ? (status as 'pending' | 'approved' | 'refused' | 'suspended') : undefined,
  );

  res.json({ success: true, data: devices });
}

export async function updateDevice(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  if (!(await requireDeviceInTenant(req, res, id))) return;
  const {
    status, groupId, checkIntervalSeconds, maxMissedPushes, agentThresholds, name,
    heartbeatMonitoring, sensorDisplayNames, overrideGroupSettings, displayConfig,
    notificationTypes, wanMatchingEnabled, evaluateOnly,
  } = req.body as {
    status?: 'approved' | 'refused' | 'pending' | 'suspended';
    groupId?: number | null;
    checkIntervalSeconds?: number;
    maxMissedPushes?: number | null;
    agentThresholds?: AgentThresholds;
    name?: string | null;
    heartbeatMonitoring?: boolean;
    sensorDisplayNames?: Record<string, string> | null;
    overrideGroupSettings?: boolean;
    displayConfig?: import('@obliview/shared').AgentDisplayConfig | null;
    notificationTypes?: import('@obliview/shared').NotificationTypeConfig | null;
    wanMatchingEnabled?: boolean;
    evaluateOnly?: boolean;
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
    ...('maxMissedPushes' in req.body ? { maxMissedPushes } : {}),
    name,
    heartbeatMonitoring,
    sensorDisplayNames,
    overrideGroupSettings,
    displayConfig,
    ...('notificationTypes' in req.body ? { notificationTypes } : {}),
    ...('wanMatchingEnabled' in req.body ? { wanMatchingEnabled } : {}),
    ...('evaluateOnly' in req.body ? { evaluateOnly } : {}),
  });

  if (!device) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }

  res.json({ success: true, data: device });
}

// ── Admin: Device Metrics ────────────────────────────────────────────────────

export async function getDeviceMetrics(_req: Request, res: Response): Promise<void> {
  // Obliguard agents push IP events, not hardware metrics.
  res.status(404).json({ success: false, error: 'No metrics available for Obliguard agents' });
}

export async function deleteDevice(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  if (!(await requireDeviceInTenant(req, res, id))) return;
  const ok = await agentService.deleteDevice(id);
  if (!ok) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }
  res.json({ success: true });
}

// ── Admin: Bulk Device Operations ────────────────────────────────────────────

export async function bulkDeleteDevices(req: Request, res: Response): Promise<void> {
  const { deviceIds } = req.body as { deviceIds: number[] };
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    res.status(400).json({ success: false, error: 'deviceIds array required' });
    return;
  }
  const ids = isMasterTenant(req.tenantId)
    ? deviceIds
    : await agentService.filterDeviceIdsByTenant(deviceIds, req.tenantId);
  await agentService.bulkDeleteDevices(ids);
  res.json({ success: true });
}

export async function bulkUpdateDevices(req: Request, res: Response): Promise<void> {
  const { deviceIds, groupId, heartbeatMonitoring, overrideGroupSettings, status } = req.body as {
    deviceIds: number[];
    groupId?: number | null;
    heartbeatMonitoring?: boolean;
    overrideGroupSettings?: boolean;
    status?: 'approved' | 'suspended';
  };
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    res.status(400).json({ success: false, error: 'deviceIds array required' });
    return;
  }
  const ids = isMasterTenant(req.tenantId)
    ? deviceIds
    : await agentService.filterDeviceIdsByTenant(deviceIds, req.tenantId);
  await agentService.bulkUpdateDevices(ids, { groupId, heartbeatMonitoring, overrideGroupSettings, status });
  res.json({ success: true });
}

export async function bulkDeviceCommand(req: Request, res: Response): Promise<void> {
  const { deviceIds, command } = req.body as { deviceIds: number[]; command: string };
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    res.status(400).json({ success: false, error: 'deviceIds array required' });
    return;
  }
  if (!command) {
    res.status(400).json({ success: false, error: 'command required' });
    return;
  }
  const ids = isMasterTenant(req.tenantId)
    ? deviceIds
    : await agentService.filterDeviceIdsByTenant(deviceIds, req.tenantId);
  await agentService.bulkSendCommand(ids, command);
  res.json({ success: true });
}

export async function sendDeviceCommand(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  if (!(await requireDeviceInTenant(req, res, id))) return;
  const { command } = req.body as { command: string };
  if (!command) {
    res.status(400).json({ success: false, error: 'command required' });
    return;
  }
  const ok = await agentService.sendCommand(id, command);
  if (!ok) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }
  res.json({ success: true });
}

/**
 * GET /agent/devices/:id/templates
 * Returns resolved service template configs for this agent
 * (after walking group inheritance chain).
 */
export async function getDeviceTemplates(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  if (!(await requireDeviceInTenant(req, res, id))) return;
  const configs = await serviceTemplateService.getResolvedForDevice(id);
  res.json({ success: true, data: configs });
}
