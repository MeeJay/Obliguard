import type { Request, Response, NextFunction } from 'express';
import nodemailer from 'nodemailer';
import { db } from '../db';
import { config } from '../config';
import { comparePassword, hashPassword } from '../utils/crypto';
import { regenerateSession } from '../utils/regenerateSession';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { appConfigService } from '../services/appConfig.service';
import { smtpServerService } from '../services/smtpServer.service';
import { userSessionsService } from '../services/userSessions.service';
import { auditService } from '../services/audit.service';
import type { UpdateProfileInput, ChangePasswordInput } from '../validators/profile.schema';

/** Cap of the stored preferences JSON (Obliance profileWrite.service). */
export const MAX_PREFERENCES_BYTES = 100_000;

const PROFILE_COLUMNS = ['id', 'username', 'display_name', 'role', 'is_active', 'created_at', 'updated_at', 'preferences', 'email', 'preferred_language', 'enrollment_version', 'avatar'] as const;

export const normEmail = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function buildUserResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preferences: row.preferences ?? null,
    email: row.email ?? null,
    preferredLanguage: row.preferred_language ?? 'en',
    enrollmentVersion: row.enrollment_version ?? 0,
    hasPassword: !!row.password_hash,
    avatar: row.avatar ?? null,
  };
}

/** Copy of a plain object without the prototype-mutating keys. */
function sanitisePreferences(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Merges a (validated) preferences patch into the stored preferences of a
 * user and returns the JSON to write (port of Obliance profileWrite.service):
 * a partial write — the NetMap tabs, the toast settings, the theme — never
 * wipes the other keys. Throws 400 above MAX_PREFERENCES_BYTES.
 */
export async function mergePreferences(userId: number, patch: Record<string, unknown>): Promise<string> {
  const currentRow = await db('users').select('preferences').where({ id: userId }).first() as { preferences: unknown } | undefined;
  let existing: unknown = currentRow?.preferences ?? {};
  if (typeof existing === 'string') {
    try { existing = JSON.parse(existing); } catch { existing = {}; }
  }
  const merged = { ...sanitisePreferences(existing), ...sanitisePreferences(patch) };
  const json = JSON.stringify(merged);
  if (json.length > MAX_PREFERENCES_BYTES) {
    throw new AppError(400, 'Preferences payload exceeds 100 KB limit');
  }
  return json;
}

/**
 * Security notice to the PREVIOUS address of an account whose e-mail was
 * changed (best effort, only when the OTP SMTP server is configured: it is
 * the one password-reset links use).
 */
function notifyEmailChanged(oldEmail: string, username: string): void {
  void (async () => {
    try {
      const cfg = await appConfigService.getAll();
      if (!cfg.otp_smtp_server_id) return;
      const smtp = await smtpServerService.getTransportConfig(cfg.otp_smtp_server_id);
      if (!smtp) return;
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.username, pass: smtp.password },
      });
      await transport.sendMail({
        from: smtp.fromAddress,
        to: oldEmail,
        subject: `${config.appName} — The e-mail address of your account was changed`,
        text: `The e-mail address of your ${config.appName} account "${username}" was just changed. `
          + 'Password-reset links and security codes now go to the new address.\n\n'
          + 'If this was not you, contact an administrator now and change your password.',
      });
    } catch (err) {
      // A notice never breaks the change.
      logger.warn({ err }, 'Failed to send the e-mail change notice to the previous address');
    }
  })();
}

/**
 * Issues a fresh session id for the signed-in user, keeping its identity
 * (user, role, tenant) and dropping pending login state. Used after a
 * password change so a copied session cookie stops working.
 */
async function regenerateKeepingIdentity(req: Request): Promise<void> {
  const keep: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.session as unknown as Record<string, unknown>)) {
    if (k === 'cookie' || k.startsWith('pending')) continue;
    keep[k] = v;
  }
  await regenerateSession(req);
  Object.assign(req.session, keep);
}

