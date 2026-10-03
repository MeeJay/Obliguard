/**
 * Agent update control (C17-1, W2-1) — pure helpers. No DB, no fs.
 *
 * Policy model: 'auto' | 'manual' | 'off' at four levels (global, tenant,
 * group chain, agent). 'off' at any level is absolute; otherwise the nearest
 * explicit value wins; nothing set anywhere = DEFAULT_AGENT_UPDATE_POLICY
 * ('manual').
 *
 * The version comparison mirrors the Go agent (agent/main.go parseSemver /
 * isStrictlyNewer) so the server never advertises a version the agent would
 * not install, and vice versa.
 */
import path from 'path';
import type { AgentUpdatePhase, AgentUpdatePolicy } from '@obliview/shared';
import { AGENT_REPORTED_UPDATE_PHASES, AGENT_UPDATE_POLICIES, DEFAULT_AGENT_UPDATE_POLICY } from '@obliview/shared';

/** An explicit "Update now" request lives 24 h. */
export const AGENT_UPDATE_REQUEST_TTL_MS = 24 * 3600 * 1000;
/** At most one update offer per device every 10 minutes. */
export const UPDATE_OFFER_MIN_INTERVAL_MS = 10 * 60 * 1000;
/**
 * At most 3 offers per (device, target version) under every policy, 'auto'
 * included (1 + 2 redeliveries, as Obliance UPDATE_AGENT_MAX_REDELIVERIES):
 * then the attempt is 'failed' ('no_progress') until an admin retries.
 */
export const UPDATE_REQUEST_MAX_OFFERS = 3;
/** An attempt stuck in a progress phase (or 'updating') this long is 'failed' ('timeout'). */
export const UPDATE_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
/** Phases after which nothing more happens for this target until a retry. */
export const TERMINAL_UPDATE_PHASES: readonly AgentUpdatePhase[] = ['succeeded', 'failed', 'cancelled'];
/** Phases reported by an agent that is applying the update. */
export const PROGRESS_UPDATE_PHASES: readonly AgentUpdatePhase[] = ['downloading', 'verifying', 'installing', 'restarting'];
/** Heartbeat capabilities: at most this many entries of at most this many characters. */
export const MAX_AGENT_CAPABILITIES = 32;
export const MAX_AGENT_CAPABILITY_LEN = 32;
/** Max stored length of an agent-reported update error. */
export const MAX_UPDATE_ERROR_LEN = 500;
/** Matches agent_devices.update_requested_version (varchar 64). */
export const MAX_AGENT_VERSION_LEN = 64;

/** Go strconv.Atoi: optional sign then digits only, else 0 (the Go code ignores the error). */
function goAtoi(s: string): number {
  return /^[+-]?\d+$/.test(s) ? Number(s) : 0;
}

/** Mirror of agent/main.go parseSemver: strip one 'v', SplitN(v, '.', 3), Atoi each part. */
export function parseAgentSemver(v: string | null | undefined): [number, number, number] {
  let s = String(v ?? '');
  if (s.startsWith('v')) s = s.slice(1);
  const parts = s.split('.');
  if (parts.length < 3) return [0, 0, 0];
  const p = [parts[0], parts[1], parts.slice(2).join('.')];
  return [goAtoi(p[0]), goAtoi(p[1]), goAtoi(p[2])];
}

/** Mirror of Go isStrictlyNewer(remote, current). */
export function isStrictlyNewerAgentVersion(remote: string | null | undefined, current: string | null | undefined): boolean {
  const r = parseAgentSemver(remote);
  const c = parseAgentSemver(current);
  if (r[0] !== c[0]) return r[0] > c[0];
  if (r[1] !== c[1]) return r[1] > c[1];
  return r[2] > c[2];
}

export function isAgentUpdatePolicy(v: unknown): v is AgentUpdatePolicy {
  return typeof v === 'string' && (AGENT_UPDATE_POLICIES as readonly string[]).includes(v);
}

/** A served agent/VERSION value we are willing to advertise. */
export function isValidServedAgentVersion(v: string): boolean {
  return v.length <= MAX_AGENT_VERSION_LEN && /^v?\d{1,9}\.\d{1,9}\.\d{1,9}([-+.][0-9A-Za-z.+-]*)?$/.test(v);
}

/**
 * Candidate repo-level agent/ folders for a module directory:
 *   [0] dist layout: server/dist/src/services → <repo>/agent (/app/agent in Docker);
 *   [1] src layout under tsx: server/src/services → <repo>/agent.
 */
