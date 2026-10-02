import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { agentService } from '../services/agent.service';
import { serviceTemplateService } from '../services/serviceTemplate.service';
import { configuredPublicOrigins, requestAuthority, requestProto } from '../utils/publicOrigin';
import { obliguardHub } from '../services/obliguardHub.service';
import { checkDeviceAccess } from '../services/deviceAccess.service';
import {
  warnBindingRefused, getServedAgentVersion, resolveAgentRoot, getAgentManifest, agentFileSha256,
} from '../services/agent.service';
import { deviceAccessVerdict } from '../utils/tenantWriteRules';
import { isAgentUpdatePolicy } from '../utils/agentUpdate';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';
import { isDeviceUuidFormat } from '../utils/agentIdentity';
import { logger } from '../utils/logger';
import { clientIp as requestClientIp } from '../utils/clientIp';
import type { AgentThresholds, AgentDevice, AgentUpdatePolicy } from '@obliview/shared';
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

/**
 * Resolve a device by :id for a WRITE: it must belong to the operating tenant.
 * No platform-admin bypass (A5): from the Default tenant a foreign device is
 * read-only (403), from any other tenant it does not exist (404).
 */
async function requireDeviceWritable(
  req: Request,
  res: Response,
  id: unknown,
): Promise<AgentDevice | null> {
  const r = await checkDeviceAccess(id, req.tenantId, 'write');
  if (!r.ok) {
    res.status(r.status).json({ success: false, error: r.error });
    return null;
  }
  const device = await agentService.getDeviceById(r.row.id);
  if (!device) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return null;
  }
  return device;
}

/** 1..5000 unique positive integer ids, or null. */
function sanitizeDeviceIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5000) return null;
  const ids = [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
  return ids.length > 0 ? ids : null;
}

function isValidCommand(command: unknown): command is string {
  return typeof command === 'string' && command.length > 0 && command.length <= 50;
}

/**
 * Device commands accepted from the UI (C17-1). 'update' is not queued: it
 * becomes an explicit update request, delivered as latestVersion in the next
 * config frame when the update policy allows it.
 */
const ALLOWED_DEVICE_COMMANDS = new Set(['uninstall', 'update']);

/** updatePolicy body value: a policy, or null (inherit). */
function isUpdatePolicyInput(v: unknown): v is AgentUpdatePolicy | null {
  return v === null || isAgentUpdatePolicy(v);
}

function requireServedVersion(): void {
  if (getServedAgentVersion() === null) {
    throw new AppError(503, 'No agent version available on this server', 'versionUnavailable');
  }
}

// ── Push endpoint (called by agent) ──────────────────────────────────────────

