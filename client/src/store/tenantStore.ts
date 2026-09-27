import { create } from 'zustand';
import type { TenantWithRole } from '@obliview/shared';

interface TenantState {
  currentTenantId: number | null;
  tenants: TenantWithRole[];
  isLoading: boolean;
  fetchTenants: () => Promise<void>;
  setCurrentTenant: (tenantId: number) => Promise<void>;
}

// Same-tab switch guard: responses to requests sent with the old tenant header
// that land after the server committed the switch echo the new tenant; they are
// expected and must not trigger a mismatch re-sync (full reload). Covers the
// switch itself plus a short tail for requests still in flight.
let switchGuardUntil = 0;
export function isTenantSwitchPending(): boolean {
  return Date.now() < switchGuardUntil;
}

export const useTenantStore = create<TenantState>((set) => ({
  currentTenantId: null,
  tenants: [],
  isLoading: false,

  fetchTenants: async () => {
    try {
      set({ isLoading: true });
      const res = await fetch('/api/tenants', { credentials: 'include' });
      if (!res.ok) { set({ isLoading: false }); return; }
      const data = await res.json();
      set({ tenants: data.data ?? [], isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  setCurrentTenant: async (tenantId: number) => {
    switchGuardUntil = Number.POSITIVE_INFINITY;
    try {
      const res = await fetch('/api/tenant/switch', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId }),
      });
      if (!res.ok) return;
      set({ currentTenantId: tenantId });
    } catch {
      // ignore
    } finally {
      switchGuardUntil = Date.now() + 3000;
    }
  },
}));
