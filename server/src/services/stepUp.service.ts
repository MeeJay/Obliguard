import type { Request } from 'express';
import { db } from '../db';
import { twoFactorService, EMAIL_OTP_MAX_ATTEMPTS, type PendingEmailOtp } from './twoFactor.service';
import { appConfigService } from './appConfig.service';
import { auditService } from './audit.service';
import { comparePassword } from '../utils/crypto';
import { logger } from '../utils/logger';

/**
 * Step-up confirmation for sensitive actions (owner decision 14, phase 1 of
 * the Obliance restriction / step-up model).
 *
 * A fixed list of actions (STEP_UP_ACTIONS) needs a FRESH proof of the
 * account holder within the last STEP_UP_TTL_MS of the session:
 *   - a current TOTP code (anti-replay: the sign-in code is refused),
 *   - or an e-mail code sent for this purpose,
 *   - or, for an account without any second factor, the current password.
 * The trust is session-scoped (req.session.stepUpAt / stepUpMethod), so it
 * never follows a cookie to another session, and is dropped with the session
 * at sign-out / re-login (session regeneration).
 *
 * Obligate (og_) accounts have no local password and their MFA belongs to
 * Obligate: there is no Obligate re-authentication flow in Obliguard yet, so
 * they are exempt and every exempted action leaves an audit row.
 *
 * Wrong proofs share the per-account budget of the current-password checks
 * (currentPasswordLimiter on POST /profile/2fa/step-up): 5 / 15 min.
 */

export const STEP_UP_ACTIONS = [
  'bans.wipe',
  'ipReputation.wipe',
  'bans.liftGlobal',
  'bans.promote',
  'whitelist.global',
  'tenant.delete',
  'agents.uninstall',
  'agents.delete',
  'firewall.write',
  'appConfig.secrets',
  'users.role',
  'users.credentials',
  'keys.manage',
  'remoteBlocklists.write',
] as const;

export type StepUpAction = typeof STEP_UP_ACTIONS[number];

export function isStepUpAction(v: unknown): v is StepUpAction {
  return typeof v === 'string' && (STEP_UP_ACTIONS as readonly string[]).includes(v);
}

export type StepUpMethod = 'totp' | 'email' | 'password';

/** Lifetime of a step-up in the session. */
export const STEP_UP_TTL_MS = 10 * 60 * 1000;
/** Minimum delay between two step-up e-mail codes of one session. */
export const STEP_UP_EMAIL_COOLDOWN_MS = 30 * 1000;
/** Error code of the 401 answered while no fresh step-up exists. */
export const TWO_FACTOR_REQUIRED = 'TWO_FACTOR_REQUIRED';

declare module 'express-session' {
  interface SessionData {
    /** Epoch ms of the last successful step-up of this session. */
    stepUpAt?: number;
    stepUpMethod?: StepUpMethod;
    /** User the step-up was made for (defensive: must equal userId). */
    stepUpUserId?: number;
    /** Pending step-up e-mail code (SHA-256 only, like the sign-in codes). */
    stepUpEmailOtp?: PendingEmailOtp;
    stepUpEmailSentAt?: number;
  }
}

/** Injectable clock (the verify harness moves it to test expiry). */
export const stepUpClock = {
  now: (): number => Date.now(),
};

interface StepUpAccount {
  id: number;
  username: string;
  totp_enabled: boolean | null;
  totp_secret: string | null;
  email_otp_enabled: boolean | null;
  email: string | null;
  password_hash: string | null;
  foreign_source: string | null;
}

async function loadAccount(userId: number): Promise<StepUpAccount | undefined> {
  return db('users')
    .where({ id: userId, is_active: true })
    .first('id', 'username', 'totp_enabled', 'totp_secret', 'email_otp_enabled', 'email', 'password_hash', 'foreign_source') as
    Promise<StepUpAccount | undefined>;
}

/** Obligate accounts: sign-in and MFA live in Obligate (no local proof possible). */
function isSsoAccount(row: StepUpAccount): boolean {
  return row.foreign_source === 'obligate';
}

/**
 * Proofs this account can give. A configured second factor always wins over
 * the password (the password alone is only accepted when the account has no
 * factor at all). E-mail codes need the OTP SMTP server.
 */
