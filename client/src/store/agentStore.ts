import { useEffect } from 'react';
import { create } from 'zustand';
import type { AgentDevice } from '@obliview/shared';
import { agentApi } from '../api/agent.api';
import { useAuthStore } from './authStore';
import { useTenantStore } from './tenantStore';

/**
 * Agent devices of the operating tenant, shared by the sidebar, the group
 * pages and the socket layer (useSocket). Mirrors the Obliance sidebar cache:
 *
 *  - the rows are keyed by `${userId}:${tenantId}`; readers only ever see the
 *    rows of the CURRENT key, so another tenant's agents can never be shown
 *    after a switch (they disappear until the new fetch lands);
 *  - a fetch answered after the user / tenant changed is dropped;
 *  - socket deltas are merged as partial patches: a payload without `status`
 *    keeps the known status (never read as "removed"); only an explicit
 *    AGENT_DEVICE_DELETED removes a row.
 *
 * The store holds every status (pending, approved, refused, suspended):
 * consumers filter what they display.
 */

export const AGENT_REFRESH_MS = 30_000;

/** Delay that coalesces refetch requests (burst of socket events). */
const REFETCH_DEBOUNCE_MS = 500;

/** Partial update of one device, as emitted by the server on AGENT_DEVICE_UPDATED. */
export interface AgentDevicePatchPayload {
  deviceId: number;
  patch: Partial<AgentDevice>;
}

export function agentCacheKey(userId: number | null | undefined, tenantId: number | null | undefined): string {
  return `${userId ?? '-'}:${tenantId ?? '-'}`;
}

/** Key of the user + tenant active right now (read outside render). */
export function currentAgentCacheKey(): string {
  return agentCacheKey(useAuthStore.getState().user?.id, useTenantStore.getState().currentTenantId);
}

/**
 * Normalise every device payload shape the server emits into {deviceId, patch}:
 *   1. { deviceId, patch }            — current contract
 *   2. { device: AgentDevice }        — full device wrapper
 *   3. AgentDevice                    — full device object (has `id`)
 *   4. { deviceId, ...fields }        — legacy flat partial (may carry no field)
 * Returns null when no device id can be found.
 */
export function toDevicePatch(data: unknown): AgentDevicePatchPayload | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const wrapped = d.device as Record<string, unknown> | undefined;
  if (wrapped && typeof wrapped === 'object' && typeof wrapped.id === 'number') {
    return { deviceId: wrapped.id, patch: wrapped as Partial<AgentDevice> };
  }
  const id = typeof d.deviceId === 'number' ? d.deviceId : typeof d.id === 'number' ? d.id : null;
  if (id === null) return null;
  if (d.patch && typeof d.patch === 'object') {
    return { deviceId: id, patch: d.patch as Partial<AgentDevice> };
  }
  const { deviceId: _deviceId, id: _id, patch: _patch, ...rest } = d;
  return { deviceId: id, patch: rest as Partial<AgentDevice> };
}

/** Drop undefined values so a partial payload never erases a known field. */
function definedFields(patch: Partial<AgentDevice>): Partial<AgentDevice> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && k !== 'id') out[k] = v;
  }
  return out as Partial<AgentDevice>;
}

interface AgentStoreState {
  /** Cache key the rows below belong to (null = nothing fetched yet). */
  key: string | null;
  devices: AgentDevice[];
  /**
   * Last live status per device from AGENT_STATUS_CHANGED ('up', 'down',
   * 'alert', 'updating'...). Reset by a fetch, except a transient 'updating'.
   */
  liveStatus: Record<number, string>;
  /** Epoch ms of the last successful fetch for `key`. */
  fetchedAt: number;

  fetchDevices: () => Promise<void>;
  /** Debounced fetch (several socket events in a row → one request). */
  scheduleRefetch: () => void;
  applyPatch: (payload: AgentDevicePatchPayload) => void;
  setLiveStatus: (deviceId: number, status: string, wsConnected?: boolean) => void;
  removeDevice: (deviceId: number) => void;
}

