import { db } from '../db';
import { logger } from '../utils/logger';
import { isMasterTenant } from '@obliview/shared';
import type { AgentDevice, AgentUpdateRequestResult } from '@obliview/shared';
import {
  PROGRESS_UPDATE_PHASES,
  ROLLOUT_FROZEN_LEVELS,
  UPDATE_ROLLOUT_MAX_PER_WINDOW,
  UPDATE_ROLLOUT_RESERVATION_MS,
  UPDATE_ROLLOUT_WINDOW_MS,
  buildMatchesServed,
  isStrictlyNewerAgentVersion,
  rolloutEstimatedMinutes,
  rolloutPlatformOf,
  rolloutWindowHasRoom,
  type AgentManifest,
  type RolloutFrozenLevel,
} from '../utils/agentUpdate';

// ── Paced fleet rollout (W12-4 / FLEET-AGENT-10) ────────────────────────────
//
// Ported from Obliance agentUpdateRollout.service.ts (rollout cap, "update all
// outdated" preview, update all, stop the rollout), on Obliguard's update
// model: an update is OFFERED in a config frame (latestVersion) when the
// 4-level policy allows it ('auto', or a live explicit request), and every
// offer is a row of agent_update_attempts (last_offered_at).
//
//  1. Paced: at most UPDATE_ROLLOUT_MAX_PER_WINDOW offers per
//     UPDATE_ROLLOUT_WINDOW_MS, fleet-wide. The cap is DB-counted (offers whose
//     last_offered_at is in the window), so it survives restarts and covers
//     the HTTP push and WS paths alike. A frame about to carry latestVersion
//     reserves its slot first (reserveRolloutSlot, serialised in-process) and
//     the reservation is released once the offer is counted
//     (agent.service recordUpdateOffer): concurrent heartbeats never overshoot
//     the cap. An agent refused by the cap is simply offered at a later
//     heartbeat: nothing is lost, the rollout runs at the cap.
//  2. The policy stays authoritative (owner directive C17): an agent frozen
//     at any level (global, tenant, group chain, agent; or a policy that could
//     not be read) is never offered, "update all" included. The preview lists
//     the frozen agents separately with the level that froze them.
//  3. The per-device budget of W2-1 (10-min spacing, 3 offers per target,
//     agent_update_attempts) is unchanged: the cap only delays offers.
//  4. Scope: the operating tenant; the Default tenant covers every tenant
//     (Obliance master scope). A user restricted by team grants only reaches
//     the agents they may write.

/** Re-count the window at most this often while it is known to be full. */
const FULL_RECHECK_MS = 1_000;
/** Frozen agents listed one by one in the preview (the counts are complete). */
const FROZEN_LIST_MAX = 200;
/** Device patches emitted one by one by cancel-all up to this count per tenant. */
const BULK_EMIT_MAX = 100;

// ── Window cap ───────────────────────────────────────────────────────────────

/** deviceId → clock of the reservation (frame about to carry latestVersion). */
const reservations = new Map<number, number>();
let slotLock: Promise<unknown> = Promise.resolve();
/** Clock of the last "window full" answer (skips the count for FULL_RECHECK_MS). */
let windowFullAt: number | null = null;

function purgeReservations(now: number): void {
  for (const [id, at] of reservations) {
    if (Math.abs(now - at) >= UPDATE_ROLLOUT_RESERVATION_MS) reservations.delete(id);
  }
}

/** Offers counted in the window ending at `now` (every tenant). */
export async function countRolloutOffersInWindow(now: number): Promise<number> {
  const r = await db('agent_update_attempts')
    .where('last_offered_at', '>', new Date(now - UPDATE_ROLLOUT_WINDOW_MS))
    .andWhere('last_offered_at', '<=', new Date(now))
    .count<Array<{ count: string | number }>>({ count: '*' });
  return Number(r[0]?.count ?? 0);
}

/**
 * Reserve a slot of the rollout window for an offer to this device. false =
 * the window is full (the offer waits for a later heartbeat). Serialised
 * in-process so concurrent heartbeats cannot both take the last slot. Throws
 * on a database error (the caller fails closed: nothing advertised).
 */
