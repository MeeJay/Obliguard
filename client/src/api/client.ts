import axios from 'axios';
// tenantStore imports only zustand + shared types (no cycle); never import authStore here.
import { useTenantStore } from '../store/tenantStore';

// ObliTools (cross-site iframe / WebView2 shell): Chrome blocks all cookies for cross-site
// iframes, so we use X-Auth-Token header instead. The token = req.sessionID, stored in
// sessionStorage after login and sent on every request via the interceptor below.
export const isInObliTools = (() => {
  try { return window !== window.top; } catch { return true; }
})() || !!(window as unknown as { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

export const OBLITOOLS_TOKEN_KEY = 'oblitools_auth_token';

/**
 * Operating-tenant assertion. Every request carries the tenant this tab is
 * showing; the server answers 409 tenantChanged to a write when the shared
 * session moved to another tenant (another tab switched), and echoes the
 * session tenant on every tenant-scoped response.
 */
export const TENANT_HEADER = 'X-Obliguard-Tenant';
/** Window event asking authStore to re-sync the session (single-flight there). */
export const SESSION_RESYNC_EVENT = 'obliguard:session-resync';

export function dispatchSessionResync(reason: string): void {
  window.dispatchEvent(new CustomEvent(SESSION_RESYNC_EVENT, { detail: { reason } }));
}

const apiClient = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: inject X-Auth-Token header when running inside ObliTools.
apiClient.interceptors.request.use((config) => {
  if (isInObliTools) {
    const token = sessionStorage.getItem(OBLITOOLS_TOKEN_KEY);
    if (token) {
      config.headers['X-Auth-Token'] = token;
    }
  }
  const tid = useTenantStore.getState().currentTenantId;
  if (tid != null) config.headers[TENANT_HEADER] = String(tid);
  return config;
});

// Response interceptor: tenant re-sync triggers + 401
apiClient.interceptors.response.use(
  (response) => {
    const sent = response.config.headers?.[TENANT_HEADER];
    const got = response.headers?.['x-obliguard-tenant'];
    if (sent != null && got != null && String(sent) !== String(got)) dispatchSessionResync('tenantChanged');
    return response;
  },
  (error) => {
    const status = error.response?.status;
    const code = error.response?.data?.code;
    if ((status === 403 && code === 'noTenantAccess') || (status === 409 && code === 'tenantChanged')) {
      dispatchSessionResync(code);
    }
    if (error.response?.status === 401) {
      if (isInObliTools) {
        // In ObliTools: clear the stale token but don't hard-redirect — let React Router handle it.
        sessionStorage.removeItem(OBLITOOLS_TOKEN_KEY);
      } else {
        // Normal browser: redirect to login if session expired — but not on SSO pages
        const { pathname } = window.location;
        if (pathname !== '/login' && pathname !== '/auth/foreign') {
          window.location.href = '/login';
        }
      }
    }
    return Promise.reject(error);
  },
);

/**
 * fetch() wrapper for tenant-scoped calls that do not go through apiClient:
 * same operating-tenant header and the same re-sync triggers.
 */
export async function tenantFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const tid = useTenantStore.getState().currentTenantId;
  if (tid != null) headers.set(TENANT_HEADER, String(tid));
  const res = await fetch(input, { credentials: 'include', ...init, headers });
  const got = res.headers.get(TENANT_HEADER);
  if (tid != null && got != null && got !== String(tid)) dispatchSessionResync('tenantChanged');
  if (res.status === 403 || res.status === 409) {
    res.clone().json()
      .then((b: { code?: string } | null) => {
        if (b?.code === 'noTenantAccess' || b?.code === 'tenantChanged') dispatchSessionResync(b.code);
      })
      .catch(() => { /* not JSON */ });
  }
  return res;
}

export default apiClient;