export async function agentPush(req: Request, res: Response): Promise<void> {
  try {
    // agentApiKeyId and agentTenantId are set by agentAuth middleware
    const agentApiKeyId = (req as unknown as { agentApiKeyId: number; agentTenantId: number }).agentApiKeyId;
    const agentTenantId = (req as unknown as { agentApiKeyId: number; agentTenantId: number }).agentTenantId;
    const deviceUuid = req.headers['x-device-uuid'] as string | undefined;

    if (!isDeviceUuidFormat(deviceUuid)) {
      res.status(400).json({ error: 'Valid X-Device-UUID header required' });
      return;
    }

    // Right-most untrusted X-Forwarded-For hop (utils/clientIp): the
    // left-most entry is written by the client and must not be trusted.
    const clientIp = requestClientIp(req);

    const result = await agentService.handlePush(
      agentApiKeyId,
      agentTenantId,
      deviceUuid,
      clientIp,
      req.body,
    );

    // The internal enrolment flag never reaches HTTP clients.
    const { enrolmentDeferred: _d, ...payload } = result;
    const statusCode = payload.status === 'ok' ? 200 : payload.status === 'pending' ? 202 : 401;
    res.status(statusCode).json(payload);
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
    if (!isDeviceUuidFormat(deviceUuid)) {
      res.status(400).json({ error: 'Valid X-Device-UUID header required' });
      return;
    }
    // Identify device — must be approved and bound to the authenticated API key
    const v = await agentService.checkAgentBinding({ id: agentApiKeyId, tenant_id: agentTenantId }, deviceUuid);
    if (!v.ok || !v.device || v.device.status !== 'approved') {
      if (!v.ok) {
        warnBindingRefused({
          deviceUuid, deviceId: v.device.id, apiKeyId: agentApiKeyId, keyTenantId: agentTenantId,
          deviceTenantId: v.device.tenant_id, boundKeyId: v.device.api_key_id, deviceType: v.device.device_type, via: 'notify',
        });
      }
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    await agentService.setDeviceUpdating(v.device.id, v.device.tenant_id);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Public: version + download ──────────────────────────────────────────────

/**
 * GET /api/agent/version (public route).
 *
 * Deployed agents call it WITHOUT a session at startup (agent/main.go
 * checkForUpdate, legacy agent/src/index.js) and self-update to whatever it
 * returns; every build returns early on an empty version (main.go, index.js).
 * The update target is now delivered only in the config frame, gated by the
 * update policy (C17-1), so session-less callers get ''. The logged-in UI
 * (GlobalAddAgentModal) still gets the served version.
 */
export function agentVersion(req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.session?.userId) {
    res.json({ version: '' });
    return;
  }
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

/**
 * GET /api/agent/download/:filename (public, allow-listed names).
 *
 * Integrity (FLEET-AGENT-6, as Obliance): X-Content-SHA256 is the SHA-256 of
 * the file actually served (streamed, cached per mtime + size); an agent that
 * knows the header refuses a download that does not match it. X-Agent-Version
 * is the version the build manifest records for this artifact (absent when
 * unknown). A manifest hash that differs from the file is logged.
 */
export async function agentDownload(req: Request, res: Response): Promise<void> {
  const { filename } = req.params;

  const binaryName = Object.prototype.hasOwnProperty.call(ALLOWED_AGENT_BINARIES, filename)
    ? ALLOWED_AGENT_BINARIES[filename]
    : undefined;
  if (!binaryName) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // Same agent root as the served version (dist layout in prod, src layout under tsx).
  const filePath = path.join(resolveAgentRoot() ?? path.resolve(__dirname, '../../../../agent'), 'dist', binaryName);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Agent binary not available' });
    return;
  }

  let sha256: string;
  try {
    sha256 = await agentFileSha256(filePath);
  } catch {
    res.status(404).json({ error: 'Agent binary not available' });
    return;
  }
  const entry = getAgentManifest()?.artifacts[binaryName];
  if (entry?.sha256 && entry.sha256 !== sha256) {
    logger.warn({ file: binaryName, manifest: entry.sha256, actual: sha256 }, 'Agent download: file differs from the build manifest');
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${binaryName}"`);
  res.setHeader('X-Content-SHA256', sha256);
  if (entry?.version) res.setHeader('X-Agent-Version', entry.version);
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
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ success: false, error: 'Invalid API key ID' });
    return;
  }
  // Tenant-scoped, no master bypass: credentials are never god-viewed.
  const ok = await agentService.deleteKey(id, req.tenantId);
  if (!ok) {
    res.status(404).json({ success: false, error: 'API key not found' });
    return;
  }
  const closed = obliguardHub.disconnectByApiKey(id);
  logger.info({ apiKeyId: id, tenantId: req.tenantId, closed }, 'Agent API key deleted — live sessions closed');
  res.json({ success: true, data: { closedSessions: closed } });
}

// ── Admin: Devices ──────────────────────────────────────────────────────────

export async function getDevice(req: Request, res: Response): Promise<void> {
  const device = await requireDeviceInTenant(req, res, Number(req.params.id));
  if (!device) return;
  res.json({ success: true, data: device });
}

/**
 * GET /agent/devices?status=&groupId=&recursive=1
 * groupId: that group's devices (recursive=1: the whole subtree through
 * group_closure); 'none' = ungrouped devices. An unknown status is ignored
 * (all statuses), as before. Tenant scope unchanged (Default keeps the read
 * god view).
 */