export function reserveRolloutSlot(deviceId: number, now: number): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    purgeReservations(now);
    if (reservations.has(deviceId)) {
      reservations.set(deviceId, now);
      return true;
    }
    if (windowFullAt !== null && now >= windowFullAt && now - windowFullAt < FULL_RECHECK_MS) return false;
    const counted = await countRolloutOffersInWindow(now);
    if (!rolloutWindowHasRoom(counted, reservations.size)) {
      if (windowFullAt === null) {
        logger.info(
          { event: 'agent_update_rollout_paced', offersInWindow: counted, reserved: reservations.size, cap: UPDATE_ROLLOUT_MAX_PER_WINDOW },
          'Agent update rollout: window cap reached, further offers wait for the next window',
        );
      }
      windowFullAt = now;
      return false;
    }
    windowFullAt = null;
    reservations.set(deviceId, now);
    return true;
  };
  const p = slotLock.then(run, run);
  slotLock = p.catch(() => undefined);
  return p;
}

/** The offer of this device was counted (or will not be made): its slot is free again. */
export function releaseRolloutSlot(deviceId: number): void {
  reservations.delete(deviceId);
}

/** Test seam (verification harness): forget reservations and the "full" cache. */
export function __resetRolloutStateForTest(): void {
  reservations.clear();
  windowFullAt = null;
  slotLock = Promise.resolve();
}

// ── Preview / update all / cancel all ───────────────────────────────────────

export interface RolloutScope {
  /** Operating tenant; the Default tenant covers every tenant. */
  tenantId: number;
  /** Agents the caller may write (team scope), or 'all'. */
  writableIds: number[] | 'all';
}

export interface RolloutFrozenAgent {
  id: number;
  name: string | null;
  hostname: string;
  tenantId: number;
  /** Level that froze the agent (the highest one, as the resolver reports it). */
  level: RolloutFrozenLevel;
  sourceGroupId: number | null;
  sourceGroupName: string | null;
}

export interface AgentUpdateRolloutPreview {
  latestVersion: string | null;
  /** Default tenant: every tenant's agents. */
  allTenants: boolean;
  /** Tenant the figures were computed for: sent back with "update all". */
  scopeTenantId: number;
  /** Outdated approved agents in scope (frozen and without a build included). */
  outdated: number;
  /** Agents "update all" brings to the latest version: outdated, not frozen, with a build for their platform. */
  targets: number;
  /** …of which get a new request now (the others already have one, or are updating). */
  toRequest: number;
  alreadyRequested: number;
  inFlight: number;
  /** …of which follow the 'auto' policy (offered without any request). */
  auto: number;
  /** …of which connected right now (the others are offered when they come back). */
  online: number;
  offline: number;
  byTenant: Array<{ tenantId: number; tenantName: string | null; targets: number; frozen: number }>;
  byGroup: Array<{ tenantId: number; groupId: number | null; groupName: string | null; targets: number }>;
  byPlatform: Array<{ platform: string; targets: number }>;
  /** Outdated agents never offered the update: their policy is 'off' at some level. */
  frozen: {
    total: number;
    byLevel: Record<RolloutFrozenLevel, number>;
    agents: RolloutFrozenAgent[];
    truncated: boolean;
  };
  /** Outdated agents whose platform has no build of the latest version. */
  noBuild: number;
  /**
   * Outdated agents whose update to the latest version failed: the W2-1
   * per-device budget stays authoritative, so "update all" does not request
   * them again (a per-agent Retry does).
   */
  failed: number;
  /** Approved agents that never reported a version. */
  unknownVersion: number;
  /** Pending update requests in scope: what "cancel all pending" clears. */
  pending: number;
  /** Agents of the scope by state of their update to the latest version. */
  progress: { waiting: number; offered: number; inProgress: number; succeeded: number; failed: number };
  /** Pace (fleet-wide cap) and the offers already counted in the current window. */
  rollout: { maxPerWindow: number; windowSeconds: number; offersInWindow: number; estimatedMinutes: number };
}

