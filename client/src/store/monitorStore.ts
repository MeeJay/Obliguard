import { create } from 'zustand';

// ── Local type stubs (Monitor/Heartbeat removed from @obliview/shared) ────────

export interface Monitor {
  id: number;
  name: string;
  type: string;
  groupId: number | null;
  isActive: boolean;
  status: string;
  intervalSeconds: number | null;
  retryIntervalSeconds: number | null;
  maxRetries: number | null;
  timeoutMs: number | null;
  isPaused: boolean;
  inMaintenance: boolean;
  agentDeviceId?: number | null;
  valueWatcherPreviousValue?: string | null;
  [key: string]: unknown;
}

export interface Heartbeat {
  id?: number;
  monitorId?: number;
  status: string;
  responseTime?: number | null;
  message?: string | null;
  inMaintenance?: boolean;
  value?: string | null;
  createdAt?: string;
  [key: string]: unknown;
}

// ── Stub monitorsApi (monitors removed from Obliguard) ────────────────────────

const monitorsApi = {
  list: async (): Promise<Monitor[]> => [],
  getSummary: async (): Promise<Record<number, { uptimePct: number; avgResponseTime: number | null }>> => ({}),
  getAllHeartbeats: async (_count?: number): Promise<Record<string, Heartbeat[]>> => ({}),
  getHeartbeatsByPeriod: async (_id: number, _period: string): Promise<Heartbeat[]> => [],
  update: async (_id: number, _data: Partial<Monitor>): Promise<Monitor> => { throw new Error('monitors removed'); },
};

export interface MonitorSummary {
  uptimePct: number;
  avgResponseTime: number | null;
}

interface MonitorStore {
  monitors: Map<number, Monitor>;
  heartbeats: Map<number, Heartbeat[]>;
  summary: Record<number, MonitorSummary>;
  isLoading: boolean;

  // Actions
  fetchMonitors: () => Promise<void>;
  fetchSummary: () => Promise<void>;
  fetchAllHeartbeats: (count?: number) => Promise<void>;
  addMonitor: (monitor: Monitor) => void;
  updateMonitor: (id: number, data: Partial<Monitor>) => void;
  removeMonitor: (id: number) => void;
  addHeartbeat: (monitorId: number, heartbeat: Heartbeat) => void;
  setHeartbeats: (monitorId: number, heartbeats: Heartbeat[]) => void;

  // Getters (as functions)
  getMonitor: (id: number) => Monitor | undefined;
  getMonitorList: () => Monitor[];
  getMonitorsByGroup: (groupId: number | null) => Monitor[];
  getRecentHeartbeats: (monitorId: number) => Heartbeat[];
  getMonitorSummary: (monitorId: number) => MonitorSummary | undefined;
}

/** Max heartbeats kept in memory — updated dynamically by fetchAllHeartbeats */
let maxHeartbeats = 50;

export const useMonitorStore = create<MonitorStore>((set, get) => ({
  monitors: new Map(),
  heartbeats: new Map(),
  summary: {},
  isLoading: false,

  fetchMonitors: async () => {
    set({ isLoading: true });
    try {
      const list = await monitorsApi.list();
      const monitors = new Map<number, Monitor>();
      list.forEach((m: Monitor) => monitors.set(m.id, m));
      set({ monitors, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  fetchSummary: async () => {
    try {
      const data = await monitorsApi.getSummary();
      set({ summary: data });
    } catch {
      // ignore
    }
  },

  fetchAllHeartbeats: async (count = 50) => {
    try {
      maxHeartbeats = Math.max(maxHeartbeats, count);
      const data = await monitorsApi.getAllHeartbeats(count);
      set((state) => {
        const heartbeats = new Map(state.heartbeats);
        for (const [idStr, hbs] of Object.entries(data) as [string, Heartbeat[]][]) {
          const id = Number(idStr);
          heartbeats.set(id, hbs.slice(-maxHeartbeats));
        }
        return { heartbeats };
      });
    } catch {
      // ignore
    }
  },

  addMonitor: (monitor) => {
    set((state) => {
      const monitors = new Map(state.monitors);
      monitors.set(monitor.id, monitor);
      return { monitors };
    });
  },

  updateMonitor: (id, data) => {
    set((state) => {
      const monitors = new Map(state.monitors);
      const existing = monitors.get(id);
      if (existing) {
        monitors.set(id, { ...existing, ...data });
      }
      return { monitors };
    });
  },

  removeMonitor: (id) => {
    set((state) => {
      const monitors = new Map(state.monitors);
      monitors.delete(id);
      const heartbeats = new Map(state.heartbeats);
      heartbeats.delete(id);
      return { monitors, heartbeats };
    });
  },

  addHeartbeat: (monitorId, heartbeat) => {
    set((state) => {
      const heartbeats = new Map(state.heartbeats);
      const existing = heartbeats.get(monitorId) || [];
      const updated = [...existing, heartbeat].slice(-maxHeartbeats);
      heartbeats.set(monitorId, updated);

      // Also update monitor status and maintenance flag.
      // Guard: don't overwrite 'updating' with 'pending' — the agent emits
      // 'pending' heartbeats while self-updating (for uptime exclusion), but the
      // UI badge should stay on 'updating' until the agent reconnects.
      const monitors = new Map(state.monitors);
      const monitor = monitors.get(monitorId);
      if (monitor) {
        const newStatus = (heartbeat.status === 'pending' && monitor.status === 'updating')
          ? 'updating'
          : heartbeat.status;
        monitors.set(monitorId, {
          ...monitor,
          status: newStatus,
          inMaintenance: heartbeat.inMaintenance ?? monitor.inMaintenance,
        });
      }

      return { heartbeats, monitors };
    });
  },

  setHeartbeats: (monitorId, hbs) => {
    set((state) => {
      const heartbeats = new Map(state.heartbeats);
      heartbeats.set(monitorId, hbs.slice(-maxHeartbeats));
      return { heartbeats };
    });
  },

  getMonitor: (id) => get().monitors.get(id),
  getMonitorList: () => Array.from(get().monitors.values()),
  getMonitorsByGroup: (groupId) =>
    Array.from(get().monitors.values()).filter((m) => m.groupId === groupId),
  getRecentHeartbeats: (monitorId) => get().heartbeats.get(monitorId) || [],
  getMonitorSummary: (monitorId) => get().summary[monitorId],
}));