export async function listDevices(req: Request, res: Response): Promise<void> {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const validStatuses = ['pending', 'approved', 'refused', 'suspended'];
  let groupId: number | null | undefined;
  const rawGroup = req.query.groupId;
  if (rawGroup !== undefined && rawGroup !== '') {
    if (rawGroup === 'none') {
      groupId = null;
    } else {
      const n = typeof rawGroup === 'string' && /^\d{1,9}$/.test(rawGroup) ? Number(rawGroup) : NaN;
      if (!Number.isSafeInteger(n) || n <= 0) {
        res.status(400).json({ success: false, error: 'Invalid groupId' });
        return;
      }
      groupId = n;
    }
  }
  const recursive = req.query.recursive === '1' || req.query.recursive === 'true';
  const devices = await agentService.listDevices(
    req.tenantId,
    validStatuses.includes(status ?? '') ? (status as 'pending' | 'approved' | 'refused' | 'suspended') : undefined,
    { groupId, recursive },
  );

  res.json({ success: true, data: devices });
}

export async function updateDevice(req: Request, res: Response): Promise<void> {
  const loaded = await requireDeviceWritable(req, res, req.params.id);
  if (!loaded) return;
  const id = loaded.id;
  const {
    status, groupId, checkIntervalSeconds, maxMissedPushes, agentThresholds, name,
    sensorDisplayNames, overrideGroupSettings, displayConfig,
    notificationTypes, wanMatchingEnabled, evaluateOnly, updatePolicy,
  } = req.body as {
    status?: 'approved' | 'refused' | 'pending' | 'suspended';
    groupId?: number | null;
    checkIntervalSeconds?: number;
    maxMissedPushes?: number | null;
    agentThresholds?: AgentThresholds;
    name?: string | null;
    sensorDisplayNames?: Record<string, string> | null;
    overrideGroupSettings?: boolean;
    displayConfig?: import('@obliview/shared').AgentDisplayConfig | null;
    notificationTypes?: import('@obliview/shared').NotificationTypeConfig | null;
    wanMatchingEnabled?: boolean;
    evaluateOnly?: boolean;
    updatePolicy?: AgentUpdatePolicy | null;
  };
  // heartbeatMonitoring (Obliview leftover) is no longer read: an old client may still send it.

  if (status !== undefined && !['approved', 'refused', 'pending', 'suspended'].includes(status)) {
    res.status(400).json({ success: false, error: 'Invalid status' });
    return;
  }

  // Update policy (C17-1): the device is already in the operating tenant
  // (requireDeviceWritable, no platform-admin bypass).
  const hasPolicy = 'updatePolicy' in req.body;
  if (hasPolicy && !isUpdatePolicyInput(updatePolicy)) {
    res.status(400).json({ success: false, error: 'Invalid updatePolicy' });
    return;
  }
  // The approval branch below does not apply updatePolicy: refuse instead of dropping it silently.
  if (hasPolicy && status === 'approved') {
    res.status(400).json({ success: false, error: 'updatePolicy cannot be combined with approval' });
    return;
  }

  // A device's group must belong to the device's tenant (also covers approval).
  if (groupId !== undefined && groupId !== null
    && !(Number.isInteger(groupId) && await agentService.isGroupInTenant(groupId, loaded.tenantId))) {
    res.status(400).json({ success: false, error: 'Invalid group' });
    return;
  }

  // Binding release (after a re-key): only `apiKeyId: null` is accepted.
  // Validated here, applied only once the rest of the update succeeded.
  const releaseBinding = 'apiKeyId' in req.body;
  if (releaseBinding) {
    if (req.body.apiKeyId !== null) {
      res.status(400).json({ success: false, error: 'apiKeyId can only be null (release the binding)' });
      return;
    }
    if (loaded.deviceType === 'mikrotik') {
      res.status(400).json({ success: false, error: 'A MikroTik device has no API-key binding' });
      return;
    }
  }
  // Release, then close the live channel: otherwise the old key's next
  // heartbeat re-claims the NULL binding. The first key that reconnects claims it.
  const applyRelease = async (d: AgentDevice | null): Promise<void> => {
    if (!releaseBinding) return;
    if (await agentService.releaseKeyBinding(loaded.id, loaded.tenantId, req.session?.userId ?? null)) {
      obliguardHub.disconnectDevice(loaded.uuid, 'Key binding released');
      if (d) d.apiKeyId = null;
    }
  };

  // Special handling for approval
  if (status === 'approved') {
    const currentDevice = loaded;

    if (currentDevice.status === 'suspended') {
      // Reinstate a suspended device: re-activate its monitor, no new monitor created
      await agentService.reinstateDevice(id);
      const device = await agentService.updateDevice(id, { status: 'approved', name });
      await applyRelease(device);
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
    // Apply the name if provided alongside approval
    if (name !== undefined) {
      await agentService.updateDevice(id, { name });
    }
    await applyRelease(device);
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
    sensorDisplayNames,
    overrideGroupSettings,
    displayConfig,
    ...('notificationTypes' in req.body ? { notificationTypes } : {}),
    ...('wanMatchingEnabled' in req.body ? { wanMatchingEnabled } : {}),
    ...('evaluateOnly' in req.body ? { evaluateOnly } : {}),
    ...(hasPolicy ? { updatePolicy } : {}),
  });

  if (device && hasPolicy) {
    logger.info({
      event: 'agent_update_device_policy', userId: req.session?.userId ?? null, tenantId: req.tenantId, deviceId: id, from: loaded.updatePolicy ?? null, to: updatePolicy ?? null,
    }, 'Agent update policy changed');
  }

  if (!device) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }

  await applyRelease(device);
  res.json({ success: true, data: device });
}