export interface AgentUpdateAllResult {
  requested: number;
  targetVersion: string | null;
  skipped: AgentUpdateRequestResult['skipped'];
  byTenant: Array<{ tenantId: number; requested: number }>;
  /** The preview after the requests (progress starts from here). */
  preview: AgentUpdateRolloutPreview;
}

export interface AgentUpdateCancelAllResult {
  cancelled: number;
  byTenant: Array<{ tenantId: number; cancelled: number }>;
  /** Outdated agents under the 'auto' policy: still offered the update (change their policy to stop them). */
  autoContinuing: number;
}

type Klass = 'unknown' | 'current' | 'frozen' | 'noBuild' | 'failed' | 'eligible';

function classify(d: AgentDevice, served: string | null, manifest: AgentManifest | null): Klass {
  if (!d.agentVersion) return 'unknown';
  if (served === null || !isStrictlyNewerAgentVersion(served, d.agentVersion)) return 'current';
  // 'off' at any level, or a policy that could not be read ('unresolved'): never offered.
  if (d.resolvedUpdatePolicy === 'off' || d.updatePolicySource === 'unresolved') return 'frozen';
  if (!buildMatchesServed(manifest, served, d.osInfo)) return 'noBuild';
  // The update to this version failed (offer budget spent, or reverted): a
  // bulk action never resets the per-device budget of W2-1, a Retry does.
  if (d.update?.targetVersion === served && d.update.phase === 'failed') return 'failed';
  return 'eligible';
}

function frozenLevelOf(d: AgentDevice): RolloutFrozenLevel {
  const s = d.updatePolicySource;
  return s === 'global' || s === 'tenant' || s === 'group' || s === 'agent' ? s : 'unresolved';
}

/** The latest attempt targets the served version and the agent is applying it. */
function isInFlight(d: AgentDevice, served: string | null): boolean {
  return !!served && d.update?.targetVersion === served
    && (PROGRESS_UPDATE_PHASES as readonly string[]).includes(d.update.phase);
}

async function agentModule() {
  // Lazy: agent.service imports this module (window cap).
  return import('./agent.service');
}

/** Approved agents of the scope (Default: every tenant), team scope applied. */
async function scopeAgents(scope: RolloutScope): Promise<AgentDevice[]> {
  const { agentService } = await agentModule();
  const rows = await agentService.listDevices(scope.tenantId, 'approved', { visibleIds: scope.writableIds });
  return rows.filter((d) => d.deviceType === 'agent');
}

async function namesOf(table: 'tenants' | 'monitor_groups', ids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  if (ids.length === 0) return m;
  const rows = await db(table).whereIn('id', ids).select('id', 'name') as Array<{ id: number; name: string }>;
  for (const r of rows) m.set(Number(r.id), r.name);
  return m;
}

function byCountDesc<T extends { targets: number }>(a: T, b: T): number {
  return b.targets - a.targets;
}

