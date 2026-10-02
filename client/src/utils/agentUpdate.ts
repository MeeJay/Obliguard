import type { TFunction } from 'i18next';
import type {
  AgentDevice, AgentUpdateAttemptInfo, AgentUpdatePhase, AgentUpdatePolicy, AgentUpdatePolicySource,
  GroupTreeNode, MonitorGroup,
} from '@obliview/shared';

type ApiErr = { response?: { data?: { error?: string; code?: string } } };

/** Human message for a failed agent-update / update-policy call (C17-1). */
export function agentUpdateErrorMessage(err: unknown, t: TFunction, fallback: string): string {
  const data = (err as ApiErr)?.response?.data;
  switch (data?.code) {
    case 'updatePolicyOff': return t('agentUpdate.errors.off', 'Updates are disabled for this agent (policy: off)');
    case 'alreadyCurrent': return t('agentUpdate.errors.current', 'This agent is already up to date');
    case 'notUpdatable': return t('agentUpdate.errors.notUpdatable', 'Only approved agents that reported a version can be updated');
    case 'versionUnavailable': return t('agentUpdate.errors.unavailable', 'No agent version is available on this server');
    default: return data?.error ?? fallback;
  }
}

// ── Update attempt phases (W2-1 contract: AgentDevice.update) ────────────────

/** Offers of one target version before the server stops until a Retry (server cap). */
export const AGENT_UPDATE_MAX_OFFERS = 3;

/** Phases of an attempt that is still running (offered, or reported by the agent). */
const IN_FLIGHT_PHASES: readonly AgentUpdatePhase[] = ['offered', 'downloading', 'verifying', 'installing', 'restarting'];

export function isUpdateInFlight(u: AgentUpdateAttemptInfo | null | undefined): boolean {
  return !!u && IN_FLIGHT_PHASES.includes(u.phase);
}

export function isUpdateFailed(u: AgentUpdateAttemptInfo | null | undefined): boolean {
  return !!u && u.phase === 'failed';
}

/** Dotted numeric version compare (missing / non-numeric parts count as 0). */
export function compareAgentVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.+-]/);
  const pb = b.replace(/^v/i, '').split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] ?? '0', 10) || 0;
    const y = parseInt(pb[i] ?? '0', 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The attempt worth showing for a device, or null: settled attempts
 * (succeeded / cancelled) and attempts whose target the agent already runs
 * (an old failure superseded by a later install) are hidden.
 */
export function visibleUpdateAttempt(
  device: Pick<AgentDevice, 'update' | 'agentVersion'>,
): AgentUpdateAttemptInfo | null {
  const u = device.update;
  if (!u || u.phase === 'succeeded' || u.phase === 'cancelled') return null;
  if (device.agentVersion && u.targetVersion && compareAgentVersions(device.agentVersion, u.targetVersion) >= 0) return null;
  return u;
}

export function updatePhaseLabel(phase: AgentUpdatePhase, t: TFunction): string {
  switch (phase) {
    case 'offered': return t('agents.update.phase.offered', 'Update offered');
    case 'downloading': return t('agents.update.phase.downloading', 'Downloading update');
    case 'verifying': return t('agents.update.phase.verifying', 'Verifying update');
    case 'installing': return t('agents.update.phase.installing', 'Installing update');
    case 'restarting': return t('agents.update.phase.restarting', 'Restarting');
    case 'succeeded': return t('agents.update.phase.succeeded', 'Updated');
    case 'failed': return t('agents.update.phase.failed', 'Update failed');
    case 'cancelled': return t('agents.update.phase.cancelled', 'Update cancelled');
    default: return phase;
  }
}

/** Pill colours of a phase (Tailwind classes, same palette as the other agent pills). */
export function updatePhaseClasses(phase: AgentUpdatePhase): string {
  switch (phase) {
    case 'failed': return 'bg-red-500/10 text-red-400 border-red-500/30';
    case 'succeeded': return 'bg-green-500/10 text-green-400 border-green-500/30';
    case 'cancelled': return 'bg-bg-tertiary text-text-muted border-border';
    case 'offered': return 'bg-sky-500/10 text-sky-400 border-sky-500/30';
    default: return 'bg-blue-500/10 text-blue-400 border-blue-500/30';
  }
}

/** Reason of a failed attempt: server codes are translated, agent-reported errors shown as is. */
export function updateErrorLabel(lastError: string | null | undefined, t: TFunction): string {
  switch (lastError) {
    case null:
    case undefined:
    case '':
      return t('agents.update.error.unknown', 'unknown reason');
    case 'no_progress': return t('agents.update.error.noProgress', 'no progress after the last offer');
    case 'timeout': return t('agents.update.error.timeout', 'timed out (still on the old version after 10 min)');
    case 'reverted_or_failed': return t('agents.update.error.reverted', 'the agent came back on its old version');
    default: return lastError;
  }
}

// ── Update policy (global -> tenant -> group -> agent) ──────────────────────

export interface UpdatePolicyChainEntry {
  groupId: number;
  policy: AgentUpdatePolicy;
}

export interface ResolvedUpdatePolicyView {
  policy: AgentUpdatePolicy;
  source: AgentUpdatePolicySource;
  sourceGroupId: number | null;
}

/**
 * Client mirror of the server resolver (server/src/utils/agentUpdate.ts):
 * 'off' at any level is absolute (global, then tenant, then the farthest
 * group, then the agent); otherwise the nearest explicit value wins; nothing
 * set = 'manual'. `chain` lists the explicit group policies, nearest first.
 * Display only: the server's resolution is authoritative.
 */
export function resolveUpdatePolicyView(
  devicePolicy: AgentUpdatePolicy | null,
  chain: UpdatePolicyChainEntry[],
  tenantPolicy: AgentUpdatePolicy | null,
  globalPolicy: AgentUpdatePolicy | null,
): ResolvedUpdatePolicyView {
  if (globalPolicy === 'off') return { policy: 'off', source: 'global', sourceGroupId: null };
  if (tenantPolicy === 'off') return { policy: 'off', source: 'tenant', sourceGroupId: null };
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].policy === 'off') return { policy: 'off', source: 'group', sourceGroupId: chain[i].groupId };
  }
  if (devicePolicy === 'off') return { policy: 'off', source: 'agent', sourceGroupId: null };
  if (devicePolicy) return { policy: devicePolicy, source: 'agent', sourceGroupId: null };
  if (chain.length > 0) return { policy: chain[0].policy, source: 'group', sourceGroupId: chain[0].groupId };
  if (tenantPolicy) return { policy: tenantPolicy, source: 'tenant', sourceGroupId: null };
  if (globalPolicy) return { policy: globalPolicy, source: 'global', sourceGroupId: null };
  return { policy: 'manual', source: 'default', sourceGroupId: null };
}

