import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { isMasterTenant } from '@obliview/shared';
import { db } from '../db';
import { parseRequestAgentId } from '../services/agentScope.service';
import { isDeviceUuidFormat } from '../utils/agentIdentity';
import {
  stepUpService,
  STEP_UP_TTL_MS,
  TWO_FACTOR_REQUIRED,
  type StepUpAction,
} from '../services/stepUp.service';

/**
 * requireStepUp(action): the sensitive-action gate (services/stepUp.service.ts).
 *
 * Mounted AFTER the auth / tenant / capability guards of a route, so a caller
 * without the right is refused (401/403) before being asked for a proof.
 * Without a fresh step-up in the session the route answers
 *
 *   401 { code: 'TWO_FACTOR_REQUIRED', twoFactorRequired: true, action, methods, ttlSeconds }
 *
 * (the Obliance client contract: `twoFactorRequired` + `action`). The client
 * confirms through POST /profile/2fa/step-up, then replays the request once.
 * `methods` is what the account can give: 'totp', 'email', or 'password' for
 * an account without any second factor. An Obligate account is let through
 * and the exemption is audited. An account that can give no proof at all
 * (e-mail codes enabled but no OTP SMTP server) gets 403 STEP_UP_UNAVAILABLE.
 *
 * `when` restricts the gate to the sensitive branch of a route (e.g. a Lift
 * is only gated when it deactivates a global ban); it runs after the body
 * parser and the route's validators.
 */
export type StepUpPredicate = (req: Request) => boolean | Promise<boolean>;

export function requireStepUp(action: StepUpAction, when?: StepUpPredicate): RequestHandler {
  return async function stepUpGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.session?.userId) { next(); return; } // requireAuth answers
      if (when && !(await when(req))) { next(); return; }
      const st = await stepUpService.state(req);
      if (st.state === 'fresh' || st.state === 'unknown_user') { next(); return; }
      if (st.state === 'exempt') {
        stepUpService.auditExemption(req, action);
        next();
        return;
      }
      if (st.methods.length === 0) {
        res.status(403).json({
          success: false,
          error: 'This action needs a confirmation your account cannot give (no usable second factor). Ask an administrator.',
          code: 'STEP_UP_UNAVAILABLE',
          action,
        });
        return;
      }
      res.status(401).json({
        success: false,
        error: 'Confirm this action with your second factor',
        code: TWO_FACTOR_REQUIRED,
        twoFactorRequired: true,
        action,
        methods: st.methods,
        ttlSeconds: Math.round(STEP_UP_TTL_MS / 1000),
      });
    } catch (err) {
      next(err);
    }
  };
}

// ── Predicates of the sensitive branches ─────────────────────────────────────

function bodyOf(req: Request): Record<string, unknown> {
  const b = req.body as unknown;
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {};
}

/** Positive integer ids of body.ids (at most `max` read; malformed ones ignored). */
function bodyIds(req: Request, max = 1000): number[] {
  const raw = bodyOf(req).ids;
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw.slice(0, max)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    if (Number.isSafeInteger(n) && n > 0) out.push(n);
  }
  return out;
}

/**
 * Every id a controller may read from :name. The controllers differ
 * (parseInt for bans / whitelist, a strict /^\d+$/ for keys), so the gate
 * checks each reading: a lenient parse must never skip a target the
 * controller then acts on ('5abc' is ban 5 for parseInt).
 */
function paramIds(req: Request, name = 'id'): number[] {
  const raw = String(req.params?.[name] ?? '');
  const out = new Set<number>();
  for (const n of [Number(raw), parseInt(raw, 10)]) {
    if (Number.isSafeInteger(n) && n > 0 && n <= 2147483647) out.add(n);
  }
  return [...out];
}

/** The operating tenant is Default (authoritative / global writes). */
export function operatingDefault(req: Request): boolean {
  return req.tenantId != null && isMasterTenant(req.tenantId);
}