// ── Admin: Device Metrics ────────────────────────────────────────────────────

export async function getDeviceMetrics(_req: Request, res: Response): Promise<void> {
  // Obliguard agents push IP events, not hardware metrics.
  res.status(404).json({ success: false, error: 'No metrics available for Obliguard agents' });
}

export async function deleteDevice(req: Request, res: Response): Promise<void> {
  const device = await requireDeviceWritable(req, res, req.params.id);
  if (!device) return;
  const ok = await agentService.deleteDevice(device.id, req.tenantId);
  if (!ok) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }
  res.json({ success: true });
}

// ── Admin: Bulk Device Operations ────────────────────────────────────────────
// Bulk writes follow the operating tenant, with no master bypass (A5): foreign
// ids are silently dropped. Responses carry { affected, skipped }.

export async function bulkDeleteDevices(req: Request, res: Response): Promise<void> {
  const requested = sanitizeDeviceIds((req.body as { deviceIds?: unknown })?.deviceIds);
  if (!requested) {
    res.status(400).json({ success: false, error: 'deviceIds array required' });
    return;
  }
  const ids = await agentService.filterDeviceIdsByTenant(requested, req.tenantId);
  const affected = await agentService.bulkDeleteDevices(ids, req.tenantId);
  res.json({ success: true, data: { affected, skipped: requested.length - affected } });
}

export async function bulkUpdateDevices(req: Request, res: Response): Promise<void> {
  // heartbeatMonitoring (Obliview leftover) is ignored if an old client sends it.
  const { deviceIds, groupId, overrideGroupSettings, status, updatePolicy } = req.body as {
    deviceIds: unknown;
    groupId?: number | null;
    overrideGroupSettings?: boolean;
    status?: 'approved' | 'suspended';
    updatePolicy?: AgentUpdatePolicy | null;
  };
  const hasPolicy = 'updatePolicy' in (req.body as object);
  if (hasPolicy && !isUpdatePolicyInput(updatePolicy)) {
    res.status(400).json({ success: false, error: 'Invalid updatePolicy' });
    return;
  }
  const requested = sanitizeDeviceIds(deviceIds);
  if (!requested) {
    res.status(400).json({ success: false, error: 'deviceIds array required' });
    return;
  }
  if (status !== undefined && status !== 'approved' && status !== 'suspended') {
    res.status(400).json({ success: false, error: 'Invalid status' });
    return;
  }
  if (groupId !== undefined && groupId !== null
    && !(Number.isInteger(groupId) && await agentService.isGroupInTenant(groupId, req.tenantId))) {
    res.status(400).json({ success: false, error: 'Invalid group' });
    return;
  }
  const ids = await agentService.filterDeviceIdsByTenant(requested, req.tenantId);
  const affected = await agentService.bulkUpdateDevices(
    ids, { groupId, overrideGroupSettings, status, ...(hasPolicy ? { updatePolicy } : {}) }, req.tenantId,
  );
  if (hasPolicy && affected > 0) {
    logger.info({
      event: 'agent_update_device_policy', userId: req.session?.userId ?? null, tenantId: req.tenantId, deviceIds: ids.slice(0, 50), count: affected, to: updatePolicy ?? null,
    }, 'Agent update policy changed (bulk)');
  }
  res.json({ success: true, data: { affected, skipped: requested.length - affected } });
}