export function agentRootCandidates(dir: string): string[] {
  return [path.resolve(dir, '../../../../agent'), path.resolve(dir, '../../../agent')];
}

export interface GroupPolicyEntry {
  groupId: number;
  tenantId: number;
  policy: AgentUpdatePolicy;
}

export interface ResolvedAgentUpdatePolicy {
  policy: AgentUpdatePolicy;
  source: 'agent' | 'group' | 'tenant' | 'global' | 'default';
  sourceGroupId: number | null;
}

/**
 * Resolve a device's effective policy over the four levels GLOBAL -> TENANT ->
 * GROUP (closure chain) -> AGENT. `groupChain` is ordered nearest first
 * (closure depth ascending, own group = depth 0) and already filtered to the
 * device's tenant.
 *
 *   - 'off' at any level is absolute; the highest level that froze the device
 *     is reported: global > tenant > farthest group > agent;
 *   - otherwise the nearest explicit value wins: agent > nearest group >
 *     tenant > global; nothing set = DEFAULT_AGENT_UPDATE_POLICY ('manual').
 *
 * The 3-argument form (device, chain, global) is the pre-tenant signature: no
 * tenant level.
 */
export function resolveAgentUpdatePolicy(
  devicePolicy: AgentUpdatePolicy | null,
  groupChain: GroupPolicyEntry[],
  tenantPolicy: AgentUpdatePolicy | null | undefined,
  globalPolicy: AgentUpdatePolicy | null | undefined,
): ResolvedAgentUpdatePolicy;
export function resolveAgentUpdatePolicy(
  devicePolicy: AgentUpdatePolicy | null,
  groupChain: GroupPolicyEntry[],
  globalPolicy: AgentUpdatePolicy | null | undefined,
): ResolvedAgentUpdatePolicy;
export function resolveAgentUpdatePolicy(
  devicePolicy: AgentUpdatePolicy | null,
  groupChain: GroupPolicyEntry[],
  a: AgentUpdatePolicy | null | undefined,
  b?: AgentUpdatePolicy | null,
): ResolvedAgentUpdatePolicy {
  // eslint-disable-next-line prefer-rest-params
  const withTenant = arguments.length >= 4;
  const tenantPolicy = withTenant ? a : null;
  const globalPolicy = withTenant ? b : a;
  // 1. Global kill-switch.
  if (globalPolicy === 'off') return { policy: 'off', source: 'global', sourceGroupId: null };
  // 2. Tenant freeze.
  if (tenantPolicy === 'off') return { policy: 'off', source: 'tenant', sourceGroupId: null };
  // 3. 'off' on any ancestor freezes the subtree: the farthest one is reported.
  for (let i = groupChain.length - 1; i >= 0; i--) {
    if (groupChain[i].policy === 'off') return { policy: 'off', source: 'group', sourceGroupId: groupChain[i].groupId };
  }
  // 4. Device freeze.
  if (devicePolicy === 'off') return { policy: 'off', source: 'agent', sourceGroupId: null };
  // 5. Nearest explicit value.
  if (devicePolicy) return { policy: devicePolicy, source: 'agent', sourceGroupId: null };
  if (groupChain.length > 0) return { policy: groupChain[0].policy, source: 'group', sourceGroupId: groupChain[0].groupId };
  if (tenantPolicy) return { policy: tenantPolicy, source: 'tenant', sourceGroupId: null };
  if (globalPolicy) return { policy: globalPolicy, source: 'global', sourceGroupId: null };
  return { policy: DEFAULT_AGENT_UPDATE_POLICY, source: 'default', sourceGroupId: null };
}

/** A pending "Update now" is live: set, pinned to the version served now, younger than the TTL. */
export function isUpdateRequestLive(o: {
  requestedAt: string | Date | null;
  requestedVersion: string | null;
  served: string | null;
  now: number;
}): boolean {
  if (!o.requestedAt || !o.requestedVersion || o.served === null) return false;
  if (o.requestedVersion !== o.served) return false;
  const at = o.requestedAt instanceof Date ? o.requestedAt.getTime() : Date.parse(String(o.requestedAt));
  if (!Number.isFinite(at)) return false;
  return o.now - at < AGENT_UPDATE_REQUEST_TTL_MS;
}

