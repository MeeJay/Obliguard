import type { Request, Response, NextFunction } from 'express';
import { authService, SsoOnlyError } from '../services/auth.service';
import { appConfigService } from '../services/appConfig.service';
import { twoFactorService } from '../services/twoFactor.service';
import { permissionService } from '../services/permission.service';
import { tenantService } from '../services/tenant.service';
import { AppError } from '../middleware/errorHandler';
import { canUseTenant } from '../middleware/tenant';
import { invalidateUserState } from '../middleware/sessionUserGuard';
import { obligateService } from '../services/obligate.service';
import { db } from '../db';
import { config } from '../config';
import { regenerateSession } from '../utils/regenerateSession';
import type { LoginInput } from '../validators/auth.schema';

/**
 * Helper: resolve & store the landing tenant in the session (favourite, else
 * first membership, else Default for platform admins only). A non-admin
 * without membership gets no tenant at all (no god-view fallback).
 */
async function setSessionTenant(req: Request, userId: number, role: string): Promise<void> {
  const tenantId = await tenantService.resolveLoginTenant(userId, role);
  if (tenantId !== null) req.session.currentTenantId = tenantId;
  else delete req.session.currentTenantId;
}

export const authController = {
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username, password } = req.body as LoginInput;
      let user;
      try {
        user = await authService.authenticate(username, password);
      } catch (authErr) {
        if (authErr instanceof SsoOnlyError) {
          // Return 401 with a special code so the client can show the SSO redirect hint
          res.status(401).json({
            success: false,
            error: 'Ce compte utilise la connexion SSO.',
            code: 'SSO_ONLY',
            foreignSource: authErr.foreignSource,
          });
          return;
        }
        throw authErr;
      }

      if (!user) {
        throw new AppError(401, 'Invalid username or password');
      }

      // Fresh session id before any identity is written (anti session-fixation).
      await regenerateSession(req);

      const hasMfa = user.totpEnabled || user.emailOtpEnabled;

      if (hasMfa) {
        // Step 1: store pending MFA, don't create real session yet
        req.session.pendingMfaUserId = user.id;

        // If email OTP is enabled, auto-send a code
        if (user.emailOtpEnabled && user.email) {
          const cfg = await appConfigService.getAll();
          if (cfg.otp_smtp_server_id) {
            const code = twoFactorService.generateEmailOtp();
            req.session.pendingEmailOtp = { code, email: user.email, expires: Date.now() + 10 * 60 * 1000 };
            await twoFactorService.sendEmailOtp(cfg.otp_smtp_server_id, user.email, code);
          }
        }

        res.json({
          success: true,
          data: {
            requires2fa: true,
            methods: { totp: user.totpEnabled ?? false, email: user.emailOtpEnabled ?? false },
          },
        });
        return;
      }

      // No 2FA — complete session immediately
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      await setSessionTenant(req, user.id, user.role);

      res.json({ success: true, data: { user } });
    } catch (err) {
      next(err);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      req.session.destroy((err) => {
        if (err) {
          next(new AppError(500, 'Failed to logout'));
          return;
        }
        res.clearCookie('connect.sid');
        res.json({ success: true, message: 'Logged out' });
      });
    } catch (err) {
      next(err);
    }
  },

  async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;

      // Sync preferences from Obligate for SSO users (throttled 60s — await so /me returns fresh prefs)
      const fRow = await db('users').where({ id: userId }).select('foreign_source', 'foreign_id').first() as
        { foreign_source: string | null; foreign_id: number | null } | undefined;
      if (fRow?.foreign_source === 'obligate' && fRow.foreign_id) {
        await obligateService.syncUserPreferences(userId, fRow.foreign_id).catch(() => {});
      }

      const user = await authService.getUserById(userId);
      if (!user) {
        throw new AppError(401, 'User not found');
      }

      // Align the session role with the DB so requireTenant (session role) and this
      // check (DB role) agree; otherwise a promotion could make /me say 'ok' while
      // requireTenant still 403s for up to the guard's 5 s cache.
      if (req.session.role !== user.role) { req.session.role = user.role; invalidateUserState(user.id); }
      // The only tenant repair point: re-validate the session tenant, re-resolve
      // it when unusable (no Default fallback for non-admins).
      const current = req.session.currentTenantId;
      if (current != null && !(await canUseTenant(user.id, user.role, current))) delete req.session.currentTenantId;
      if (req.session.currentTenantId == null) await setSessionTenant(req, user.id, user.role);
      const tenantId = req.session.currentTenantId ?? null;
      const preferredTenantId = await tenantService.getPreferredTenant(user.id);

      const isAdmin = user.role === 'admin';
      const permissions = await permissionService.getUserPermissions(user.id, isAdmin, tenantId ?? undefined);

      // Check if force 2FA applies to this user
      let requires2faSetup = false;
      if (!config.disable2faForce) {
        const cfg = await appConfigService.getAll();
        if (cfg.force_2fa && !user.totpEnabled && !user.emailOtpEnabled) {
          requires2faSetup = true;
        }
      }

      res.json({
        success: true,
        data: {
          user,
          permissions,
          requires2faSetup,
          currentTenantId: tenantId,
          noTenantAccess: tenantId === null,
          preferredTenantId,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  async permissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const permissions = await permissionService.getUserPermissions(req.session.userId!, isAdmin, req.session.currentTenantId);
      res.json({ success: true, data: permissions });
    } catch (err) {
      next(err);
    }
  },
};