export async function bulkDeviceCommand(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { deviceIds, command } = req.body as { deviceIds: unknown; command: unknown };
    const requested = sanitizeDeviceIds(deviceIds);
    if (!requested) {
      res.status(400).json({ success: false, error: 'deviceIds array required' });
      return;
    }
    if (!isValidCommand(command)) {
      res.status(400).json({ success: false, error: 'command required' });
      return;
    }
    if (!ALLOWED_DEVICE_COMMANDS.has(command)) {
      res.status(400).json({ success: false, error: 'Unknown command' });
      return;
    }
    if (command === 'update') {
      requireServedVersion();
      // Strict tenant scope inside the service: foreign ids count as notFound.
      const data = await agentService.requestUpdate(requested, req.tenantId, req.session?.userId ?? null);
      res.json({ success: true, data });
      return;
    }
    const ids = await agentService.filterDeviceIdsByTenant(requested, req.tenantId);
    const affected = await agentService.bulkSendCommand(ids, command, req.tenantId);
    res.json({ success: true, data: { affected, skipped: requested.length - affected } });
  } catch (err) {
    next(err);
  }
}

export async function sendDeviceCommand(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { command } = req.body as { command: unknown };
    if (!isValidCommand(command)) {
      res.status(400).json({ success: false, error: 'command required' });
      return;
    }
    if (!ALLOWED_DEVICE_COMMANDS.has(command)) {
      res.status(400).json({ success: false, error: 'Unknown command' });
      return;
    }
    if (command === 'update') {
      await requestDeviceUpdate(req, res, next);
      return;
    }
    const device = await requireDeviceWritable(req, res, req.params.id);
    if (!device) return;
    const ok = await agentService.sendCommand(device.id, command, req.tenantId);
    if (!ok) {
      res.status(404).json({ success: false, error: 'Device not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── Agent update requests (C17-1) ────────────────────────────────────────────
// Open to members of the operating tenant holding monitor_rw (route guard).
// Writes follow the operating tenant, with no platform-admin bypass.

/** POST /agent/devices/:id/agent-update — "Update now" on one agent. */
export async function requestDeviceUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const device = await requireDeviceWritable(req, res, req.params.id);
    if (!device) return;
    requireServedVersion();
    const r = await agentService.requestUpdate([device.id], req.tenantId, req.session?.userId ?? null);
    if (r.requested === 1) {
      res.json({ success: true, data: await agentService.getDeviceById(device.id) });
      return;
    }
    if (r.skipped.off) throw new AppError(409, 'Updates are disabled for this agent (policy: off)', 'updatePolicyOff');
    if (r.skipped.current) throw new AppError(409, 'Agent is already up to date', 'alreadyCurrent');
    throw new AppError(409, 'Only approved agents that reported a version can be updated', 'notUpdatable');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /agent/devices/:id/update/retry — restart a failed or abandoned update
 * attempt (fresh budget of 3 offers, explicit request pinned to the served
 * version). Same permission and refusals as "Update now".
 */
export async function retryDeviceUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const device = await requireDeviceWritable(req, res, req.params.id);
    if (!device) return;
    requireServedVersion();
    const r = await agentService.retryUpdate(device.id, req.tenantId, req.session?.userId ?? null);
    if (r.requested === 1) {
      res.json({ success: true, data: await agentService.getDeviceById(device.id) });
      return;
    }
    if (r.skipped.off) throw new AppError(409, 'Updates are disabled for this agent (policy: off)', 'updatePolicyOff');
    if (r.skipped.current) throw new AppError(409, 'Agent is already up to date', 'alreadyCurrent');
    throw new AppError(409, 'Only approved agents that reported a version can be updated', 'notUpdatable');
  } catch (err) {
    next(err);
  }
}

/** DELETE /agent/devices/:id/agent-update — cancel a pending request. */
export async function cancelDeviceUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const device = await requireDeviceWritable(req, res, req.params.id);
    if (!device) return;
    await agentService.cancelUpdateRequest(device.id, req.tenantId, req.session?.userId ?? null);
    res.json({ success: true, data: await agentService.getDeviceById(device.id) });
  } catch (err) {
    next(err);
  }
}

