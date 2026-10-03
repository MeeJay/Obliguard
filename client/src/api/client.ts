import axios from 'axios';
// The i18next singleton (initialised by ../i18n); no React, no cycle.
import i18n from 'i18next';
// tenantStore imports only zustand + shared types (no cycle); never import authStore here.
import { useTenantStore } from '../store/tenantStore';
// twoFactorGate has no imports (module-level bridge to <TwoFactorGate>).
import { awaitStepUp, type StepUpMethod } from '../utils/twoFactorGate';

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

/** Error code of the 401 a sensitive action answers without a fresh step-up. */
export const TWO_FACTOR_REQUIRED = 'TWO_FACTOR_REQUIRED';

const STEP_UP_METHODS: readonly StepUpMethod[] = ['totp', 'email', 'password'];

/**
 * One prompt at a time: requests refused together (bulk actions, parallel
 * calls) wait on the same confirmation, which is session-wide on the server.
 */
let stepUpInFlight: Promise<void> | null = null;

function confirmStepUp(body: { action?: unknown; methods?: unknown; ttlSeconds?: unknown }): Promise<void> {
  if (!stepUpInFlight) {
    const methods = Array.isArray(body.methods)
      ? body.methods.filter((m): m is StepUpMethod => STEP_UP_METHODS.includes(m as StepUpMethod))
      : [];
    stepUpInFlight = awaitStepUp({
      action: typeof body.action === 'string' ? body.action : '',
      methods: methods.length > 0 ? methods : ['password'],
      ttlSeconds: typeof body.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
    }).finally(() => { stepUpInFlight = null; });
  }
  return stepUpInFlight;
}

// ── Error code translation ──────────────────────────────────────────────────
// The server answers `{ error, code, params? }` (server/src/utils/errorCodes.ts).
// `errors.<code>` in the locale files is the translation; the server `error`
// text (English) stays the fallback: unknown code, missing key, or a
// placeholder the response does not fill.

const ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Body fields that are not translation placeholders. */
const NON_PARAM_FIELDS = new Set(['success', 'error', 'serverError', 'code', 'params', 'details']);

/** Placeholder values: the top-level scalars of the body (e.g. `count`), then `params`. */
function errorParams(body: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const take = (src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) {
      if (NON_PARAM_FIELDS.has(k)) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    }
  };
  take(body);
  if (body.params && typeof body.params === 'object' && !Array.isArray(body.params)) {
    take(body.params as Record<string, unknown>);
  }
  return out;
}

/**
 * Translated text of an API error body (`{ error, code, params? }`), or null
 * when there is nothing to translate (the caller keeps the server text).
 * Also for fetch() callers (tenantFetch) and per-row errors that carry a code.
 */
export function localizeApiError(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !i18n.isInitialized) return null;
  const b = body as Record<string, unknown>;
  const code = b.code;
  if (typeof code !== 'string' || !ERROR_CODE_RE.test(code)) return null;
  const key = `errors.${code}`;
  const vars = errorParams(b);
  // Values go through `replace`, never spread as t() options: a body field
  // named lng / ns / context / defaultValue must not steer the lookup.
  const plural = typeof vars.count === 'number' ? { count: vars.count } : {};
  if (!i18n.exists(key, plural)) return null;
  // skipOnVariables keeps an unfilled `{{name}}` as is: detected below.
  const text: unknown = i18n.t(key, { ...plural, replace: vars, interpolation: { escapeValue: false, skipOnVariables: true } });
  if (typeof text !== 'string' || !text || text === key || /\{\{.*?\}\}/.test(text)) return null;
  return text;
}

/**
 * Replaces `error` by its translation in place, so every caller that shows
 * `response.data.error` (toasts, inline errors) gets the user's language.
 * The English text stays in `serverError`.
 */
function translateErrorBody(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const b = data as Record<string, unknown>;
  if (typeof b.serverError === 'string') return; // already translated (replayed request)
  const text = localizeApiError(b);
  if (text === null) return;
  b.serverError = typeof b.error === 'string' ? b.error : undefined;
  b.error = text;
}

// Response interceptor: step-up prompt + replay, tenant re-sync triggers + 401
apiClient.interceptors.response.use(
  (response) => {
    const sent = response.config.headers?.[TENANT_HEADER];
    const got = response.headers?.['x-obliguard-tenant'];
    if (sent != null && got != null && String(sent) !== String(got)) dispatchSessionResync('tenantChanged');
    return response;
  },
  async (error) => {
    const status = error.response?.status;
    const code = error.response?.data?.code;
    translateErrorBody(error.response?.data);

    // ── Step-up for a sensitive action ──────────────────────────────────────
    // MUST run before the plain-401 branch below: a 401 TWO_FACTOR_REQUIRED is
    // not a lost session. The gate prompts, the prompt confirms the session
    // (POST /profile/2fa/step-up), then the original request is replayed ONCE
    // (`_stepUpRetried`): a second refusal is returned to the caller as is.
    // Closing the prompt rejects with TWO_FACTOR_CANCELLED (isStepUpCancelled).
    if (status === 401 && (code === TWO_FACTOR_REQUIRED || error.response?.data?.twoFactorRequired === true)) {
      const config = error.config as (typeof error.config & { _stepUpRetried?: boolean }) | undefined;
      if (!config || config._stepUpRetried) return Promise.reject(error);
      await confirmStepUp(error.response.data ?? {});
      return apiClient({ ...config, _stepUpRetried: true } as typeof config);
    }

    if (
      (status === 403 && (code === 'noTenantAccess' || code === 'twoFactorSetupRequired'))
      || (status === 409 && code === 'tenantChanged')
    ) {
      // twoFactorSetupRequired: force_2fa switched on mid-session; the resync
      // refreshes requires2faSetup and ProtectedRoute sends the user to setup.
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
  let res = await fetch(input, { credentials: 'include', ...init, headers });
  // Same step-up contract as apiClient: prompt, then replay the call once.
  if (res.status === 401) {
    const body = await res.clone().json().catch(() => null) as
      { code?: unknown; twoFactorRequired?: unknown; action?: unknown; methods?: unknown; ttlSeconds?: unknown } | null;
    if (body && (body.code === TWO_FACTOR_REQUIRED || body.twoFactorRequired === true)) {
      await confirmStepUp(body);
      res = await fetch(input, { credentials: 'include', ...init, headers });
    }
  }
  const got = res.headers.get(TENANT_HEADER);
  if (tid != null && got != null && got !== String(tid)) dispatchSessionResync('tenantChanged');
  if (res.status === 403 || res.status === 409) {
    res.clone().json()
      .then((b: { code?: string } | null) => {
        if (b?.code === 'noTenantAccess' || b?.code === 'tenantChanged' || b?.code === 'twoFactorSetupRequired') {
          dispatchSessionResync(b.code);
        }
      })
      .catch(() => { /* not JSON */ });
  }
  return res;
}

export default apiClient;