/** DELETE /bans/:id from Default on an active GLOBAL ban (global Lift). */
export async function isGlobalLift(req: Request): Promise<boolean> {
  if (!operatingDefault(req)) return false;
  const ids = paramIds(req);
  if (ids.length === 0) return false;
  const row = await db('ip_bans').whereIn('id', ids).where({ scope: 'global', is_active: true }).first('id');
  return !!row;
}

/** :id is an active ban (promote: an inactive or unknown ban is refused by the service). */
export async function isActiveBan(req: Request): Promise<boolean> {
  const ids = paramIds(req);
  if (ids.length === 0) return false;
  return !!(await db('ip_bans').whereIn('id', ids).where({ is_active: true }).first('id'));
}

/** POST /bans/bulk-lift from Default with at least one active global ban. */
export async function isGlobalBulkLift(req: Request): Promise<boolean> {
  if (!operatingDefault(req)) return false;
  const ids = bodyIds(req);
  if (ids.length === 0) return false;
  const row = await db('ip_bans').whereIn('id', ids).where({ scope: 'global', is_active: true }).first('id');
  return !!row;
}

/** POST /whitelist from Default on the main dimension (global entry). */
export function isGlobalWhitelistCreate(req: Request): boolean {
  if (!operatingDefault(req)) return false;
  const scope = bodyOf(req).scope;
  return scope !== 'group' && scope !== 'agent';
}

/** DELETE /whitelist/:id of a global entry (Default only can). */
export async function isGlobalWhitelistDelete(req: Request): Promise<boolean> {
  if (!operatingDefault(req)) return false;
  const ids = paramIds(req);
  if (ids.length === 0) return false;
  return !!(await db('ip_whitelist').whereIn('id', ids).where({ scope: 'global' }).first('id'));
}

/** POST /whitelist/bulk-delete with at least one global entry. */
export async function isGlobalWhitelistBulkDelete(req: Request): Promise<boolean> {
  if (!operatingDefault(req)) return false;
  const ids = bodyIds(req);
  if (ids.length === 0) return false;
  return !!(await db('ip_whitelist').whereIn('id', ids).where({ scope: 'global' }).first('id'));
}

// The agent routes below are refused by their controller (403 / 404) when the
// target is outside the operating tenant (no master bypass for writes, A5):
// the gate only asks for a proof when the write can actually happen, so a
// refused write keeps its own answer.

/**
 * :id is an agent of the operating tenant. Same reading as the controllers
 * (agentScope.resolveAgentAccess): a numeric id OR the agent's uuid.
 */
export async function isDeviceInTenant(req: Request): Promise<boolean> {
  if (req.tenantId == null) return false;
  const raw = req.params?.id;
  const id = parseRequestAgentId(raw);
  const uuid = id === null && isDeviceUuidFormat(raw) ? raw : null;
  if (id === null && uuid === null) return false; // the controller answers 400
  return !!(await db('agent_devices')
    .where(id !== null ? { id } : { uuid: uuid as string })
    .where({ tenant_id: req.tenantId })
    .first('id'));
}

/** body.deviceIds holds at least one agent of the operating tenant. */
export async function hasDevicesInTenant(req: Request): Promise<boolean> {
  const raw = bodyOf(req).deviceIds;
  if (!Array.isArray(raw) || req.tenantId == null) return false;
  const ids = raw.slice(0, 5000).map((v) => Number(v)).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (ids.length === 0) return false;
  return !!(await db('agent_devices').whereIn('id', ids).where({ tenant_id: req.tenantId }).first('id'));
}

/** Device command (single or bulk) that uninstalls the agent. */
export function isUninstallCommand(req: Request): boolean {
  return bodyOf(req).command === 'uninstall';
}

/** :id is an enrolment key of the operating tenant. */
export async function isKeyInTenant(req: Request): Promise<boolean> {
  const ids = paramIds(req);
  if (ids.length === 0 || req.tenantId == null) return false;
  return !!(await db('agent_api_keys').whereIn('id', ids).where({ tenant_id: req.tenantId }).first('id'));
}