/** Group lookup over the sidebar tree (always loaded, unlike the flat group map). */
export function findGroupInTree(nodes: GroupTreeNode[], id: number): GroupTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findGroupInTree(n.children ?? [], id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Explicit update policies of a group's ANCESTORS (the group itself excluded),
 * nearest first, limited to the group's own tenant like the server does.
 * null when an ancestor is missing from the tree (chain unknown).
 */
export function ancestorUpdatePolicyChain(tree: GroupTreeNode[], group: MonitorGroup): UpdatePolicyChainEntry[] | null {
  const chain: UpdatePolicyChainEntry[] = [];
  const seen = new Set<number>([group.id]);
  let parentId = group.parentId;
  while (parentId != null) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const g = findGroupInTree(tree, parentId);
    if (!g) return null;
    const p = g.agentGroupConfig?.updatePolicy;
    const sameTenant = g.tenantId === undefined || group.tenantId === undefined || g.tenantId === group.tenantId;
    if (p && sameTenant) chain.push({ groupId: g.id, policy: p });
    parentId = g.parentId;
  }
  return chain;
}

/** "tenant policy (Acme)", "group (Servers)", "global"... */
export function updatePolicySourceLabel(
  source: AgentUpdatePolicySource,
  t: TFunction,
  names: { tenantName?: string | null; groupName?: string | null } = {},
): string {
  const base = t(`agentUpdate.source.${source}`, source === 'tenant' ? 'tenant policy' : source);
  const name = source === 'tenant' ? names.tenantName : source === 'group' ? names.groupName : null;
  return name ? `${base} (${name})` : base;
}

// ── Build manifest (FLEET-AGENT-3) ───────────────────────────────────────────

/** 'obliguard-agent-linux-arm64' -> 'linux-arm64'; 'obliguard-agent.msi' -> 'windows (MSI)'. */
export function agentBuildLabel(artifact: string): string {
  if (/\.msi$/i.test(artifact)) return 'windows (MSI)';
  return artifact.replace(/^obliguard-agent[-.]?/i, '').replace(/\.exe$/i, '') || artifact;
}
