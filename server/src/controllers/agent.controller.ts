import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { agentService } from '../services/agent.service';
import { serviceTemplateService } from '../services/serviceTemplate.service';
import {
  agentListService, AGENT_LIST_CHIPS, AGENT_LIST_SORT_FIELDS, AGENT_LIST_DEVICE_TYPES,
  AGENT_LIST_DEFAULT_PAGE_SIZE, AGENT_LIST_MAX_PAGE_SIZE, AGENT_LIST_MAX_SEARCH,
} from '../services/agentList.service';
import type { AgentListChip, AgentListDeviceType, AgentListQuery, AgentListSortField } from '../services/agentList.service';
import { configuredPublicOrigins, requestAuthority, requestProto } from '../utils/publicOrigin';
import { obliguardHub } from '../services/obliguardHub.service';
import { agentCommandService, hasAgentCapability, isAgentCommandType } from '../services/agentCommand.service';
import {
  resolveRequestAgent, requestAgentScope, scopeAgentIds, scopeAgentLevel, intersectAgentIds,
} from '../services/agentScope.service';
import type { AgentNeed } from '../services/agentScope.service';
import { permissionService } from '../services/permission.service';
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
import { auditService } from '../services/audit.service';
import { legacyTypesToFlags, normalizeSettingValue, writableDefinition } from '../services/settings.service';
import { agentUpdateRollout } from '../services/agentUpdateRollout.service';
import type { RolloutScope } from '../services/agentUpdateRollout.service';
import type { AgentThresholds, AgentDevice, AgentUpdatePolicy, AgentUpdateRequestResult, PermissionLevel } from '@obliview/shared';

/**
 * Resolve a device by :id for a request (agentScope.resolveRequestAgent):
 *   - tenant rule (A5): reads may cross tenants from the Default tenant (god
 *     view); a write follows the operating tenant, with no platform-admin
 *     bypass (403 from Default, 404 elsewhere);
 *   - team rule (RBAC-8): a user restricted by team grants gets 404 on an
 *     agent no grant covers and 403 on a write to a read-only one.
 * Writes also need the tenant capability (route guard). Writes the error and
 * returns null when refused.
 */
async function requireDevice(
  req: Request,
  res: Response,
  id: unknown,
  need: AgentNeed,
): Promise<AgentDevice | null> {
  const r = await resolveRequestAgent(req, id, need);
  if (!r.ok) {
    res.status(r.status).json({ success: false, error: r.error });
    return null;
  }
  const device = await agentService.getDeviceById(r.agent.id);
  if (!device) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return null;
  }
  return withAccessLevel(device, r.permission);
}

/** Read access to a device by :id (see requireDevice). */
function requireDeviceInTenant(req: Request, res: Response, id: unknown): Promise<AgentDevice | null> {
  return requireDevice(req, res, id, 'read');
}

/** Write access to a device by :id (see requireDevice). */
function requireDeviceWritable(req: Request, res: Response, id: unknown): Promise<AgentDevice | null> {
  return requireDevice(req, res, id, 'write');
}

/**
 * Audit row of an action on one agent, filed in the agent's tenant (a Default
 * admin acting on a customer agent leaves a trace in that tenant's log) and
 * linked to the agent (its Activity tab).
 */
function auditDevice(
  req: Request,
  device: Pick<AgentDevice, 'id' | 'tenantId' | 'hostname' | 'name'>,
  action: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  return auditService.logReq(req, {
    action,
    targetType: 'agent',
    targetId: device.id,
    deviceId: device.id,
    tenantId: device.tenantId ?? undefined,
    details: { hostname: device.name || device.hostname || null, ...details },
  });
}

/** One audit row per agent of a bulk action (operating tenant: bulk ids never cross it). */
function auditDevices(req: Request, ids: number[], action: string, details: Record<string, unknown> = {}): Promise<void> {
  return auditService.logReqMany(req, ids.map((id) => ({
    action, targetType: 'agent', targetId: id, deviceId: id, details: { bulk: true, ...details },
  })));
}

/** Audit action of a queued agent command. */
function commandAuditAction(command: string): string {
  return command === 'uninstall' ? 'agent.uninstall_requested' : 'agent.command_sent';
}

/**
 * The caller's team-level access to the device ('rw' without team
 * restriction): the UI hides edit actions on 'ro' agents. The tenant
 * capabilities still decide which writes are allowed.
 */
