import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { foreignSsoService, AccountLinkRequiredError, mapUser } from '../services/foreignSso.service';
import { appConfigService } from '../services/appConfig.service';
import { tenantService } from '../services/tenant.service';
import { twoFactorService } from '../services/twoFactor.service';
import { AppError } from '../middleware/errorHandler';
import { comparePassword } from '../utils/crypto';
import { db } from '../db';

export async function requireObliviewSecret(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new AppError(401, 'Missing Bearer token');
    }
    const provided = authHeader.slice(7).trim();
    const { apiKey } = await appConfigService.getObliviewRaw();
    if (!apiKey || provided !== apiKey) {
      throw new AppError(401, 'Invalid secret');
    }
    next();
  } catch (err) {
    next(err);
  }
}

async function setSessionTenant(req: Request, userId: number): Promise<void> {
  const tenant = await tenantService.getFirstTenantForUser(userId);
  req.session.currentTenantId = tenant?.id ?? 1;
}

export const foreignSsoController = {
  async generateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getAll();
      if (!cfg.enable_foreign_sso) throw new AppError(403, 'Foreign SSO is not enabled');
      const token = await foreignSsoService.generateSwitchToken(req.session.userId!);
      res.json({ success: true, data: { token, expiresInSeconds: 60 } });
    } catch (err) { next(err); }
  },

  async validateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const token = (req.query.token as string | undefined)?.trim();
      if (!token) throw new AppError(400, 'Missing token parameter');
      const user = await foreignSsoService.validateSwitchToken(token);
      if (!user) throw new AppError(404, 'Token not found, expired, or already used');
      res.json({ success: true, data: { user } });
    } catch (err) { next(err); }
  },

  async listUsers(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const users = await foreignSsoService.listUsers();
      res.json({ success: true, data: users });
    } catch (err) { next(err); }
  },

  async exchange(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getAll();
      if (!cfg.enable_foreign_sso) throw new AppError(403, 'Foreign SSO is not enabled');
      const { token, from, foreignSource = 'obliview' } = req.body as {
        token?: string; from?: string; foreignSource?: string;
      };
      if (!token || !from) throw new AppError(400, 'Missing required fields: token, from');
      const { apiKey: sharedSecret } = await appConfigService.getObliviewRaw();
      if (!sharedSecret) throw new AppError(503, 'Obliguard shared secret is not configured');
      const fromBase = from.replace(/\/$/, '');
      const validateUrl = fromBase + '/api/sso/validate-token?token=' + encodeURIComponent(token);
      let foreignUser: { id: number; username: string; displayName: string | null; role: string; email: string | null };
      try {
        const resp = await fetch(validateUrl, {
          headers: { Authorization: 'Bearer ' + sharedSecret },
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) throw new AppError(401, 'Token rejected by foreign platform');
        const body = await resp.json() as { success: boolean; data?: { user: typeof foreignUser } };
        if (!body.success || !body.data?.user) throw new AppError(401, 'Invalid response from foreign platform');
        foreignUser = body.data.user;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(502, 'Could not reach foreign platform to validate token');
      }
      let localUser: Awaited<ReturnType<typeof foreignSsoService.findOrCreateForeignUser>>;
      try {
        localUser = await foreignSsoService.findOrCreateForeignUser({
          foreignSource,
          foreignId: foreignUser.id,
          foreignSourceUrl: fromBase,
          username: foreignUser.username,
          displayName: foreignUser.displayName,
          role: foreignUser.role,
          email: foreignUser.email,
        });
      } catch (findErr) {
        if (findErr instanceof AccountLinkRequiredError) {
          // Username belongs to an existing local account — issue a link token.
          const linkToken = crypto.randomBytes(32).toString('hex');
          await db('sso_link_tokens').insert({
            link_token: linkToken,
            foreign_source: foreignSource,
            foreign_id: foreignUser.id,
            foreign_source_url: fromBase,
            foreign_username: foreignUser.username,
            foreign_display_name: foreignUser.displayName ?? null,
            foreign_role: foreignUser.role,
            foreign_email: foreignUser.email ?? null,
            conflicting_username: findErr.conflictingUsername,
            expires_at: new Date(Date.now() + 5 * 60_000),
          });
          res.json({ success: true, data: { needsLinking: true, linkToken, conflictingUsername: findErr.conflictingUsername } });
          return;
        }
        throw findErr;
      }
      req.session.userId = localUser.id;
      req.session.username = localUser.username;
      req.session.role = localUser.role;
      await setSessionTenant(req, localUser.id);
      res.json({ success: true, data: { user: localUser, isFirstLogin: localUser.isFirstLogin } });
    } catch (err) { next(err); }
  },

  async completeLink(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { linkToken, password } = req.body as { linkToken?: string; password?: string };
      if (!linkToken || !password) throw new AppError(400, 'linkToken and password are required');

      const linkRow = await db('sso_link_tokens')
        .where({ link_token: linkToken })
        .where('expires_at', '>', new Date())
        .first() as {
          foreign_source: string; foreign_id: number; foreign_source_url: string;
          conflicting_username: string;
        } | undefined;
      if (!linkRow) throw new AppError(401, 'Link token expired or invalid');

      const localUser = await db('users')
        .where({ username: linkRow.conflicting_username, is_active: true })
        .first() as {
          id: number; username: string; role: string; password_hash: string | null;
          totp_enabled: boolean | null; email_otp_enabled: boolean | null; email: string | null;
        } | undefined;
      if (!localUser || !localUser.password_hash) throw new AppError(404, 'Local account not found');

      const valid = await comparePassword(password, localUser.password_hash);
      if (!valid) throw new AppError(401, 'Incorrect password');

      // If the local account has 2FA, require it before completing the link
      const hasMfa = localUser.totp_enabled || localUser.email_otp_enabled;
      if (hasMfa) {
        req.session.pendingMfaLinkToken = linkToken;

        // Auto-send email OTP if configured
        if (localUser.email_otp_enabled && localUser.email) {
          const cfg = await appConfigService.getAll();
          if (cfg.otp_smtp_server_id) {
            const code = twoFactorService.generateEmailOtp();
            req.session.pendingEmailOtp = { code, email: localUser.email, expires: Date.now() + 10 * 60 * 1000 };
            await twoFactorService.sendEmailOtp(cfg.otp_smtp_server_id, localUser.email, code);
          }
        }

        res.json({
          success: true,
          data: {
            requires2fa: true,
            methods: { totp: !!localUser.totp_enabled, email: !!localUser.email_otp_enabled },
          },
        });
        return;
      }

      // No 2FA — complete the link immediately
      await db('users').where({ id: localUser.id }).update({
        foreign_source: linkRow.foreign_source,
        foreign_id: linkRow.foreign_id,
        foreign_source_url: linkRow.foreign_source_url,
        updated_at: new Date(),
      });
      await db('sso_link_tokens').where({ link_token: linkToken }).delete();

      req.session.userId = localUser.id;
      req.session.username = localUser.username;
      req.session.role = localUser.role;
      await setSessionTenant(req, localUser.id);

      const updatedRow = await db('users').where({ id: localUser.id }).first();
      res.json({ success: true, data: { user: mapUser(updatedRow as Record<string, unknown>), isFirstLogin: false } });
    } catch (err) { next(err); }
  },

  async verifyLinkMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code, method, resend } = req.body as { code?: string; method?: string; resend?: boolean };

      const linkToken = req.session.pendingMfaLinkToken;
      if (!linkToken) throw new AppError(400, 'No pending 2FA link session');

      const linkRow = await db('sso_link_tokens')
        .where({ link_token: linkToken })
        .where('expires_at', '>', new Date())
        .first() as {
          foreign_source: string; foreign_id: number; foreign_source_url: string;
          conflicting_username: string;
        } | undefined;
      if (!linkRow) throw new AppError(401, 'Link session expired, please start over');

      const localUser = await db('users')
        .where({ username: linkRow.conflicting_username, is_active: true })
        .first() as {
          id: number; username: string; role: string;
          totp_enabled: boolean | null; totp_secret: string | null;
          email_otp_enabled: boolean | null; email: string | null;
        } | undefined;
      if (!localUser) throw new AppError(404, 'Local account not found');

      // Resend email OTP
      if (resend) {
        if (!localUser.email_otp_enabled || !localUser.email) throw new AppError(400, 'Email OTP not configured for this account');
        const cfg = await appConfigService.getAll();
        if (!cfg.otp_smtp_server_id) throw new AppError(400, 'No SMTP server configured for OTP');
        const newCode = twoFactorService.generateEmailOtp();
        req.session.pendingEmailOtp = { code: newCode, email: localUser.email, expires: Date.now() + 10 * 60 * 1000 };
        await twoFactorService.sendEmailOtp(cfg.otp_smtp_server_id, localUser.email, newCode);
        res.json({ success: true });
        return;
      }

      if (!code || !method) throw new AppError(400, 'code and method are required');

      let valid = false;
      if (method === 'totp' && localUser.totp_enabled && localUser.totp_secret) {
        valid = twoFactorService.verifyTotp(localUser.totp_secret, String(code));
      } else if (method === 'email' && localUser.email_otp_enabled) {
        const pending = req.session.pendingEmailOtp;
        if (pending && Date.now() <= pending.expires && pending.code === String(code)) {
          valid = true;
        }
      }
      if (!valid) throw new AppError(401, 'Invalid code');

      // Complete the link
      await db('users').where({ id: localUser.id }).update({
        foreign_source: linkRow.foreign_source,
        foreign_id: linkRow.foreign_id,
        foreign_source_url: linkRow.foreign_source_url,
        updated_at: new Date(),
      });
      await db('sso_link_tokens').where({ link_token: linkToken }).delete();

      delete req.session.pendingMfaLinkToken;
      delete req.session.pendingEmailOtp;

      req.session.userId = localUser.id;
      req.session.username = localUser.username;
      req.session.role = localUser.role;
      await setSessionTenant(req, localUser.id);

      const updatedRow = await db('users').where({ id: localUser.id }).first();
      res.json({ success: true, data: { user: mapUser(updatedRow as Record<string, unknown>), isFirstLogin: false } });
    } catch (err) { next(err); }
  },

  async setPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { password } = req.body as { password?: string };
      if (!password || password.length < 8) throw new AppError(400, 'Password must be at least 8 characters');
      await foreignSsoService.setLocalPassword(req.session.userId!, password);
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