async function methodsFor(row: StepUpAccount): Promise<StepUpMethod[]> {
  const methods: StepUpMethod[] = [];
  const hasTotp = !!(row.totp_enabled && row.totp_secret);
  if (hasTotp) methods.push('totp');
  if (row.email_otp_enabled) {
    const cfg = await appConfigService.getAll();
    if (cfg.otp_smtp_server_id && String(row.email ?? '').trim()) methods.push('email');
  }
  if (!hasTotp && !row.email_otp_enabled && row.password_hash) methods.push('password');
  return methods;
}

export type StepUpState =
  | { state: 'fresh'; method: StepUpMethod; expiresAt: number }
  | { state: 'exempt'; reason: 'sso' }
  | { state: 'required'; methods: StepUpMethod[] }
  | { state: 'unknown_user' };

export type StepUpVerifyInput = { method?: unknown; code?: unknown; password?: unknown };

export type StepUpOutcome =
  | { ok: true; method: StepUpMethod; expiresAt: number }
  | { ok: true; sent: true; email: string }
  | { ok: false; status: number; body: Record<string, unknown>; rejected?: boolean };

/** Masked address for the "code sent" answer (j***@example.com). */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

function fail(status: number, code: string, error: string, extra: Record<string, unknown> = {}, rejected = false): StepUpOutcome {
  return { ok: false, status, body: { success: false, error, code, ...extra }, rejected };
}

