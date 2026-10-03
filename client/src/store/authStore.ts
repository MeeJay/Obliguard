import { create } from 'zustand';
import type { User, UserPermissions, PermissionLevel, CapabilityKey } from '@obliview/shared';
import { holdsCapability } from '@obliview/shared';
import { authApi, type LoginResult } from '../api/auth.api';
import { connectSocket, disconnectSocket, getSocket } from '../socket/socketClient';
import { useLiveAlertsStore } from './liveAlertsStore';
import { setLanguage } from '../i18n';
import { useTenantStore, isTenantSwitchPending } from './tenantStore';
import { useGroupStore } from './groupStore';
import { applyTheme } from '../utils/theme';
import apiClient, { SESSION_RESYNC_EVENT } from '../api/client';

function syncPreferencesToStore(user: User) {
  const prefs = user.preferences;
  if (prefs) {
    useLiveAlertsStore.getState().setEnabled(prefs.toastEnabled ?? true);
    useLiveAlertsStore.getState().setPosition(prefs.toastPosition ?? 'bottom-right');
    if (prefs.preferredTheme) {
      applyTheme(prefs.preferredTheme);
    }
  }
  if (user.preferredLanguage) {
    setLanguage(user.preferredLanguage);
  }
}

interface AuthState {
  user: User | null;
  permissions: UserPermissions | null;
  requires2faSetup: boolean;
  /** Non-admin with no usable tenant: the app shows NoTenantPage. */
  noTenantAccess: boolean;
  /** Favourite workspace opened at sign-in (null = first membership). */
  preferredTenantId: number | null;
  isLoading: boolean;
  isInitialized: boolean;

  login: (username: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  refreshPermissions: () => Promise<void>;
  /** Set (or clear with null) the favourite workspace. */
  setDefaultTenant: (tenantId: number | null) => Promise<void>;

  // Convenience permission checkers
  isAdmin: () => boolean;
  /**
   * Capability check in the current tenant (platform admin ⇒ always true): a
   * tenant capability ('bans.create') or a legacy alias ('bans', 'monitor_rw':
   * held when every capability it stands for is held).
   */
  hasCapability: (capability: CapabilityKey) => boolean;
  /** Role in the current tenant (permission-set slug), or null. */
  tenantRole: () => string | null;
  canCreate: () => boolean;
  canWriteGroup: (groupId: number) => boolean;
  getGroupPermission: (groupId: number) => PermissionLevel | null;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  permissions: null,
  requires2faSetup: false,
  noTenantAccess: false,
  preferredTenantId: null,
  isLoading: false,
  isInitialized: false,

  login: async (username: string, password: string) => {
    set({ isLoading: true });
    try {
      const result = await authApi.login({ username, password });

      // 2FA required — don't set user yet, return the challenge to caller
      if (result.requires2fa) {
        set({ isLoading: false });
        return result;
      }

      // Load the full session (user, permissions, tenant, noTenantAccess) before
      // the caller navigates, so the dashboard never flashes for a user who
      // ends up on NoTenantPage.
      await get().checkSession();
      set({ isLoading: false });
      if (!get().user) throw new Error('Unable to load session');
      return result;
    } catch (err) {
      set({ isLoading: false });
      const axiosErr = err as { response?: { data?: { error?: string }; status?: number }; message?: string };
      const serverMessage = axiosErr?.response?.data?.error;
      const status = axiosErr?.response?.status;
      if (status === 429) {
        throw new Error(serverMessage ?? 'Too many login attempts, please try again later');
      } else if (status === 401) {
        throw new Error(serverMessage ?? 'Invalid username or password');
      } else if (serverMessage) {
        throw new Error(serverMessage);
      } else {
        throw new Error(axiosErr?.message ?? 'Unable to connect to the server');
      }
    }
  },

  logout: async () => {
    // Fetch Obligate logout URL BEFORE destroying local state
    let obligateLogoutUrl: string | null = null;
    try {
      const res = await fetch('/api/auth/sso-logout-url', { credentials: 'include' });
      const data = await res.json() as { success: boolean; data: string | null };
      if (data.success && data.data) obligateLogoutUrl = data.data;
    } catch { /* ignore */ }

    try {
      await authApi.logout();
    } finally {
      disconnectSocket();
      set({ user: null, permissions: null, requires2faSetup: false, noTenantAccess: false, preferredTenantId: null });
    }

    if (obligateLogoutUrl) {
      window.location.href = obligateLogoutUrl;
    }
  },

  checkSession: async () => {
    try {
      const { user, permissions, requires2faSetup, currentTenantId, noTenantAccess, preferredTenantId } = await authApi.me();
      const prev2faSetup = get().requires2faSetup;
      const blocked = !!noTenantAccess && user.role !== 'admin';
      set({
        user,
        permissions,
        requires2faSetup: requires2faSetup ?? false,
        noTenantAccess: blocked,
        preferredTenantId: preferredTenantId ?? user.preferredTenantId ?? null,
        isInitialized: true,
      });
      syncPreferencesToStore(user);
      const prevTenantId = useTenantStore.getState().currentTenantId;
      useTenantStore.setState({ currentTenantId: currentTenantId ?? null });
      useTenantStore.getState().fetchTenants();
      if (blocked) {
        // No tenant: no socket (refused server-side anyway), no tenant-scoped fetches.
        disconnectSocket();
      } else {
        // A live socket joined the previous tenant's rooms at handshake: rebuild
        // it when the session now operates another tenant.
        if (prevTenantId != null && currentTenantId != null && prevTenantId !== currentTenantId) {
          disconnectSocket();
        }
        // While a forced second factor is missing the socket joins no tenant
        // room (server side): rebuild it when that state flips either way.
        if (prev2faSetup !== (requires2faSetup ?? false)) {
          disconnectSocket();
        }
        connectSocket();
        useLiveAlertsStore.getState().fetchAlerts();
        useGroupStore.getState().fetchTree();
      }
    } catch {
      set({ user: null, permissions: null, requires2faSetup: false, noTenantAccess: false, isInitialized: true });
    }
  },

  refreshPermissions: async () => {
    try {
      const permissions = await authApi.getPermissions();
      set({ permissions });
    } catch {
      // Ignore errors
    }
  },

  setDefaultTenant: async (tenantId: number | null) => {
    const res = await apiClient.post<{ success: boolean; data?: { preferredTenantId: number | null } }>('/tenant/default', { tenantId });
    set({ preferredTenantId: res.data.data?.preferredTenantId ?? tenantId });
  },

  isAdmin: () => get().user?.role === 'admin',

  hasCapability: (capability: CapabilityKey) => {
    const { user, permissions } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (!permissions) return false;
    // Older servers only send `capabilities` (aliases included).
    if (!permissions.tenantCapabilities) return permissions.capabilities?.includes(capability) ?? false;
    return holdsCapability(permissions.tenantCapabilities, capability);
  },

  tenantRole: () => get().permissions?.tenantRole ?? null,

  // Group writes also need the tenant capability groups.manage (server rbac
  // requireCanCreate / requireGroupWrite): a viewer in an RW team gets none.
  canCreate: () => {
    const { user, permissions } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (!get().hasCapability('groups.manage')) return false;
    return permissions?.canCreate ?? false;
  },

  canWriteGroup: (groupId: number) => {
    const { user, permissions } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (!permissions) return false;
    if (!get().hasCapability('groups.manage')) return false;
    return permissions.permissions[`group:${groupId}`] === 'rw';
  },

  getGroupPermission: (groupId: number) => {
    const { user, permissions } = get();
    if (!user) return null;
    if (user.role === 'admin') return 'rw';
    if (!permissions) return null;
    return permissions.permissions[`group:${groupId}`] ?? null;
  },
}));