export const agentUpdateRollout = {
  /**
   * What "update all outdated" would do now in this scope: per tenant, group
   * and platform, the frozen agents with their freezing level, the pace, and
   * the progress of the agents already on their way to the latest version.
   */
  async preview(scope: RolloutScope): Promise<AgentUpdateRolloutPreview> {
    const { getServedAgentVersion, getAgentManifest, getAgentUpdateClock } = await agentModule();
    const served = getServedAgentVersion();
    const manifest = getAgentManifest();
    const devices = await scopeAgents(scope);
    const now = getAgentUpdateClock();

    let outdated = 0; let targets = 0; let toRequest = 0; let alreadyRequested = 0; let inFlight = 0;
    let auto = 0; let online = 0; let noBuild = 0; let failed = 0; let unknownVersion = 0; let pending = 0;
    const byLevel = Object.fromEntries(ROLLOUT_FROZEN_LEVELS.map((l) => [l, 0])) as Record<RolloutFrozenLevel, number>;
    const frozenAgents: AgentDevice[] = [];
    const tenants = new Map<number, { targets: number; frozen: number }>();
    const groups = new Map<string, { tenantId: number; groupId: number | null; groupName: string | null; targets: number }>();
    const platforms = new Map<string, number>();
    const progress = { waiting: 0, offered: 0, inProgress: 0, succeeded: 0, failed: 0 };

    for (const d of devices) {
      if (d.updateRequestedAt) pending++;
      const k = classify(d, served, manifest);
      // Progress of the rollout to the served version (current agents included).
      if (served && d.update?.targetVersion === served) {
        const ph = d.update.phase;
        if (ph === 'succeeded') progress.succeeded++;
        else if (ph === 'failed') progress.failed++;
        else if (ph === 'offered') progress.offered++;
        else if ((PROGRESS_UPDATE_PHASES as readonly string[]).includes(ph)) progress.inProgress++;
        else if (d.updatePending) progress.waiting++;
      } else if (d.updatePending) {
        progress.waiting++;
      }
      if (k === 'unknown') { unknownVersion++; continue; }
      if (k === 'current') continue;
      outdated++;
      const tn = tenants.get(d.tenantId) ?? { targets: 0, frozen: 0 };
      tenants.set(d.tenantId, tn);
      if (k === 'frozen') {
        tn.frozen++;
        byLevel[frozenLevelOf(d)]++;
        frozenAgents.push(d);
        continue;
      }
      if (k === 'noBuild') { noBuild++; continue; }
      if (k === 'failed') { failed++; continue; }
      targets++;
      tn.targets++;
      const flying = isInFlight(d, served);
      if (flying) inFlight++;
      else if (d.updatePending) alreadyRequested++;
      else toRequest++;
      if (d.resolvedUpdatePolicy === 'auto') auto++;
      if (d.wsConnected) online++;
      const gk = `${d.tenantId}:${d.groupId ?? ''}`;
      const g = groups.get(gk) ?? {
        tenantId: d.tenantId,
        groupId: d.groupId ?? null,
        groupName: (d as AgentDevice & { groupName?: string | null }).groupName ?? null,
        targets: 0,
      };
      g.targets++;
      groups.set(gk, g);
      const pf = rolloutPlatformOf(d.osInfo);
      platforms.set(pf, (platforms.get(pf) ?? 0) + 1);
    }

    const listed = frozenAgents.slice(0, FROZEN_LIST_MAX);
    const [tenantNames, groupNames, offersInWindow] = await Promise.all([
      namesOf('tenants', [...tenants.keys()]),
      namesOf('monitor_groups', [...new Set(listed.map((d) => d.updatePolicySourceGroupId).filter((x): x is number => x != null))]),
      countRolloutOffersInWindow(now),
    ]);

    return {
      latestVersion: served,
      allTenants: isMasterTenant(scope.tenantId),
      scopeTenantId: scope.tenantId,
      outdated,
      targets,
      toRequest,
      alreadyRequested,
      inFlight,
      auto,
      online,
      offline: targets - online,
      byTenant: [...tenants.entries()]
        .map(([tenantId, c]) => ({ tenantId, tenantName: tenantNames.get(tenantId) ?? null, ...c }))
        .sort((a, b) => a.tenantId - b.tenantId),
      byGroup: [...groups.values()].sort(byCountDesc),
      byPlatform: [...platforms.entries()].map(([platform, n]) => ({ platform, targets: n })).sort(byCountDesc),
      frozen: {
        total: frozenAgents.length,
        byLevel,
        agents: listed.map((d) => {
          const level = frozenLevelOf(d);
          const gid = level === 'group' ? (d.updatePolicySourceGroupId ?? null) : null;
          return {
            id: d.id,
            name: d.name,
            hostname: d.hostname,
            tenantId: d.tenantId,
            level,
            sourceGroupId: gid,
            sourceGroupName: gid != null ? groupNames.get(gid) ?? null : null,
          };
        }),
        truncated: frozenAgents.length > listed.length,
      },
      noBuild,
      failed,
      unknownVersion,
      pending,
      progress,
      rollout: {
        maxPerWindow: UPDATE_ROLLOUT_MAX_PER_WINDOW,
        windowSeconds: UPDATE_ROLLOUT_WINDOW_MS / 1000,
        offersInWindow,
        estimatedMinutes: rolloutEstimatedMinutes(targets),
      },
    };
  },

  /**
   * "Update all outdated": an explicit request (agent.service requestUpdate,
   * per tenant: strict tenant writes) for every target of the preview that has
   * none yet and is not mid-update. Frozen agents, platforms without a
   * build and failed updates (per-device budget, W2-1) are left out;
   * requestUpdate re-checks the policy, so a policy turned 'off' in between
   * still wins. The offers are then paced by the window cap.
   */
  async updateAll(scope: RolloutScope, userId: number | null): Promise<AgentUpdateAllResult> {
    const { agentService, getServedAgentVersion, getAgentManifest } = await agentModule();
    const served = getServedAgentVersion();
    const manifest = getAgentManifest();
    const devices = await scopeAgents(scope);
    const perTenant = new Map<number, number[]>();
    for (const d of devices) {
      if (classify(d, served, manifest) !== 'eligible' || d.updatePending || isInFlight(d, served)) continue;
      const ids = perTenant.get(d.tenantId) ?? [];
      ids.push(d.id);
      perTenant.set(d.tenantId, ids);
    }
    const skipped = { off: 0, current: 0, notUpdatable: 0, notFound: 0 };
    const byTenant: AgentUpdateAllResult['byTenant'] = [];
    let requested = 0;
    for (const [tenantId, ids] of [...perTenant.entries()].sort((a, b) => a[0] - b[0])) {
      const r = await agentService.requestUpdate(ids, tenantId, userId);
      requested += r.requested;
      skipped.off += r.skipped.off;
      skipped.current += r.skipped.current;
      skipped.notUpdatable += r.skipped.notUpdatable;
      skipped.notFound += r.skipped.notFound;
      byTenant.push({ tenantId, requested: r.requested });
    }
    logger.info({
      event: 'agent_update_all_requested', userId, scopeTenantId: scope.tenantId, version: served, requested, byTenant,
    }, 'Agent update requested for every outdated agent');
    return { requested, targetVersion: served, skipped, byTenant, preview: await this.preview(scope) };
  },

  /**
   * "Cancel all pending": clear every pending update request of the scope and
   * close the open attempts of those agents. Agents under the 'auto' policy
   * keep being offered the update (the policy is not changed here): their
   * number is returned so the UI can say so.
   */
  async cancelAll(scope: RolloutScope, userId: number | null): Promise<AgentUpdateCancelAllResult> {
    const { agentService, getServedAgentVersion, getAgentManifest } = await agentModule();
    const q = db('agent_devices').whereNotNull('update_requested_at');
    if (!isMasterTenant(scope.tenantId)) q.where({ tenant_id: scope.tenantId });
    if (Array.isArray(scope.writableIds)) {
      if (scope.writableIds.length === 0) return { cancelled: 0, byTenant: [], autoContinuing: 0 };
      q.whereIn('id', scope.writableIds);
    }
    const rows = await q.select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
    const perTenant = new Map<number, number[]>();
    for (const r of rows) {
      const ids = perTenant.get(Number(r.tenant_id)) ?? [];
      ids.push(Number(r.id));
      perTenant.set(Number(r.tenant_id), ids);
    }
    const byTenant: AgentUpdateCancelAllResult['byTenant'] = [];
    let cancelled = 0;
    for (const [tenantId, ids] of [...perTenant.entries()].sort((a, b) => a[0] - b[0])) {
      const n = await agentService.cancelUpdateRequests(ids, tenantId, { emit: ids.length <= BULK_EMIT_MAX });
      cancelled += n;
      if (n > 0) byTenant.push({ tenantId, cancelled: n });
    }
    const served = getServedAgentVersion();
    const manifest = getAgentManifest();
    const autoContinuing = (await scopeAgents(scope))
      .filter((d) => d.resolvedUpdatePolicy === 'auto' && classify(d, served, manifest) === 'eligible').length;
    logger.info({
      event: 'agent_update_all_cancelled', userId, scopeTenantId: scope.tenantId, cancelled, byTenant, autoContinuing,
    }, 'Every pending agent update request cancelled');
    return { cancelled, byTenant, autoContinuing };
  },
};