export const stepUpService = {
  /** True when the session holds a step-up younger than STEP_UP_TTL_MS for its user. */
  isFresh(req: Request): boolean {
    const s = req.session;
    if (!s?.userId || typeof s.stepUpAt !== 'number' || s.stepUpUserId !== s.userId) return false;
    const age = stepUpClock.now() - s.stepUpAt;
    // A timestamp from the future (clock moved back) is not trusted either.
    return age >= 0 && age < STEP_UP_TTL_MS;
  },

  /** Drops the session's step-up (e.g. after a factor change). */
  clear(req: Request): void {
    if (!req.session) return;
    delete req.session.stepUpAt;
    delete req.session.stepUpMethod;
    delete req.session.stepUpUserId;
    delete req.session.stepUpEmailOtp;
    delete req.session.stepUpEmailSentAt;
  },

  /** Where the session stands for a sensitive action. */
  async state(req: Request): Promise<StepUpState> {
    const userId = req.session?.userId;
    if (!userId) return { state: 'unknown_user' };
    if (this.isFresh(req)) {
      return { state: 'fresh', method: req.session.stepUpMethod ?? 'password', expiresAt: req.session.stepUpAt! + STEP_UP_TTL_MS };
    }
    const row = await loadAccount(userId);
    if (!row) return { state: 'unknown_user' };
    if (isSsoAccount(row)) return { state: 'exempt', reason: 'sso' };
    return { state: 'required', methods: await methodsFor(row) };
  },

  /** Audit row of an action let through without a step-up (Obligate account). */
  auditExemption(req: Request, action: StepUpAction): void {
    void auditService.logReq(req, {
      action: 'auth.stepUp.exempt',
      targetType: 'stepUp',
      targetId: action,
      details: { action, reason: 'sso', method: req.method, path: (req.originalUrl || req.url).split('?')[0] },
    });
  },

  /**
   * Sends a step-up e-mail code to the account's profile address. Only for
   * accounts whose step-up methods include 'email'; one code per
   * STEP_UP_EMAIL_COOLDOWN_MS per session.
   */
  async sendEmailCode(req: Request): Promise<StepUpOutcome> {
    const userId = req.session.userId!;
    const row = await loadAccount(userId);
    if (!row) return fail(401, 'UNKNOWN_USER', 'User not found');
    if (isSsoAccount(row)) return fail(400, 'STEP_UP_NOT_NEEDED', 'Obligate accounts confirm sensitive actions in Obligate');
    const methods = await methodsFor(row);
    if (!methods.includes('email')) return fail(400, 'STEP_UP_METHOD_UNAVAILABLE', 'E-mail codes are not available for this account', { methods });
    const now = stepUpClock.now();
    const sentAt = req.session.stepUpEmailSentAt;
    if (typeof sentAt === 'number' && now - sentAt >= 0 && now - sentAt < STEP_UP_EMAIL_COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil((STEP_UP_EMAIL_COOLDOWN_MS - (now - sentAt)) / 1000);
      return fail(429, 'STEP_UP_EMAIL_COOLDOWN', 'A code was just sent. Wait before asking for another one.', { retryAfterSeconds });
    }
    const cfg = await appConfigService.getAll();
    const email = String(row.email ?? '').trim();
    const { code, pending } = twoFactorService.newEmailOtp(email);
    req.session.stepUpEmailOtp = pending;
    req.session.stepUpEmailSentAt = now;
    await twoFactorService.sendEmailOtp(Number(cfg.otp_smtp_server_id), email, code);
    return { ok: true, sent: true, email: maskEmail(email) };
  },

  /**
   * Checks a proof and, when good, stamps the session (stepUpAt). Wrong
   * proofs are flagged `rejected` (the route's per-account limiter counts
   * them) and audited. Failures answer 400, never 401 (the client treats a
   * plain 401 as a lost session).
   */
  async verify(req: Request, input: StepUpVerifyInput): Promise<StepUpOutcome> {
    const userId = req.session.userId!;
    const row = await loadAccount(userId);
    if (!row) return fail(401, 'UNKNOWN_USER', 'User not found');
    if (isSsoAccount(row)) return fail(400, 'STEP_UP_NOT_NEEDED', 'Obligate accounts confirm sensitive actions in Obligate');
    const methods = await methodsFor(row);
    const method = input.method;
    if (method !== 'totp' && method !== 'email' && method !== 'password') {
      return fail(400, 'STEP_UP_METHOD_INVALID', 'method must be totp, email or password', { methods });
    }
    if (!methods.includes(method)) {
      return fail(400, 'STEP_UP_METHOD_UNAVAILABLE', 'This confirmation method is not available for this account', { methods });
    }

    let valid = false;
    if (method === 'totp') {
      const code = typeof input.code === 'string' || typeof input.code === 'number' ? String(input.code).trim() : '';
      if (!/^\d{6}$/.test(code)) return fail(400, 'STEP_UP_CODE_REQUIRED', 'Enter the 6-digit code of your authenticator app');
      const secret = twoFactorService.openTotpSecret(row.totp_secret);
      const step = secret ? twoFactorService.verifyTotpStep(secret, code, undefined, stepUpClock.now()) : null;
      if (step !== null && !(await twoFactorService.acceptTotpStep(userId, step))) {
        await this.auditResult(req, method, false, 'code_used');
        return fail(400, 'STEP_UP_CODE_USED', 'This code was already used. Wait for the next code.', {}, true);
      }
      valid = step !== null;
    } else if (method === 'email') {
      const pending = req.session.stepUpEmailOtp;
      if (!pending) return fail(400, 'STEP_UP_EMAIL_NOT_SENT', 'Ask for an e-mail code first');
      const code = typeof input.code === 'string' || typeof input.code === 'number' ? String(input.code).trim() : '';
      if (!code) return fail(400, 'STEP_UP_CODE_REQUIRED', 'Enter the code sent by e-mail');
      // The code must still go to the account's current address.
      const sameAddress = pending.email.trim().toLowerCase() === String(row.email ?? '').trim().toLowerCase();
      valid = sameAddress && twoFactorService.emailOtpMatches(pending, code);
      if (valid) {
        delete req.session.stepUpEmailOtp;
      } else {
        const attempts = (pending.attempts ?? 0) + 1;
        if (!sameAddress || attempts >= EMAIL_OTP_MAX_ATTEMPTS || Date.now() > pending.expires) delete req.session.stepUpEmailOtp;
        else req.session.stepUpEmailOtp = { ...pending, attempts };
      }
    } else {
      const password = typeof input.password === 'string' ? input.password : '';
      if (!password) return fail(400, 'STEP_UP_PASSWORD_REQUIRED', 'Enter your current password');
      valid = !!row.password_hash && await comparePassword(password, row.password_hash);
    }

    if (!valid) {
      await this.auditResult(req, method, false, 'invalid');
      return method === 'password'
        ? fail(400, 'STEP_UP_INVALID', 'Wrong password', { passwordInvalid: true }, true)
        : fail(400, 'STEP_UP_INVALID', 'Invalid code', {}, true);
    }

    const now = stepUpClock.now();
    req.session.stepUpAt = now;
    req.session.stepUpMethod = method;
    req.session.stepUpUserId = userId;
    await this.auditResult(req, method, true);
    logger.info({ userId, method }, 'Step-up confirmed');
    return { ok: true, method, expiresAt: now + STEP_UP_TTL_MS };
  },

  async auditResult(req: Request, method: StepUpMethod, success: boolean, reason?: string): Promise<void> {
    await auditService.logReq(req, {
      action: success ? 'auth.stepUp' : 'auth.stepUp.failed',
      targetType: 'stepUp',
      details: reason ? { method, reason } : { method },
      success,
    });
  },
};