// ── Session re-sync (single-flight) ──────────────────────────────────────────
// Fired by api/client (403 noTenantAccess, 409 tenantChanged, response-tenant
// mismatch) and socketClient (server-initiated disconnect). Reloads to '/' when
// the tenant changed or access was regained, so stores of the old tenant are
// never shown under the new one. Loop guards: in-flight flag, skip when already
// blocked, 2 s cooldown, no socket/fetches while blocked.
let resyncInFlight: Promise<void> | null = null;
let lastResyncAt = 0;

export function resyncSession(): Promise<void> {
  if (resyncInFlight) return resyncInFlight;
  const prevTenant = useTenantStore.getState().currentTenantId;
  const prevBlocked = useAuthStore.getState().noTenantAccess;
  resyncInFlight = useAuthStore.getState().checkSession()
    .then(() => {
      const s = useAuthStore.getState();
      if (!s.user) return; // 401 path: handled by the interceptor / ProtectedRoute
      const next = useTenantStore.getState().currentTenantId;
      if ((prevBlocked && !s.noTenantAccess) || (prevTenant != null && next != null && next !== prevTenant)) {
        window.location.assign('/');
      }
    })
    .finally(() => {
      resyncInFlight = null;
      lastResyncAt = Date.now();
    });
  return resyncInFlight;
}

function onSessionResync(e: Event): void {
  const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason;
  const s = useAuthStore.getState();
  if (!s.user || !s.isInitialized) return;
  if (reason === 'noTenantAccess' && s.noTenantAccess) return;
  // Already known: ProtectedRoute holds the user on the 2FA setup page.
  if (reason === 'twoFactorSetupRequired' && s.requires2faSetup) return;
  // Mismatch / 409 caused by our own in-flight tenant switch in this tab: expected.
  if (reason === 'tenantChanged' && isTenantSwitchPending()) return;
  if (reason === 'socket') {
    // A server disconnect is never auto-reconnected: the socket must be rebuilt
    // by a checkSession. No cooldown here; if a resync is already running (it
    // may have called connectSocket() before the socket was dropped), re-check
    // once it settles.
    const pending = resyncInFlight ?? Promise.resolve();
    void pending.finally(() => {
      const cur = useAuthStore.getState();
      if (cur.user && !cur.noTenantAccess && !getSocket()) void resyncSession();
    });
    return;
  }
  if (Date.now() - lastResyncAt < 2000) return; // belt-and-braces against 403 → resync → 403 bursts
  void resyncSession();
}

if (typeof window !== 'undefined') window.addEventListener(SESSION_RESYNC_EVENT, onSessionResync);
