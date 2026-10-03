import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LiveAlertData } from '@obliview/shared';
import { useTenantStore } from './tenantStore';

export type AlertSeverity = 'down' | 'up' | 'warning' | 'info';

/** Client-side alert object. Mirrors LiveAlertData but adds ephemeral UI state. */
export interface LiveAlert extends LiveAlertData {
  /** True when the toast popup was dismissed (auto-timer or X button). Ephemeral — resets on reload. */
  toastDismissed: boolean;
}

// ─── Persistent preferences (localStorage) ───────────────────────────────────

interface AlertPrefs {
  /** Show toast popups for the current tenant's alerts */
  localEnabled: boolean;
  /** Show toast popups for other tenants' alerts (visible only when user has multiple tenants) */
  multiTenantEnabled: boolean;
  position: 'top-center' | 'bottom-right';
}

// ─── Full store state ─────────────────────────────────────────────────────────

interface LiveAlertsState extends AlertPrefs {
  alerts: LiveAlert[];

  // ── Preferences ──────────────────────────────────────────────────────────────
  setLocalEnabled: (v: boolean) => void;
  setMultiTenantEnabled: (v: boolean) => void;
  setPosition: (p: 'top-center' | 'bottom-right') => void;
  /** Backward-compat alias used by authStore (reads user.preferences.toastEnabled) */
  setEnabled: (v: boolean) => void;

  // ── Server sync ───────────────────────────────────────────────────────────────
  /** Fetch all alerts (all accessible tenants) from the server and replace local state. */
  fetchAlerts: () => Promise<void>;
  /** Add a single alert received via socket (NOTIFICATION_NEW). */
  addAlertFromServer: (alert: LiveAlertData) => void;
  /** Drop incidents the server resolved (NOTIFICATION_RESOLVED). */
  applyResolvedFromServer: (ids: number[]) => void;
  /** Mark alerts read elsewhere as read here too (NOTIFICATION_READ). */
  applyReadFromServer: (ids: number[], readAt?: string | null) => void;

  // ── Actions ───────────────────────────────────────────────────────────────────
  /** Dismiss the toast popup for one alert (keeps it in the bell, does NOT mark as read). */
  dismissToast: (id: number) => void;
  /** Mark one alert as read (server + local). Also dismisses the toast. */
  markAlertRead: (id: number) => Promise<void>;
  /** Mark all current-tenant alerts as read (server + local). */
  markAllRead: () => Promise<void>;
  /** Delete one alert (server + local). */
  removeAlert: (id: number) => Promise<void>;
  /** Clear all alerts for current tenant (server + local). */
  clearAll: () => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toLocalAlert(data: LiveAlertData): LiveAlert {
  return { ...data, toastDismissed: false };
}

/** Resolved incidents are hidden by default (the server omits them unless asked). */
function isActive(data: LiveAlertData): boolean {
  return !data.resolvedAt;
}

async function apiPatch(path: string): Promise<void> {
  await fetch(path, { method: 'PATCH', credentials: 'include' });
}
async function apiPost(path: string): Promise<void> {
  await fetch(path, { method: 'POST', credentials: 'include' });
}
async function apiDelete(path: string): Promise<void> {
  await fetch(path, { method: 'DELETE', credentials: 'include' });
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useLiveAlertsStore = create<LiveAlertsState>()(
  persist(
    (set, get) => ({
      // Default preferences
      localEnabled: true,
      multiTenantEnabled: true,
      position: 'bottom-right',

      alerts: [],

      // ── Preferences ────────────────────────────────────────────────────────
      setLocalEnabled: (v) => set({ localEnabled: v }),
      setMultiTenantEnabled: (v) => set({ multiTenantEnabled: v }),
      setPosition: (p) => set({ position: p }),
      setEnabled: (v) => set({ localEnabled: v }),

      // ── Server sync ────────────────────────────────────────────────────────
      fetchAlerts: async () => {
        try {
          const res = await fetch('/api/live-alerts/all', { credentials: 'include' });
          if (!res.ok) return;
          const data = (await res.json()) as { alerts: LiveAlertData[] };
          set({ alerts: data.alerts.filter(isActive).map(toLocalAlert) });
        } catch {
          // Ignore network errors (user may not be logged in yet)
        }
      },

      addAlertFromServer: (alert) =>
        set((s) => {
          // Skip if already in list (e.g. double-emit) or already resolved
          if (!isActive(alert) || s.alerts.some((a) => a.id === alert.id)) return s;
          return { alerts: [toLocalAlert(alert), ...s.alerts].slice(0, 200) };
        }),

      applyResolvedFromServer: (ids) =>
        set((s) => {
          if (ids.length === 0) return s;
          const gone = new Set(ids);
          return { alerts: s.alerts.filter((a) => !gone.has(a.id)) };
        }),

      applyReadFromServer: (ids, readAt) =>
        set((s) => {
          if (ids.length === 0) return s;
          const read = new Set(ids);
          return {
            alerts: s.alerts.map((a) => read.has(a.id)
              ? { ...a, read: true, readAt: readAt ?? a.readAt ?? null, toastDismissed: true }
              : a),
          };
        }),

      // ── Actions ────────────────────────────────────────────────────────────
      dismissToast: (id) =>
        set((s) => ({
          alerts: s.alerts.map((a) => a.id === id ? { ...a, toastDismissed: true } : a),
        })),

      markAlertRead: async (id) => {
        // Optimistic update
        set((s) => ({
          alerts: s.alerts.map((a) => a.id === id ? { ...a, read: true, toastDismissed: true } : a),
        }));
        await apiPatch(`/api/live-alerts/${id}/read`);
      },

      markAllRead: async () => {
        set((s) => ({ alerts: s.alerts.map((a) => ({ ...a, read: true })) }));
        await apiPost('/api/live-alerts/read-all');
      },

      removeAlert: async (id) => {
        set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) }));
        await apiDelete(`/api/live-alerts/${id}`);
      },

      clearAll: async () => {
        set({ alerts: [] });
        await apiDelete('/api/live-alerts');
        // Reload to restore cross-tenant alerts that weren't in the cleared tenant
        await get().fetchAlerts();
      },
    }),
    {
      name: 'obliview-alert-prefs',
      // Only persist preferences, NOT the alert list (alerts always fetched fresh from server)
      partialize: (s) => ({
        localEnabled: s.localEnabled,
        multiTenantEnabled: s.multiTenantEnabled,
        position: s.position,
      }),
    },
  ),
);

// ─── Computed helpers (exported for components) ───────────────────────────────

/**
 * Open an alert's deep link (bell and toasts). An alert of another tenant
 * switches the session tenant first, then does a full page navigation so no
 * stale tenant data stays in memory (same as F5). Without a link, an
 * other-tenant alert lands on that tenant's dashboard.
 */
export async function openAlertLink(alert: LiveAlertData, navigate: (to: string) => void): Promise<void> {
  const { currentTenantId, setCurrentTenant } = useTenantStore.getState();
  if (alert.tenantId && currentTenantId != null && alert.tenantId !== currentTenantId) {
    await setCurrentTenant(alert.tenantId);
    window.location.href = alert.navigateTo ?? '/';
    return;
  }
  if (alert.navigateTo) navigate(alert.navigateTo);
}

/** Count of unread alerts, optionally filtered to a specific tenant. */
export function countUnread(alerts: LiveAlert[], tenantId?: number | null): number {
  return alerts.filter((a) => !a.read && (tenantId == null || a.tenantId === tenantId)).length;
}
