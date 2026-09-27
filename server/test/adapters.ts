/**
 * Lot-owned adapters of the verification harness.
 *
 * Some lot checks need a code path that does not exist on the baseline. Rather
 * than importing a future symbol (which would break the baseline typecheck),
 * the owning lot fills its adapter here in its landing commit:
 *   - C17 fills `updatePolicy` (suite 09), including a DB-level reset();
 *   - A5 fills `agentWs` (08#5) with attachAgentWebSocket from agentWsGate.ts.
 * While an adapter is null, its checks are TODOs that fail fast (adapterIt).
 */
import type http from 'http';
import type { Client, Res } from './harness';
import { attachAgentWebSocket } from '../src/services/agentWsGate';
import { db } from '../src/db';
import {
  __setServedAgentVersionForTest,
  __setAgentUpdateClockForTest,
  __resetAgentUpdateStateForTest,
} from '../src/services/agent.service';

export type UpdatePolicy = 'auto' | 'manual' | 'off';

/**
 * Filled by C17. Methods that talk HTTP return the response so tests can
 * assert refusals.
 */
export interface UpdatePolicyAdapter {
  /** Make the server advertise `v` as the released agent version (C17: __setServedAgentVersionForTest). */
  setReleasedVersion(v: string): void;
  /**
   * DB-level reset owned by C17: global policy 'auto', no group or device
   * override, no pending update-now; then C17's in-memory update state
   * (__resetAgentUpdateStateForTest) and the served-version override are
   * re-applied. Used in beforeEach, so no hook depends on an HTTP actor that
   * C17 may legitimately refuse.
   */
  reset(): Promise<void>;
  setGlobal(actor: Client, p: UpdatePolicy): Promise<Res>;
  setGroup(actor: Client, groupId: number, p: UpdatePolicy | null): Promise<Res>;
  setDevice(actor: Client, deviceId: number, p: UpdatePolicy | null): Promise<Res>;
  updateNow(actor: Client, deviceId: number): Promise<Res>;
  updateNowGroup(actor: Client, groupId: number): Promise<Res>;
  /** json.data is Array<{ version, count }>. */
  versionDistribution(actor: Client): Promise<Res>;
  /** Optional: advance C17's update-offer clock (throttle) by `ms`. */
  advanceClock?(ms: number): void;
}

/** Filled by A5: wires the agent WS upgrade handler onto a harness server. */
export interface AgentWsAdapter {
  attach(server: http.Server): void;
}

// ── C17: update policy ───────────────────────────────────────────────────────

let servedOverride: string | undefined;
let clockOffsetMs = 0;

function applyClock(): void {
  __setAgentUpdateClockForTest(clockOffsetMs === 0 ? null : () => Date.now() + clockOffsetMs);
}

const updatePolicyAdapter: UpdatePolicyAdapter = {
  setReleasedVersion(v) {
    servedOverride = v;
    __setServedAgentVersionForTest(v);
  },

  async reset() {
    // Global 'auto', no group / device override, no pending update request.
    const row = await db('app_config').where({ key: 'agent_global_config' }).first('value') as { value: string } | undefined;
    let cfg: Record<string, unknown> = {};
    try { cfg = row?.value ? JSON.parse(row.value) as Record<string, unknown> : {}; } catch { cfg = {}; }
    cfg.updatePolicy = 'auto';
    await db('app_config').insert({ key: 'agent_global_config', value: JSON.stringify(cfg) })
      .onConflict('key').merge({ value: JSON.stringify(cfg) });
    await db.raw("UPDATE monitor_groups SET agent_group_config = agent_group_config - 'updatePolicy' WHERE agent_group_config ->> 'updatePolicy' IS NOT NULL");
    await db('agent_devices').update({
      update_policy: null, update_requested_at: null, update_requested_version: null, update_requested_by: null,
    });
    // In-memory state (offers, caches, clock), then the served override again.
    __resetAgentUpdateStateForTest();
    clockOffsetMs = 0;
    if (servedOverride !== undefined) __setServedAgentVersionForTest(servedOverride);
  },

  setGlobal(actor, p) {
    return actor.patch('/api/admin/config/agent-global', { updatePolicy: p });
  },

  setGroup(actor, groupId, p) {
    return actor.patch(`/api/groups/${groupId}/agent-config`, { agentGroupConfig: { updatePolicy: p } });
  },

  setDevice(actor, deviceId, p) {
    return actor.patch(`/api/agent/devices/${deviceId}`, { updatePolicy: p });
  },

  updateNow(actor, deviceId) {
    return actor.post(`/api/agent/devices/${deviceId}/agent-update`);
  },

  updateNowGroup(actor, groupId) {
    return actor.post(`/api/agent/groups/${groupId}/agent-update`);
  },

  async versionDistribution(actor) {
    const r = await actor.get('/api/agent/devices/versions');
    if (r.status !== 200 || !r.json?.data) return r;
    return { ...r, json: { ...r.json, data: r.json.data.versions } };
  },

  advanceClock(ms) {
    clockOffsetMs += ms;
    applyClock();
  },
};

export const adapters: {
  updatePolicy: UpdatePolicyAdapter | null;
  agentWs: AgentWsAdapter | null;
} = {
  updatePolicy: updatePolicyAdapter,
  agentWs: { attach: (server) => { attachAgentWebSocket(server); } },
};