/** Whether latestVersion may be put in this device's config frame (before throttling). */
export function shouldAdvertiseUpdate(o: {
  served: string | null;
  reported: string;
  policy: AgentUpdatePolicy;
  requestLive: boolean;
  deviceType: string;
  status: string;
}): boolean {
  if (o.deviceType !== 'agent') return false;
  if (o.status !== 'approved') return false;
  if (o.served === null) return false;
  if (o.reported === '') return false;
  if (!isStrictlyNewerAgentVersion(o.served, o.reported)) return false;
  if (o.policy === 'off') return false;
  return o.policy === 'auto' || o.requestLive;
}

/**
 * Import sanitiser for monitor_groups.agent_group_config: known keys only, and
 * updatePolicy kept only when 'manual' or 'off' — an import never silently
 * turns auto-update on ('auto' and invalid values mean inherit).
 */
export function sanitizeImportedAgentGroupConfig(cfg: unknown): Record<string, unknown> | null {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const src = cfg as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['pushIntervalSeconds', 'maxMissedPushes', 'notificationTypes']) {
    if (k in src) out[k] = src[k];
  }
  if (src.updatePolicy === 'manual' || src.updatePolicy === 'off') out.updatePolicy = src.updatePolicy;
  return out;
}

// ── Heartbeat capabilities and update_status frames (W2-1) ──────────────────

/**
 * Heartbeat `capabilities`: strings only, trimmed, 1..32 characters, deduped,
 * at most 32 entries. Anything that is not an array yields null (= not
 * reported: the stored value is left untouched).
 */
export function sanitizeAgentCapabilities(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s.length === 0 || s.length > MAX_AGENT_CAPABILITY_LEN || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_AGENT_CAPABILITIES) break;
  }
  return out;
}

export interface ParsedUpdateStatus {
  targetVersion: string;
  phase: AgentUpdatePhase;
  error: string | null;
}

/** A valid update_status frame, or null (unknown phase, bad version: ignored). */
export function parseUpdateStatusFrame(msg: unknown): ParsedUpdateStatus | null {
  if (msg === null || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.targetVersion !== 'string' || !isValidServedAgentVersion(m.targetVersion)) return null;
  if (typeof m.phase !== 'string' || !(AGENT_REPORTED_UPDATE_PHASES as readonly string[]).includes(m.phase)) return null;
  const err = typeof m.error === 'string' && m.error.trim() ? m.error.trim().slice(0, MAX_UPDATE_ERROR_LEN) : null;
  return { targetVersion: m.targetVersion, phase: m.phase as AgentUpdatePhase, error: err };
}

// ── Build manifest (agent/dist/manifest.json, W2-1 / FLEET-AGENT-3) ─────────

export interface AgentManifestArtifact {
  sha256: string;
  size: number;
  version: string;
}

export interface AgentManifest {
  version: string;
  artifacts: Record<string, AgentManifestArtifact>;
}

/** Artifacts an updating agent downloads, one per supported os-arch. */
export const UPDATE_ARTIFACTS: readonly string[] = [
  'obliguard-agent.msi',
  'obliguard-agent-linux-amd64',
  'obliguard-agent-linux-arm64',
  'obliguard-agent-darwin-amd64',
  'obliguard-agent-darwin-arm64',
  'obliguard-agent-freebsd-amd64',
];

/** GOARCH of an osInfo.arch (the legacy Node agent reported Node's names). */
function goArch(arch: string): string {
  const a = arch.trim().toLowerCase();
  if (a === 'x64' || a === 'x86_64') return 'amd64';
  if (a === 'aarch64') return 'arm64';
  return a;
}

/**
 * The file an agent of this osInfo downloads to update (mirror of
 * agent/main.go applyUpdateIfNewer: the MSI on Windows, the bare
 * obliguard-agent-<GOOS>-<GOARCH> binary elsewhere), or null when unknown.
 */
export function updateArtifactForOs(osInfo: { platform?: unknown; arch?: unknown } | null | undefined): string | null {
  if (!osInfo || typeof osInfo.platform !== 'string') return null;
  const platform = osInfo.platform.trim().toLowerCase();
  if (platform === 'windows' || platform === 'win32') return 'obliguard-agent.msi';
  if (typeof osInfo.arch !== 'string' || !osInfo.arch.trim()) return null;
  return `obliguard-agent-${platform}-${goArch(osInfo.arch)}`;
}