export const profileController = {
  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const row = await db('users')
        .select('id', 'username', 'display_name', 'role', 'is_active', 'created_at', 'updated_at', 'preferences', 'email', 'preferred_language', 'enrollment_version', 'password_hash', 'avatar')
        .where({ id: req.session.userId })
        .first();

      if (!row) throw new AppError(404, 'User not found');

      res.json({ success: true, data: buildUserResponse(row) });
    } catch (err) {
      next(err);
    }
  },

  // PUT (and PATCH) /api/profile — partial update; preferences are merged.
  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const data = req.body as UpdateProfileInput;

      const current = await db('users')
        .select('username', 'email', 'password_hash', 'foreign_source')
        .where({ id: userId })
        .first() as { username: string; email: string | null; password_hash: string | null; foreign_source: string | null } | undefined;
      if (!current) throw new AppError(404, 'User not found');

      const updatePayload: Record<string, unknown> = { updated_at: new Date() };

      if ('displayName' in data) updatePayload.display_name = data.displayName;
      if ('preferredLanguage' in data) updatePayload.preferred_language = data.preferredLanguage;
      if ('preferences' in data) {
        updatePayload.preferences = data.preferences == null
          ? null
          : await mergePreferences(userId, data.preferences as Record<string, unknown>);
      }

      // The address is a recovery channel (password-reset links, e-mail OTP
      // codes): changing it needs the current password, so a stolen session
      // cookie cannot redirect them. Re-sending the stored address (the
      // profile form always posts it) is not a change.
      let previousEmail: string | null = null;
      if ('email' in data) {
        const nextEmail = data.email ? data.email.trim() : null;
        if (normEmail(nextEmail) !== normEmail(current.email)) {
          // Obligate-provisioned accounts: the address is owned by Obligate and
          // re-synced at every SSO sign-in.
          if (current.foreign_source === 'obligate') {
            throw new AppError(400, 'The email of an Obligate account is managed in Obligate');
          }
          if (!current.password_hash) {
            throw new AppError(400, 'This account has no local password: its email address cannot be changed here');
          }
          if (!data.currentPassword) {
            throw new AppError(400, 'The current password is required to change the email address');
          }
          if (!(await comparePassword(data.currentPassword, current.password_hash))) {
            res.locals.currentPasswordRejected = true; // counted by currentPasswordLimiter
            await auditService.logReq(req, { action: 'profile.email_changed', targetType: 'user', targetId: userId, success: false, details: { reason: 'wrong_current_password' } });
            throw new AppError(400, 'Current password is incorrect');
          }
          if (nextEmail) {
            const taken = await db('users')
              .whereRaw('lower(email) = ?', [normEmail(nextEmail)])
              .whereNot({ id: userId })
              .first('id');
            if (taken) throw new AppError(409, 'This email address is already in use');
          }
          // email_otp_enabled is kept: the change was re-authenticated, and
          // the codes follow the account to its new address.
          updatePayload.email = nextEmail;
          previousEmail = current.email;
        }
      }

      const [row] = await db('users')
        .where({ id: userId })
        .update(updatePayload)
        .returning([...PROFILE_COLUMNS]);

      if (!row) throw new AppError(404, 'User not found');

      if ('email' in updatePayload) {
        logger.info({ userId }, 'Profile: email address changed');
        await auditService.logReq(req, {
          action: 'profile.email_changed', targetType: 'user', targetId: userId,
          details: { previousEmail: previousEmail ?? null, newEmail: updatePayload.email ?? null },
        });
        if (previousEmail) notifyEmailChanged(previousEmail, current.username);
      }

      res.json({ success: true, data: buildUserResponse(row) });
    } catch (err) {
      next(err);
    }
  },

  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const { currentPassword, newPassword } = req.body as ChangePasswordInput;

      const user = await db('users').select('password_hash', 'foreign_source').where({ id: userId }).first();
      if (!user) throw new AppError(404, 'User not found');
      // Obligate accounts have no usable local password (they sign in through Obligate).
      if (user.foreign_source === 'obligate' || !user.password_hash) {
        throw new AppError(400, 'This account signs in through Obligate — change the password in Obligate');
      }

      const valid = await comparePassword(currentPassword, user.password_hash);
      if (!valid) {
        res.locals.currentPasswordRejected = true; // counted by currentPasswordLimiter
        await auditService.logReq(req, { action: 'profile.password_changed', targetType: 'user', targetId: userId, success: false, details: { reason: 'wrong_current_password' } });
        throw new AppError(400, 'Current password is incorrect');
      }

      const newHash = await hashPassword(newPassword);
      await db('users').where({ id: userId }).update({ password_hash: newHash, updated_at: new Date() });

      // A changed password signs out every other session of the account (a
      // stolen cookie dies with the old password); this one continues on a
      // fresh session id.
      await regenerateKeepingIdentity(req);
      const revoked = await userSessionsService.destroyForUser(userId, { exceptSid: req.sessionID });
      logger.info({ userId, revokedSessions: revoked }, 'Profile: password changed, other sessions revoked');
      await auditService.logReq(req, { action: 'profile.password_changed', targetType: 'user', targetId: userId, details: { revokedSessions: revoked } });

      res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
      next(err);
    }
  },
};
