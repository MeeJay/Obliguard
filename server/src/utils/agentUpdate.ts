/**
 * Agent update control (C17-1) — pure helpers. No DB, no fs.
 *
 * Policy model: 'auto' | 'manual' | 'off' at three levels (global, group chain,
 * agent). 'off' at any level is absolute; otherwise the nearest explicit value
 * wins; nothing set anywhere = DEFAULT_AGENT_UPDATE_POLICY ('manual').
 *
 * The version comparison mirrors the Go agent (agent/main.go parseSemver /
 * isStrictlyNewer) so the server never advertises a version the agent would
 * not install, and vice versa.
 */
import path from 'path';
import type { AgentUpdatePolicy } from '@obliview/shared';
import { AGENT_UPDATE_POLICIES, DEFAULT_AGENT_UPDATE_POLICY } from '@obliview/shared';

/** An explicit "Update now" request lives 24 h. */
export const AGENT_UPDATE_REQUEST_TTL_MS = 24 * 3600 * 1000;
/** At most one update offer per device every 10 minutes. */
export const UPDATE_OFFER_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** A request is abandoned after 3 offers the agent did not act upon. */
export const UPDATE_REQUEST_MAX_OFFERS = 3;
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
  source: 'agent' | 'group' | 'global' | 'default';
  sourceGroupId: number | null;
}

/**
 * Resolve a device's effective policy. `groupChain` is ordered nearest first
 * (closure depth ascending, own group = depth 0) and already filtered to the
 * device's tenant.
 */
export function resolveAgentUpdatePolicy(
  devicePolicy: AgentUpdatePolicy | null,
  groupChain: GroupPolicyEntry[],
  globalPolicy: AgentUpdatePolicy | null | undefined,
): ResolvedAgentUpdatePolicy {
  // 1. Global kill-switch.
  if (globalPolicy === 'off') return { policy: 'off', source: 'global', sourceGroupId: null };
  // 2. 'off' on any ancestor freezes the subtree: the farthest one is reported.
  for (let i = groupChain.length - 1; i >= 0; i--) {
    if (groupChain[i].policy === 'off') return { policy: 'off', source: 'group', sourceGroupId: groupChain[i].groupId };
  }
  // 3. Device freeze.
  if (devicePolicy === 'off') return { policy: 'off', source: 'agent', sourceGroupId: null };
  // 4. Nearest explicit value.
  if (devicePolicy) return { policy: devicePolicy, source: 'agent', sourceGroupId: null };
  if (groupChain.length > 0) return { policy: groupChain[0].policy, source: 'group', sourceGroupId: groupChain[0].groupId };
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
  for (const k of ['pushIntervalSeconds', 'heartbeatMonitoring', 'maxMissedPushes', 'notificationTypes']) {
    if (k in src) out[k] = src[k];
  }
  if (src.updatePolicy === 'manual' || src.updatePolicy === 'off') out.updatePolicy = src.updatePolicy;
  return out;
}
