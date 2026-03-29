import { create } from 'zustand';
import apiClient from '../api/client';

// ── Types ────────────────────────────────────────────────────────────────────

export interface NetMapTab {
  id: string;
  name: string;
  agentIds: number[];
  sortOrder: number;
}

interface TabState {
  tabs: NetMapTab[];
  activeTabId: string | null; // null = "All Agents"
  loaded: boolean;

  load: () => Promise<void>;
  setActiveTab: (id: string | null) => void;
  addTab: (tab: Omit<NetMapTab, 'id' | 'sortOrder'>) => void;
  updateTab: (id: string, patch: Partial<Pick<NetMapTab, 'name' | 'agentIds'>>) => void;
  deleteTab: (id: string) => void;
  reorderTabs: (ids: string[]) => void;
}

const LS_KEY = 'obliguard-netmap-tabs';

function genId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Persistence helpers ──────────────────────────────────────────────────────

function saveToLocalStorage(tabs: NetMapTab[]): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(tabs)); } catch { /* quota */ }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistToServer(tabs: NetMapTab[]): void {
  saveToLocalStorage(tabs);
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      await apiClient.patch('/profile', { preferences: { netmapTabs: tabs } });
    } catch { /* silent — localStorage is the fallback */ }
  }, 1500);
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useNetMapTabStore = create<TabState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  loaded: false,

  load: async () => {
    // Load from localStorage first (instant)
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as NetMapTab[];
        if (Array.isArray(parsed)) set({ tabs: parsed });
      }
    } catch { /* corrupt */ }

    // Then fetch from server preferences (authoritative)
    try {
      const res = await apiClient.get<{ data: { preferences?: { netmapTabs?: NetMapTab[] } } }>('/profile');
      const serverTabs = res.data?.data?.preferences?.netmapTabs;
      if (Array.isArray(serverTabs) && serverTabs.length > 0) {
        set({ tabs: serverTabs, loaded: true });
        saveToLocalStorage(serverTabs);
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true }); // offline — use localStorage version
    }
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  addTab: (tab) => {
    const { tabs } = get();
    const newTab: NetMapTab = {
      id: genId(),
      name: tab.name,
      agentIds: tab.agentIds,
      sortOrder: tabs.length,
    };
    const updated = [...tabs, newTab];
    set({ tabs: updated, activeTabId: newTab.id });
    persistToServer(updated);
  },

  updateTab: (id, patch) => {
    const updated = get().tabs.map(t =>
      t.id === id ? { ...t, ...patch } : t,
    );
    set({ tabs: updated });
    persistToServer(updated);
  },

  deleteTab: (id) => {
    const { tabs, activeTabId } = get();
    const updated = tabs.filter(t => t.id !== id);
    set({
      tabs: updated,
      activeTabId: activeTabId === id ? null : activeTabId,
    });
    persistToServer(updated);
  },

  reorderTabs: (ids) => {
    const { tabs } = get();
    const byId = new Map(tabs.map(t => [t.id, t]));
    const updated = ids
      .map((id, i) => {
        const t = byId.get(id);
        return t ? { ...t, sortOrder: i } : null;
      })
      .filter(Boolean) as NetMapTab[];
    set({ tabs: updated });
    persistToServer(updated);
  },
}));