/** POST /agent/devices/bulk-request-update — foreign ids are counted in skipped.notFound. */
export async function bulkRequestUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ids = sanitizeDeviceIds((req.body as { deviceIds?: unknown })?.deviceIds);
    if (!ids) {
      res.status(400).json({ success: false, error: 'deviceIds array required' });
      return;
    }
    requireServedVersion();
    const data = await agentService.requestUpdate(ids, req.tenantId, req.session?.userId ?? null);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/** POST /agent/groups/:groupId/agent-update — outdated approved agents of the group and its sub-groups. */
export async function requestGroupUpdateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const groupId = Number(req.params.groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) throw new AppError(400, 'Invalid group ID');
    const g = await db('monitor_groups').where({ id: groupId }).first('tenant_id') as { tenant_id: number } | undefined;
    const verdict = g ? deviceAccessVerdict(g.tenant_id, req.tenantId, 'write') : 'not-found';
    if (verdict === 'forbidden') throw new AppError(403, 'This group belongs to another tenant: read-only from the Default tenant');
    if (verdict !== 'ok') throw new AppError(404, 'Group not found');
    requireServedVersion();
    const r = await agentService.requestGroupUpdate(groupId, req.tenantId, req.session?.userId ?? null);
    if (!r) throw new AppError(404, 'Group not found');
    res.json({ success: true, data: r });
  } catch (err) {
    next(err);
  }
}

// ── Tenant level of the update policy (W2-1 owner amendment) ────────────────
// The OPERATING tenant's policy (global -> tenant -> group -> agent). Writes
// are platform-admin only (route guard), like the group and global levels.

/** GET /agent/update-policy/tenant — the operating tenant's policy and the effective global one. */
export async function getTenantUpdatePolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ success: true, data: await agentService.getTenantUpdatePolicyInfo(req.tenantId) });
  } catch (err) {
    next(err);
  }
}

/** PATCH /agent/update-policy/tenant {updatePolicy: auto|manual|off|null} */
export async function patchTenantUpdatePolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as { updatePolicy?: unknown };
    if (!('updatePolicy' in body) || !isUpdatePolicyInput(body.updatePolicy)) {
      throw new AppError(400, 'Invalid updatePolicy');
    }
    // requireTenant already refused a tab that shows another tenant (409).
    const r = await agentService.setTenantUpdatePolicy(req.tenantId, body.updatePolicy);
    if (!r) throw new AppError(404, 'Tenant not found');
    if (r.before !== body.updatePolicy) {
      logger.info({
        event: 'agent_update_tenant_policy', userId: req.session?.userId ?? null, tenantId: req.tenantId, from: r.before, to: body.updatePolicy,
      }, 'Tenant agent update policy changed');
    }
    res.json({ success: true, data: await agentService.getTenantUpdatePolicyInfo(req.tenantId) });
  } catch (err) {
    next(err);
  }
}

/** GET /agent/devices/versions — version distribution (Default keeps the read god view). */
export async function getDeviceVersionDistribution(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ success: true, data: await agentService.getVersionDistribution(req.tenantId) });
  } catch (err) {
    next(err);
  }
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