let inflight: { key: string; promise: Promise<void> } | null = null;
let fetchAgain = false;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  key: null,
  devices: [],
  liveStatus: {},
  fetchedAt: 0,

  fetchDevices: () => {
    const key = currentAgentCacheKey();
    // Single flight per key; a request made meanwhile (socket delta) re-runs
    // once the current one settles so it never misses that change.
    if (inflight && inflight.key === key) {
      fetchAgain = true;
      return inflight.promise;
    }
    const run = async (): Promise<void> => {
      try {
        const devices = await agentApi.listDevices();
        // User / tenant changed while in flight: the answer belongs to the
        // previous context — drop it.
        if (key !== currentAgentCacheKey()) return;
        const prevLive = get().key === key ? get().liveStatus : {};
        const liveStatus: Record<number, string> = {};
        for (const d of devices) {
          // Keep a transient 'updating' badge (cleared by the next status event).
          if (prevLive[d.id] === 'updating') liveStatus[d.id] = 'updating';
        }
        set({ key, devices, liveStatus, fetchedAt: Date.now() });
      } catch {
        // Keep the rows on screen; the next poll retries.
      }
    };
    const promise = (async () => {
      do {
        fetchAgain = false;
        await run();
      } while (fetchAgain && key === currentAgentCacheKey());
    })().finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { key, promise };
    return promise;
  },

  scheduleRefetch: () => {
    if (refetchTimer) clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      void get().fetchDevices();
    }, REFETCH_DEBOUNCE_MS);
  },

  applyPatch: ({ deviceId, patch }) => {
    const state = get();
    if (state.key !== currentAgentCacheKey()) return;
    const fields = definedFields(patch);
    const idx = state.devices.findIndex(d => d.id === deviceId);
    // Unknown device (newly registered / approved / moved into view) or a
    // payload carrying no field (legacy bulk event): re-read the list.
    if (idx < 0 || Object.keys(fields).length === 0) {
      get().scheduleRefetch();
      return;
    }
    const devices = state.devices.slice();
    devices[idx] = { ...devices[idx], ...fields };
    set({ devices });
  },

  setLiveStatus: (deviceId, status, wsConnected) => {
    const state = get();
    if (state.key !== currentAgentCacheKey()) return;
    const liveStatus = { ...state.liveStatus, [deviceId]: status };
    if (wsConnected === undefined) {
      set({ liveStatus });
      return;
    }
    set({
      liveStatus,
      devices: state.devices.map(d => (d.id === deviceId && d.wsConnected !== wsConnected ? { ...d, wsConnected } : d)),
    });
  },

  removeDevice: (deviceId) => {
    const state = get();
    if (!state.devices.some(d => d.id === deviceId)) return;
    const liveStatus = { ...state.liveStatus };
    delete liveStatus[deviceId];
    set({ devices: state.devices.filter(d => d.id !== deviceId), liveStatus });
  },
}));

const EMPTY: AgentDevice[] = [];

/** Devices of the current user + tenant (empty while another key is cached). */
export function useAgentDevices(): AgentDevice[] {
  const userId = useAuthStore(s => s.user?.id);
  const tenantId = useTenantStore(s => s.currentTenantId);
  const key = agentCacheKey(userId, tenantId);
  return useAgentStore(s => (s.key === key ? s.devices : EMPTY));
}

/** True once the rows of the current user + tenant have been fetched. */
export function useAgentDevicesLoaded(): boolean {
  const userId = useAuthStore(s => s.user?.id);
  const tenantId = useTenantStore(s => s.currentTenantId);
  const key = agentCacheKey(userId, tenantId);
  return useAgentStore(s => s.key === key);
}

/**
 * Keeps the store fresh while mounted (AppLayout): fetch on mount and on every
 * user / tenant change, then every 30 s. Background tabs skip the poll (socket
 * deltas keep the rows live) and catch up as soon as they are visible again.
 */
export function useAgentDevicesPolling(): void {
  const userId = useAuthStore(s => s.user?.id);
  const tenantId = useTenantStore(s => s.currentTenantId);
  const key = agentCacheKey(userId, tenantId);

  useEffect(() => {
    if (userId == null || tenantId == null) return;
    const { fetchDevices } = useAgentStore.getState();
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void fetchDevices();
    };
    const s = useAgentStore.getState();
    const age = s.key === key ? Date.now() - s.fetchedAt : Infinity;
    let interval: ReturnType<typeof setInterval> | undefined;
    let firstTick: ReturnType<typeof setTimeout> | undefined;
    if (age >= 0 && age < AGENT_REFRESH_MS) {
      // Remount on fresh rows: resume the cadence from the last fetch.
      firstTick = setTimeout(() => {
        refresh();
        interval = setInterval(refresh, AGENT_REFRESH_MS);
      }, AGENT_REFRESH_MS - age);
    } else {
      void fetchDevices();
      interval = setInterval(refresh, AGENT_REFRESH_MS);
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchDevices();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(firstTick);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, userId, tenantId]);
}
