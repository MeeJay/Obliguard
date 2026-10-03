import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { config } from '../config';
import { AppError } from './errorHandler';

/** Error code of the 403 answered while a forced second factor is missing. */
export const TWO_FACTOR_SETUP_REQUIRED = 'twoFactorSetupRequired';

/**
 * True when the admin forces 2FA (app_config force_2fa) and this account has
 * no second factor yet. Obligate accounts (og_, foreign_source 'obligate')
 * are exempt: their sign-in and its MFA belong to Obligate. DISABLE_2FA_FORCE
 * (config.disable2faForce) is the operator's escape hatch.
 *
 * One query (the flag is read in the same statement), so a change of the
 * flag or of the user's factors applies to the very next request.
 */
export async function needs2faSetup(userId: number): Promise<boolean> {
  if (config.disable2faForce) return false;
  const row = await db('users')
    .where('users.id', userId)
    .first(
      'users.totp_enabled',
      'users.totp_secret',
      'users.email_otp_enabled',
      'users.foreign_source',
      db.raw(`(SELECT value FROM app_config WHERE key = 'force_2fa') AS force_2fa`),
    ) as {
      totp_enabled: boolean | null; totp_secret: string | null; email_otp_enabled: boolean | null;
      foreign_source: string | null; force_2fa: string | null;
    } | undefined;
  if (!row || row.force_2fa !== 'true') return false;
  if (row.foreign_source === 'obligate') return false;
  const hasTotp = !!(row.totp_enabled && row.totp_secret);
  return !hasTotp && !row.email_otp_enabled;
}

/**
 * Paths a user without the forced factor still reaches: sign-in / session
 * (/auth/*), the 2FA setup itself (/profile/2fa/*) and reading the profile.
 * Matched on the full /api path, so the middleware is correct wherever it is
 * mounted (today: the tenant router, which carries none of them).
 */
function isExempt(req: Request): boolean {
  const path = (req.originalUrl || req.url).split('?')[0];
  if (path.startsWith('/api/auth/') || path === '/api/auth') return true;
  if (path.startsWith('/api/profile/2fa/')) return true;
  if (req.method === 'GET' && (path === '/api/profile' || path === '/api/profile/')) return true;
  return false;
}

/**
 * Server-side force_2fa: while the account has no second factor, every API
 * behind this middleware answers 403 { code: 'twoFactorSetupRequired' }
 * (the client sends the user to /profile?setup2fa=1). Runs after requireAuth.
 */
export async function require2faSetup(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId;
  if (!userId || isExempt(req)) { next(); return; }
  try {
    if (await needs2faSetup(userId)) {
      next(new AppError(403, 'Two-factor authentication must be set up before using the application', TWO_FACTOR_SETUP_REQUIRED));
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
