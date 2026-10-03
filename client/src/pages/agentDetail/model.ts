import type { AgentDevice, AgentUpdatePhase } from '@obliview/shared';

// ── Agent detail page model (pure: type-only imports, unit-tested by suite 82) ──

/**
 * Tab ids of the agent detail page, in display order (?tab= deep links).
 * The tab registry (tabs.tsx) renders them; later lots add a tab by adding an
 * id here and an entry there, never by branching in AgentDetailPage.
 */
export const AGENT_DETAIL_TABS = ['overview', 'events', 'services', 'firewall', 'settings'] as const;
export type AgentDetailTab = typeof AGENT_DETAIL_TABS[number];

export const DEFAULT_AGENT_DETAIL_TAB: AgentDetailTab = 'overview';

/**
 * ?tab= values of the former icon rail, mapped onto the tab that now holds
 * their content, so bookmarks keep landing on the right place.
 */
export const LEGACY_TAB_ALIASES: Readonly<Record<string, AgentDetailTab>> = {
  starmap: 'overview',
  netlimits: 'firewall',
  templates: 'services',
};

/** Tab to show for a raw ?tab= value: known ids, then legacy aliases, else null. */
export function resolveAgentDetailTab(raw: string | null): AgentDetailTab | null {
  if (raw === null) return null;
  if ((AGENT_DETAIL_TABS as ReadonlyArray<string>).includes(raw)) return raw as AgentDetailTab;
  return LEGACY_TAB_ALIASES[raw] ?? null;
}

// ── Lifecycle status (approval + WS + update + uninstall) ────────────────────

export type AgentLifecycleStatus =
  | 'pending'
  | 'refused'
  | 'suspended'
  | 'uninstalling'
  | 'updating'
  | 'misconfigured'
  | 'online'
  | 'offline';

/** Phases the agent itself reported: the update is actually running. */
const RUNNING_UPDATE_PHASES: readonly AgentUpdatePhase[] = ['downloading', 'verifying', 'installing', 'restarting'];

type StatusFields = Pick<
  AgentDevice,
  'status' | 'wsConnected' | 'deviceType' | 'mikrotikStatus' | 'pendingCommand' | 'uninstallCommandedAt' | 'update'
>;

/** True once an uninstall was queued or delivered (the row is deleted a few minutes later). */
export function isUninstallRequested(device: Pick<AgentDevice, 'pendingCommand' | 'uninstallCommandedAt'>): boolean {
  return device.pendingCommand === 'uninstall' || !!device.uninstallCommandedAt;
}

/**
 * One status for the header badge, by precedence: the approval state first
 * (a pending / refused / suspended agent enforces nothing, whatever its
 * channel), then a requested uninstall, a running update, the MikroTik
 * configuration, and finally the live WS channel (wsConnected also covers
 * the MikroTik reachability, server-side).
 */
export function agentLifecycleStatus(device: StatusFields): AgentLifecycleStatus {
  if (device.status === 'pending') return 'pending';
  if (device.status === 'refused') return 'refused';
  if (device.status === 'suspended') return 'suspended';
  if (isUninstallRequested(device)) return 'uninstalling';
  if (device.deviceType === 'agent' && device.update && RUNNING_UPDATE_PHASES.includes(device.update.phase)) {
    return 'updating';
  }
  if (device.deviceType === 'mikrotik' && device.mikrotikStatus === 'misconfigured') return 'misconfigured';
  return device.wsConnected ? 'online' : 'offline';
}

// ── Header / danger-zone actions ─────────────────────────────────────────────

export interface AgentActionContext {
  /** agents.manage: rename, move group, settings. */
  canManage: boolean;
  /** agents.approve: approve / refuse / suspend / reinstate (status changes). */
  canApprove: boolean;
  /** agents.update: Update now / cancel / retry. */
  canUpdate: boolean;
  /** agents.delete: uninstall and delete. */
  canDelete: boolean;
  /** Another tenant's agent (Default god view): read-only here. */
  foreign: boolean;
  /** The visible update attempt failed (the Retry button of the badge applies instead). */
  updateFailed: boolean;
}

export type AgentActionKey =
  | 'rename'
  | 'approve'
  | 'refuse'
  | 'suspend'
  | 'reinstate'
  | 'requeue'
  | 'moveGroup'
  | 'requestUpdate'
  | 'cancelUpdate'
  | 'uninstall'
  | 'delete';

export type AgentActionAvailability = Record<AgentActionKey, boolean>;

type ActionFields = Pick<
  AgentDevice,
  'status' | 'deviceType' | 'accessLevel' | 'updateAvailable' | 'updatePending' | 'resolvedUpdatePolicy'
  | 'pendingCommand' | 'uninstallCommandedAt'
>;

/**
 * Which lifecycle actions the page offers, mirroring the server guards:
 * PATCH status → agents.approve, other PATCH fields → agents.manage,
 * DELETE and the 'uninstall' command → agents.delete, update requests →
 * agents.update. Nothing is writable on another tenant's agent or through a
 * read-only team grant (device.accessLevel === 'ro').
 */
export function agentActions(device: ActionFields, ctx: AgentActionContext): AgentActionAvailability {
  const writable = !ctx.foreign && device.accessLevel !== 'ro';
  const approve = writable && ctx.canApprove;
  const manage = writable && ctx.canManage;
  const update = writable && ctx.canUpdate && device.deviceType === 'agent';
  const remove = writable && ctx.canDelete;
  const active = device.status === 'approved' || device.status === 'suspended';
  return {
    rename: manage,
    approve: approve && device.status === 'pending',
    refuse: approve && device.status === 'pending',
    suspend: approve && device.status === 'approved',
    reinstate: approve && device.status === 'suspended',
    requeue: approve && device.status === 'refused',
    moveGroup: manage && active,
    requestUpdate: update && device.status === 'approved' && !!device.updateAvailable && !device.updatePending
      && device.resolvedUpdatePolicy !== 'off' && !ctx.updateFailed,
    cancelUpdate: update && !!device.updatePending,
    uninstall: remove && device.deviceType === 'agent' && active && !isUninstallRequested(device),
    delete: remove,
  };
}