function withAccessLevel<T extends AgentDevice>(device: T, level: PermissionLevel): T & { accessLevel: PermissionLevel } {
  return Object.assign(device, { accessLevel: level });
}

/**
 * Bulk write ids: the operating tenant only (no master bypass, A5), then the
 * agents the caller may write through their teams (RBAC-8). Others are dropped.
 */
async function writableBulkIds(req: Request, requested: number[]): Promise<number[]> {
  const inTenant = await agentService.filterDeviceIdsByTenant(requested, req.tenantId);
  return intersectAgentIds(inTenant, scopeAgentIds(await requestAgentScope(req), 'write'));
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
  const filePath = agentPath('dist', binaryName);

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

// ── Installer scripts ───────────────────────────────────────────────────────
//
// The scripts are piped to a root shell (`curl … | sudo bash`), so nothing a
// request controls is pasted into them verbatim:
//   - the server URL is the validated public origin (inferServerUrl: APP_URL /
//     configured origins), never req.protocol + the Host header — behind a
//     proxy that gave http:// URLs, and a forged Host planted another server;
//   - ?key= is embedded only when it is a well-formed key (a crafted link must
//     not inject shell code into a script fetched from the real server).

/** An agent API key as embedded in an installer (keys are UUIDs; legacy keys stay [A-Za-z0-9._-]). */
const INSTALLER_KEY_RE = /^[A-Za-z0-9._-]{8,128}$/;

/** A file under the repo-level agent/ folder (dist layout, then src layout under tsx). */
function agentPath(...parts: string[]): string {
  return path.join(resolveAgentRoot() ?? path.resolve(__dirname, '../../../../agent'), ...parts);
}

function sendInstallerScript(req: Request, res: Response, file: string, notFound: string): void {
  const scriptPath = agentPath('installer', file);
  if (!fs.existsSync(scriptPath)) {
    res.status(404).json({ error: notFound });
    return;
  }

  let script = fs.readFileSync(scriptPath, 'utf-8');

  // Replacer functions: a '$' in a value is never read as a replacement pattern.
  const serverUrl = inferServerUrl(req);
  script = script.replace('__SERVER_URL__', () => serverUrl);
  const apiKey = typeof req.query.key === 'string' ? req.query.key.trim() : '';
  if (apiKey && INSTALLER_KEY_RE.test(apiKey)) {
    script = script.replace('__API_KEY__', () => apiKey);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(script);
}

export function agentInstallerLinux(req: Request, res: Response): void {
  sendInstallerScript(req, res, 'install.sh', 'Installer not available');
}

export function agentInstallerWindows(req: Request, res: Response): void {
  sendInstallerScript(req, res, 'install.ps1', 'Installer not available');
}

export function agentInstallerMacos(req: Request, res: Response): void {
  sendInstallerScript(req, res, 'install-macos.sh', 'macOS installer not available');
}

export function agentInstallerFreeBSD(req: Request, res: Response): void {
  sendInstallerScript(req, res, 'install-freebsd.sh', 'FreeBSD installer not available');
}

export function agentInstallerWindowsMsi(_req: Request, res: Response): void {
  const msiPath = agentPath('dist', 'obliguard-agent.msi');
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

let unconfiguredOriginWarned = false;

/**
 * The server URL embedded in installers and wizards (agents enrol against it
 * and self-update from it):
 *   1. a validated ?server= (wizards downloaded from the app itself);
 *   2. a configured public origin (APP_URL, CLIENT_ORIGIN fallback,
 *      SSO_ALLOWED_HOSTS): the one for the hostname in use, else the first
 *      (APP_URL) — a forged Host never ends up in a script;
 *   3. nothing configured: best effort from the request (logged once).
 */
function inferServerUrl(req: Request): string {
  const override = validatedServerOverride(req);
  if (override) return override;
  const { entries } = configuredPublicOrigins();
  if (entries.length > 0) {
    const here = requestAuthority(req)?.hostname;
    const match = here ? entries.find((e) => e.hostname === here) : undefined;
    return (match ?? entries[0]).build(requestProto(req));
  }
  if (!unconfiguredOriginWarned) {
    unconfiguredOriginWarned = true;
    logger.warn('Agent installers: no APP_URL configured — the server URL is taken from the request Host; set APP_URL to the public URL of this instance');
  }
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
  const exePath = agentPath('dist', 'obliguard-installer-wizard.exe');
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
  const binPath = agentPath('dist', 'obliguard-installer-wizard-linux-amd64');
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
  const online = await agentService.countOnlineDevices(req.tenantId, scopeAgentIds(await requestAgentScope(req)));
  res.json({ success: true, data: { online } });
}

// ── Admin: Devices ──────────────────────────────────────────────────────────

export async function getDevice(req: Request, res: Response): Promise<void> {
  const device = await requireDeviceInTenant(req, res, req.params.id);
  if (!device) return;
  res.json({ success: true, data: device });
}

/**
 * GET /agent/devices?status=&groupId=&recursive=1
 * groupId: that group's devices (recursive=1: the whole subtree through
 * group_closure); 'none' = ungrouped devices. An unknown status is ignored
 * (all statuses), as before. Tenant scope unchanged (Default keeps the read
 * god view); a user restricted by team grants only lists the granted agents
 * (RBAC-8). Each device carries the caller's accessLevel ('ro' | 'rw').
 *
 * With ?paged=1 (W10-1, the /agents fleet list) the answer is one page,
 * { rows, total, page, pageSize, counts }, filtered and sorted server-side:
 *   q (hostname / name / IP), chips=online,offline,… (OR-ed), groupId +
 *   recursive, tenants=1,2 (god view only), type=agent|mikrotik|m365,
 *   sortBy, sortOrder=asc|desc, page (1-based), pageSize (<= 200).
 * The unpaged answer (a bare device array) is kept for the existing callers.
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

  if (req.query.paged === '1' || req.query.paged === 'true') {
    const parsed = parsePagedListQuery(req.query);
    if (typeof parsed === 'string') {
      res.status(400).json({ success: false, error: parsed });
      return;
    }
    const scope = await requestAgentScope(req);
    const result = await agentListService.listAgentsPaged({
      ...parsed,
      tenantId: req.tenantId,
      visibleIds: scopeAgentIds(scope),
      groupId,
      recursive,
    });
    result.rows.forEach((d) => withAccessLevel(d, scopeAgentLevel(scope, d.id) ?? 'ro'));
    res.json({ success: true, data: result });
    return;
  }

  const scope = await requestAgentScope(req);
  const devices = await agentService.listDevices(
    req.tenantId,
    validStatuses.includes(status ?? '') ? (status as 'pending' | 'approved' | 'refused' | 'suspended') : undefined,
    { groupId, recursive, visibleIds: scopeAgentIds(scope) },
  );

  res.json({ success: true, data: devices.map((d) => withAccessLevel(d, scopeAgentLevel(scope, d.id) ?? 'ro')) });
}

/** A comma-separated query value as a list ('' and absent = empty). */
function csvParam(raw: unknown): string[] | null {
  if (raw === undefined || raw === '') return [];
  if (typeof raw !== 'string' || raw.length > 512) return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** A positive integer query value within [1, max], or the fallback when absent; null when invalid. */
function intParam(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : null;
}

/** The ?paged=1 filters (groupId / recursive are parsed by listDevices), or an error message. */
function parsePagedListQuery(query: Request['query']): Omit<AgentListQuery, 'tenantId' | 'visibleIds' | 'groupId' | 'recursive'> | string {
  const search = typeof query.q === 'string' ? query.q.slice(0, AGENT_LIST_MAX_SEARCH) : undefined;
  if (query.q !== undefined && typeof query.q !== 'string') return 'Invalid q';

  const chips = csvParam(query.chips);
  if (chips === null || !chips.every((c) => (AGENT_LIST_CHIPS as readonly string[]).includes(c))) return 'Invalid chips';

  const tenantsRaw = csvParam(query.tenants);
  if (tenantsRaw === null || !tenantsRaw.every((v) => /^\d{1,9}$/.test(v) && Number(v) > 0)) return 'Invalid tenants';

  let deviceType: AgentListDeviceType | undefined;
  if (query.type !== undefined && query.type !== '') {
    if (typeof query.type !== 'string' || !(AGENT_LIST_DEVICE_TYPES as readonly string[]).includes(query.type)) return 'Invalid type';
    deviceType = query.type as AgentListDeviceType;
  }

  let sortBy: AgentListSortField | undefined;
  if (query.sortBy !== undefined && query.sortBy !== '') {
    if (typeof query.sortBy !== 'string' || !(AGENT_LIST_SORT_FIELDS as readonly string[]).includes(query.sortBy)) return 'Invalid sortBy';
    sortBy = query.sortBy as AgentListSortField;
  }
  let sortOrder: 'asc' | 'desc' | undefined;
  if (query.sortOrder !== undefined && query.sortOrder !== '') {
    if (query.sortOrder !== 'asc' && query.sortOrder !== 'desc') return 'Invalid sortOrder';
    sortOrder = query.sortOrder;
  }

  const page = intParam(query.page, 1, 1_000_000);
  if (page === null) return 'Invalid page';
  const pageSize = intParam(query.pageSize, AGENT_LIST_DEFAULT_PAGE_SIZE, AGENT_LIST_MAX_PAGE_SIZE);
  if (pageSize === null) return 'Invalid pageSize';

  return {
    search,
    chips: chips as AgentListChip[],
    tenantIds: tenantsRaw.map(Number),
    deviceType,
    sortBy,
    sortOrder,
    page,
    pageSize,
  };
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

  // IPS settings cascade (W13): validate the agent-level values before any
  // write (thresholds below), so a 400 leaves nothing half applied.
  if (checkIntervalSeconds !== undefined) {
    normalizeSettingValue(writableDefinition('checkIntervalSeconds', 'agent'), checkIntervalSeconds);
  }
  if (maxMissedPushes !== undefined && maxMissedPushes !== null) {
    normalizeSettingValue(writableDefinition('maxMissedPushes', 'agent'), maxMissedPushes);
  }
  if ('notificationTypes' in req.body) {
    const flags = legacyTypesToFlags(notificationTypes ?? null);
    if (flags) normalizeSettingValue(writableDefinition('notificationTypes', 'agent'), flags);
  }

  // Update policy (C17-1): the device is already in the operating tenant
  // (requireDeviceWritable, no platform-admin bypass).
  const hasPolicy = 'updatePolicy' in req.body;
  if (hasPolicy && !isUpdatePolicyInput(updatePolicy)) {
    res.status(400).json({ success: false, error: 'Invalid updatePolicy' });
    return;
  }
  // Owner directive (C17): update POLICY writes stay platform-admin only, at
  // every level (agents.manage covers the other device fields).
  if (hasPolicy && req.session?.role !== 'admin') {
    res.status(403).json({ success: false, error: 'The agent update policy is managed by platform administrators' });
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
      await auditDevice(req, loaded, 'agent.reinstated', releaseBinding ? { bindingReleased: true } : {});
      res.json({ success: true, data: device });
      return;
    }

    // First-time approval (pending → approved): create monitor
    const userId = req.session?.userId ?? 0;
    // No groupId in the body keeps the registration group (or the key's default
    // group, W10-2); an explicit null still means "no group".
    const approveGroup = 'groupId' in req.body ? (groupId ?? null) : undefined;
    const device = await agentService.approveDevice(id, userId, approveGroup, agentThresholds);
    if (!device) {
      res.status(404).json({ success: false, error: 'Device not found' });
      return;
    }
    // Apply the name if provided alongside approval
    if (name !== undefined) {
      await agentService.updateDevice(id, { name });
    }
    await applyRelease(device);
    await auditDevice(req, loaded, 'agent.approved', {
      groupId: device.groupId ?? null,
      ...(releaseBinding ? { bindingReleased: true } : {}),
    });
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
  const fields = Object.keys(req.body as object).filter((k) => k !== 'status');
  const statusAction = status === 'refused' ? 'agent.refused'
    : status === 'suspended' ? 'agent.suspended'
    : status === 'pending' ? 'agent.reset_pending'
    : null;
  if (statusAction) await auditDevice(req, loaded, statusAction, { previousStatus: loaded.status });
  if (fields.length > 0) {
    await auditDevice(req, loaded, releaseBinding && fields.length === 1 ? 'agent.binding_released' : 'agent.updated', {
      fields,
      ...('name' in req.body ? { name: name ?? null } : {}),
      ...('groupId' in req.body ? { groupId: groupId ?? null, previousGroupId: loaded.groupId ?? null } : {}),
      ...('evaluateOnly' in req.body ? { evaluateOnly } : {}),
      ...(hasPolicy ? { updatePolicyFrom: loaded.updatePolicy ?? null, updatePolicyTo: updatePolicy ?? null } : {}),
      ...(releaseBinding ? { bindingReleased: true } : {}),
    });
  }
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
  await auditDevice(req, device, 'agent.deleted', { uuid: device.uuid, deviceType: device.deviceType ?? null });
  res.json({ success: true });
}

// ── Admin: Bulk Device Operations ────────────────────────────────────────────
// Bulk writes follow the operating tenant, with no master bypass (A5), and the
// caller's team grants (RBAC-8): foreign, hidden and read-only ids are
// silently dropped. Responses carry { affected, skipped }.

export async function bulkDeleteDevices(req: Request, res: Response): Promise<void> {
  const requested = sanitizeDeviceIds((req.body as { deviceIds?: unknown })?.deviceIds);
  if (!requested) {
    res.status(400).json({ success: false, error: 'deviceIds array required' });
    return;
  }
  const ids = await writableBulkIds(req, requested);
  const affected = await agentService.bulkDeleteDevices(ids, req.tenantId);
  if (affected > 0) await auditDevices(req, ids, 'agent.deleted');
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
  if (hasPolicy && req.session?.role !== 'admin') {
    res.status(403).json({ success: false, error: 'The agent update policy is managed by platform administrators' });
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
  const ids = await writableBulkIds(req, requested);
  const affected = await agentService.bulkUpdateDevices(
    ids, { groupId, overrideGroupSettings, status, ...(hasPolicy ? { updatePolicy } : {}) }, req.tenantId,
  );
  if (hasPolicy && affected > 0) {
    logger.info({
      event: 'agent_update_device_policy', userId: req.session?.userId ?? null, tenantId: req.tenantId, deviceIds: ids.slice(0, 50), count: affected, to: updatePolicy ?? null,
    }, 'Agent update policy changed (bulk)');
  }
  if (affected > 0) {
    const action = status === 'approved' ? 'agent.approved' : status === 'suspended' ? 'agent.suspended' : 'agent.updated';
    await auditDevices(req, ids, action, {
      ...(groupId !== undefined ? { groupId } : {}),
      ...(overrideGroupSettings !== undefined ? { overrideGroupSettings } : {}),
      ...(hasPolicy ? { updatePolicyTo: updatePolicy ?? null } : {}),
    });
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
      res.json({ success: true, data: await requestUpdateForRequest(req, requested) });
      return;
    }
    const ids = await writableBulkIds(req, requested);
    // Uninstall goes through the command queue (W14-1): agents that already
    // have one pending are skipped.
    const queued = await agentService.bulkSendCommand(ids, command, req.tenantId, req.session?.userId ?? null);
    if (queued.length > 0) {
      await auditDevices(req, queued, commandAuditAction(command), { command });
      await obliguardHub.deliverQueuedCommands(queued);
    }
    const affected = queued.length;
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
    // 409 commandOutstanding while an uninstall is already pending (W14-1).
    const ok = await agentService.sendCommand(device.id, command, req.tenantId, req.session?.userId ?? null);
    if (!ok) {
      res.status(404).json({ success: false, error: 'Device not found' });
      return;
    }
    await auditDevice(req, device, commandAuditAction(command), { command });
    // A connected agent gets it now, the others on their next contact.
    await obliguardHub.deliverQueuedCommands([device.id]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── Agent command queue (W14-1) ──────────────────────────────────────────────
// Mirrors Obliance /commands: one row per request with its acknowledgement,
// result and history (agentCommand.service). Capabilities (route guard):
// uninstall → agents.delete (+ step-up), update → agents.update, restart /
// firewall_resync → agents.manage. Team scope: write access to the agent.

/** Default / maximum rows of GET /devices/:id/commands. */
const COMMAND_HISTORY_DEFAULT = 50;
const COMMAND_HISTORY_MAX = 200;

/** GET /agent/devices/:id/commands — the agent's command history, newest first. */
export async function listDeviceCommands(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const device = await requireDeviceInTenant(req, res, req.params.id);
    if (!device) return;
    const raw = Number(req.query.limit);
    const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, COMMAND_HISTORY_MAX) : COMMAND_HISTORY_DEFAULT;
    res.json({ success: true, data: await agentCommandService.list(device.id, limit) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /agent/devices/:id/commands { type } — queue a command. 'update' is
 * an update request (the update policy decides: off anywhere → 409). The
 * queued commands other than uninstall need an approved agent advertising
 * 'cmdqueue' (older agents only understand the config-frame uninstall).
 * 409 commandOutstanding while the same command is pending.
 */
export async function createDeviceCommand(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const type = (req.body as { type?: unknown } | undefined)?.type;
    if (type === 'update') {
      await requestDeviceUpdate(req, res, next);
      return;
    }
    if (!isAgentCommandType(type)) throw new AppError(400, 'Unknown command type', 'unknownCommand');
    const device = await requireDeviceWritable(req, res, req.params.id);
    if (!device) return;
    if ((device.deviceType ?? 'agent') !== 'agent') {
      throw new AppError(409, 'Commands are only available for agents', 'notAnAgent');
    }
    if (type !== 'uninstall') {
      if (device.status !== 'approved') {
        throw new AppError(409, 'Only approved agents can receive this command', 'notApproved');
      }
      if (!hasAgentCapability(device.capabilities)) {
        throw new AppError(409, 'This agent version cannot run this command: update the agent first', 'commandUnsupported');
      }
    }
    const queued = await agentCommandService.enqueue({
      deviceId: device.id,
      tenantId: req.tenantId,
      type,
      createdBy: req.session?.userId ?? null,
    });
    await auditDevice(req, device, commandAuditAction(type), { command: type, commandId: queued.id });
    // A connected agent gets it now, the others on their next contact.
    await obliguardHub.deliverQueuedCommands([device.id]);
    res.status(201).json({ success: true, data: (await agentCommandService.get(device.id, queued.id)) ?? queued });
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
      await auditDevice(req, device, 'agent.update_requested', { targetVersion: r.targetVersion, fromVersion: device.agentVersion ?? null });
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
      await auditDevice(req, device, 'agent.update_retried', { targetVersion: r.targetVersion, fromVersion: device.agentVersion ?? null });
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
    await auditDevice(req, device, 'agent.update_cancelled');
    res.json({ success: true, data: await agentService.getDeviceById(device.id) });
  } catch (err) {
    next(err);
  }
}

/**
 * requestUpdate on the agents the caller may write through their teams
 * (RBAC-8); the others count in skipped.notFound like foreign ids (strict
 * tenant scope inside the service).
 */
async function requestUpdateForRequest(req: Request, requested: number[]): Promise<AgentUpdateRequestResult> {
  const ids = intersectAgentIds(requested, scopeAgentIds(await requestAgentScope(req), 'write'));
  const data = await agentService.requestUpdate(ids, req.tenantId, req.session?.userId ?? null);
  data.skipped.notFound += requested.length - ids.length;
  if (data.requested > 0) {
    await auditService.logReq(req, {
      action: 'agent.bulk_update_requested', targetType: 'agent',
      details: { ids: ids.slice(0, 500), requested: data.requested, targetVersion: data.targetVersion, skipped: data.skipped },
    });
  }
  return data;
}

/** POST /agent/devices/bulk-request-update — foreign and non-writable ids are counted in skipped.notFound. */
export async function bulkRequestUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ids = sanitizeDeviceIds((req.body as { deviceIds?: unknown })?.deviceIds);
    if (!ids) {
      res.status(400).json({ success: false, error: 'deviceIds array required' });
      return;
    }
    requireServedVersion();
    res.json({ success: true, data: await requestUpdateForRequest(req, ids) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /agent/groups/:groupId/agent-update — outdated approved agents of the
 * group and its sub-groups. A user restricted by team grants must see the
 * group (404 otherwise) and only updates the agents they may write.
 */
export async function requestGroupUpdateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const groupId = Number(req.params.groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) throw new AppError(400, 'Invalid group ID');
    const g = await db('monitor_groups').where({ id: groupId }).first('tenant_id') as { tenant_id: number } | undefined;
    const verdict = g ? deviceAccessVerdict(g.tenant_id, req.tenantId, 'write') : 'not-found';
    if (verdict === 'forbidden') throw new AppError(403, 'This group belongs to another tenant: read-only from the Default tenant');
    if (verdict !== 'ok') throw new AppError(404, 'Group not found');
    const scope = await requestAgentScope(req);
    if (!scope.all) {
      const visible = await permissionService.getVisibleGroupIds(req.session.userId!, false, req.tenantId);
      if (visible !== 'all' && !visible.includes(groupId)) throw new AppError(404, 'Group not found');
    }
    requireServedVersion();
    const r = await agentService.requestGroupUpdate(groupId, req.tenantId, req.session?.userId ?? null, scopeAgentIds(scope, 'write'));
    if (!r) throw new AppError(404, 'Group not found');
    await auditService.logReq(req, {
      action: 'group.update_requested', targetType: 'group', targetId: groupId,
      details: { requested: r.requested, targetVersion: r.targetVersion, skipped: r.skipped },
    });
    res.json({ success: true, data: r });
  } catch (err) {
    next(err);
  }
}

// ── Fleet rollout (W12-4): preview, update all outdated, cancel all pending ──
// agents.update (route guard), no step-up. Scope: the operating tenant, the
// Default tenant covering every tenant (Obliance master scope); a user
// restricted by team grants only reaches the agents they may write. The
// 4-level update policy stays authoritative: a frozen agent is never offered.

async function rolloutScope(req: Request): Promise<RolloutScope> {
  return { tenantId: req.tenantId, writableIds: scopeAgentIds(await requestAgentScope(req), 'write') };
}

/** GET /agent/updates/preview — what "update all outdated" would do now, and the rollout progress. */
export async function getUpdateRolloutPreview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ success: true, data: await agentUpdateRollout.preview(await rolloutScope(req)) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /agent/updates/all {scopeTenantId?} — request the update of every
 * outdated, non-frozen agent of the scope (paced by the rollout window). The
 * client sends back the preview's scopeTenantId: a session that switched
 * tenant since (another tab) is refused with 409.
 */
export async function updateAllOutdatedAgents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as { scopeTenantId?: unknown };
    if (body.scopeTenantId !== undefined && body.scopeTenantId !== null && Number(body.scopeTenantId) !== req.tenantId) {
      throw new AppError(409, 'The operating tenant changed since the preview: review it again', 'rolloutScopeChanged');
    }
    requireServedVersion();
    const r = await agentUpdateRollout.updateAll(await rolloutScope(req), req.session?.userId ?? null);
    if (r.requested > 0) {
      await auditService.logReq(req, {
        action: 'agent.update_all_requested', targetType: 'agent',
        details: {
          requested: r.requested, targetVersion: r.targetVersion, allTenants: r.preview.allTenants,
          byTenant: r.byTenant, skipped: r.skipped, frozen: r.preview.frozen.total,
        },
      });
    }
    res.json({ success: true, data: r });
  } catch (err) {
    next(err);
  }
}

/** POST /agent/updates/cancel-all — clear every pending update request of the scope. */
export async function cancelAllAgentUpdates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const r = await agentUpdateRollout.cancelAll(await rolloutScope(req), req.session?.userId ?? null);
    if (r.cancelled > 0) {
      await auditService.logReq(req, {
        action: 'agent.update_all_cancelled', targetType: 'agent',
        details: { cancelled: r.cancelled, byTenant: r.byTenant, autoContinuing: r.autoContinuing },
      });
    }
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
      await auditService.logReq(req, {
        action: 'tenant.update_policy_changed', targetType: 'tenant', targetId: req.tenantId,
        details: { from: r.before ?? null, to: body.updatePolicy ?? null },
      });
      logger.info({
        event: 'agent_update_tenant_policy', userId: req.session?.userId ?? null, tenantId: req.tenantId, from: r.before, to: body.updatePolicy,
      }, 'Tenant agent update policy changed');
    }
    res.json({ success: true, data: await agentService.getTenantUpdatePolicyInfo(req.tenantId) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /agent/devices/versions — version distribution (Default keeps the read
 * god view), over the agents the caller sees (RBAC-8).
 */
export async function getDeviceVersionDistribution(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visibleIds = scopeAgentIds(await requestAgentScope(req));
    res.json({ success: true, data: await agentService.getVersionDistribution(req.tenantId, visibleIds) });
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
  const device = await requireDeviceInTenant(req, res, req.params.id);
  if (!device) return;
  const configs = await serviceTemplateService.getResolvedForDevice(device.id);
  res.json({ success: true, data: configs });
}