/** A parsed manifest.json, or null when malformed. Unknown / invalid entries are dropped. */
export function parseAgentManifest(raw: unknown): AgentManifest | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const arts = r.artifacts;
  if (arts === null || typeof arts !== 'object' || Array.isArray(arts)) return null;
  const artifacts: Record<string, AgentManifestArtifact> = {};
  for (const [file, v] of Object.entries(arts as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(file) || v === null || typeof v !== 'object') continue;
    const a = v as Record<string, unknown>;
    if (typeof a.version !== 'string' || !a.version.trim()) continue;
    artifacts[file] = {
      version: a.version.trim(),
      sha256: typeof a.sha256 === 'string' ? a.sha256.toLowerCase() : '',
      size: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : 0,
    };
  }
  return { version: typeof r.version === 'string' ? r.version.trim() : '', artifacts };
}

/** Merge manifests (later ones win per artifact): manifest.json plus host fragments. */
export function mergeAgentManifests(list: AgentManifest[]): AgentManifest | null {
  if (list.length === 0) return null;
  const out: AgentManifest = { version: '', artifacts: {} };
  for (const m of list) {
    if (m.version) out.version = m.version;
    Object.assign(out.artifacts, m.artifacts);
  }
  return out;
}

/** Update artifacts whose manifest build does not match `served` (missing or other version). */
export function missingBuildsFor(manifest: AgentManifest | null, served: string | null): string[] {
  if (!manifest || served === null) return [];
  return UPDATE_ARTIFACTS.filter((f) => manifest.artifacts[f]?.version !== served);
}

/**
 * Whether the served version may be advertised to an agent of this osInfo.
 * No manifest = legacy layout (no check). With a manifest, the agent's
 * artifact must exist and embed the served version; an unknown platform is
 * never advertised.
 */
export function buildMatchesServed(manifest: AgentManifest | null, served: string, osInfo: { platform?: unknown; arch?: unknown } | null | undefined): boolean {
  if (!manifest) return true;
  const file = updateArtifactForOs(osInfo);
  if (!file) return false;
  return manifest.artifacts[file]?.version === served;
}

// ── Paced fleet rollout (W12-4 / FLEET-AGENT-10) ─────────────────────────────

/**
 * Update offers handed out per window, fleet-wide (every tenant): a large
 * fleet downloading a 10-20 MB build in the same minute would saturate the
 * server's uplink. Same pace as Obliance UPDATE_AGENT_ROLLOUT_MAX_PER_WINDOW.
 */
export const UPDATE_ROLLOUT_MAX_PER_WINDOW = 25;
/** Rolling window of the rollout cap (offers counted by last_offered_at). */
export const UPDATE_ROLLOUT_WINDOW_MS = 60_000;
/**
 * A slot reserved for a config frame that was not counted yet (WS: written
 * first, counted after) is released after this delay when the frame never
 * made it (failed write, dropped channel).
 */
export const UPDATE_ROLLOUT_RESERVATION_MS = 15_000;

/** Level that froze an agent ('unresolved': the policy lookup failed, fail closed). */
export type RolloutFrozenLevel = 'global' | 'tenant' | 'group' | 'agent' | 'unresolved';
export const ROLLOUT_FROZEN_LEVELS: readonly RolloutFrozenLevel[] = ['global', 'tenant', 'group', 'agent', 'unresolved'];

/** Whether one more offer fits: counted offers plus reserved slots stay under the cap. */
export function rolloutWindowHasRoom(counted: number, reserved: number, cap = UPDATE_ROLLOUT_MAX_PER_WINDOW): boolean {
  return counted + reserved < cap;
}

/** Minutes the cap needs to offer the update to `targets` agents (0 when none). */
export function rolloutEstimatedMinutes(
  targets: number,
  perWindow = UPDATE_ROLLOUT_MAX_PER_WINDOW,
  windowMs = UPDATE_ROLLOUT_WINDOW_MS,
): number {
  if (targets <= 0 || perWindow <= 0) return 0;
  return Math.ceil(targets / perWindow) * Math.ceil(windowMs / 60_000);
}

/** Platform label of an osInfo for the rollout preview: 'linux-amd64', 'windows-amd64', 'unknown'. */
export function rolloutPlatformOf(osInfo: { platform?: unknown; arch?: unknown } | null | undefined): string {
  if (!osInfo || typeof osInfo.platform !== 'string' || !osInfo.platform.trim()) return 'unknown';
  const p = osInfo.platform.trim().toLowerCase();
  const platform = p === 'win32' ? 'windows' : p;
  const arch = typeof osInfo.arch === 'string' && osInfo.arch.trim() ? goArch(osInfo.arch) : '';
  return arch ? `${platform}-${arch}` : platform;
}