/** PUT /agent/keys/:id that enables or disables a key of the tenant (a rename is not gated). */
export async function isKeyActivationChange(req: Request): Promise<boolean> {
  return Object.prototype.hasOwnProperty.call(bodyOf(req), 'isActive') && isKeyInTenant(req);
}

/** Combines predicates (all must hold). */
export function allOf(...preds: StepUpPredicate[]): StepUpPredicate {
  return async (req) => {
    for (const p of preds) if (!(await p(req))) return false;
    return true;
  };
}

/**
 * app_config keys whose write is a security setting or an integration secret:
 * the Obligate switch, the obli.tools key and contribution switch, the 2FA
 * policy and the SMTP server that carries the sign-in codes.
 */
export const STEP_UP_CONFIG_KEYS: readonly string[] = [
  'obligate_enabled',
  'oblitools_api_key',
  'oblitools_push_enabled',
  'allow_2fa',
  'force_2fa',
  'otp_smtp_server_id',
];

export function isSecretConfigKey(req: Request): boolean {
  return STEP_UP_CONFIG_KEYS.includes(String(req.params?.key ?? ''));
}

/** POST /users creating a platform admin or assigning the tenant admin set. */
export function isPrivilegedUserCreate(req: Request): boolean {
  const b = bodyOf(req);
  return b.role === 'admin' || b.tenantRole === 'admin';
}

/**
 * PUT /users/:id changing the platform role. The edit form always sends the
 * role, so an unchanged role is not a grant; an unknown target is gated
 * (fail-closed: the controller answers 404 after the prompt).
 */
export async function isUserRoleChange(req: Request): Promise<boolean> {
  const b = bodyOf(req);
  if (!Object.prototype.hasOwnProperty.call(b, 'role')) return false;
  const ids = paramIds(req);
  if (ids.length === 0) return true;
  const rows = await db('users').whereIn('id', ids).select('role') as Array<{ role: string | null }>;
  return rows.length === 0 || rows.some((r) => r.role !== b.role);
}

// ── POST /profile/2fa/step-up and GET /profile/2fa/step-up ───────────────────
// Kept next to the gate (no twoFactor.controller change): status and proof.

/** GET: { fresh, expiresAt, methods, exempt } of the current session. */
export async function stepUpStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const st = await stepUpService.state(req);
    if (st.state === 'unknown_user') { res.status(401).json({ success: false, error: 'User not found' }); return; }
    res.json({
      success: true,
      data: {
        fresh: st.state === 'fresh',
        expiresAt: st.state === 'fresh' ? new Date(st.expiresAt).toISOString() : null,
        method: st.state === 'fresh' ? st.method : null,
        methods: st.state === 'required' ? st.methods : [],
        exempt: st.state === 'exempt',
        ttlSeconds: Math.round(STEP_UP_TTL_MS / 1000),
      },
    });
  } catch (err) { next(err); }
}

/**
 * POST { method: 'totp', code } | { method: 'email' } (sends a code) |
 * { method: 'email', code } | { method: 'password', password }.
 * A wrong proof sets res.locals.currentPasswordRejected (the per-account
 * currentPasswordLimiter mounted on the route counts it).
 */
export async function stepUpVerify(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = bodyOf(req);
    const wantsEmailCode = body.method === 'email' && (body.code === undefined || body.code === null || body.code === '');
    const out = wantsEmailCode
      ? await stepUpService.sendEmailCode(req)
      : await stepUpService.verify(req, { method: body.method, code: body.code, password: body.password });
    if (!out.ok) {
      if (out.rejected) res.locals.currentPasswordRejected = true;
      if (out.status === 429 && typeof out.body.retryAfterSeconds === 'number') {
        res.setHeader('Retry-After', String(out.body.retryAfterSeconds));
      }
      res.status(out.status).json(out.body);
      return;
    }
    if ('sent' in out) {
      res.json({ success: true, data: { sent: true, email: out.email } });
      return;
    }
    res.json({ success: true, data: { method: out.method, expiresAt: new Date(out.expiresAt).toISOString() } });
  } catch (err) { next(err); }
}
