import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { comparePassword, hashPassword } from '../utils/crypto';
import { AppError } from '../middleware/errorHandler';
import type { UpdateProfileInput, ChangePasswordInput } from '../validators/profile.schema';

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

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as UpdateProfileInput;

      const updatePayload: Record<string, unknown> = { updated_at: new Date() };

      if ('displayName' in data) updatePayload.display_name = data.displayName;
      if ('preferences' in data) {
        updatePayload.preferences = data.preferences !== undefined ? JSON.stringify(data.preferences) : null;
      }
      if ('email' in data) updatePayload.email = data.email || null;
      if ('preferredLanguage' in data) updatePayload.preferred_language = data.preferredLanguage;

      if ('email' in data) {
        const current = await db('users').select('email', 'email_otp_enabled', 'foreign_source').where({ id: req.session.userId }).first();
        const nextEmail = data.email || null;
        // Obligate-provisioned accounts: the address is owned by Obligate and
        // re-synced at every SSO sign-in. A local change would let a stolen
        // session cookie redirect account mail (OTP codes, notifications).
        if (current?.foreign_source === 'obligate' && (current.email || null) !== nextEmail) {
          throw new AppError(400, 'The email of an Obligate account is managed in Obligate');
        }
        // If email changes and email OTP is enabled, disable it for security
        if (data.email && current?.email_otp_enabled && current.email !== data.email) {
          updatePayload.email_otp_enabled = false;
        }
      }

      const [row] = await db('users')
        .where({ id: req.session.userId })
        .update(updatePayload)
        .returning(['id', 'username', 'display_name', 'role', 'is_active', 'created_at', 'updated_at', 'preferences', 'email', 'preferred_language', 'enrollment_version', 'avatar']);

      if (!row) throw new AppError(404, 'User not found');

      res.json({ success: true, data: buildUserResponse(row) });
    } catch (err) {
      next(err);
    }
  },

  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { currentPassword, newPassword } = req.body as ChangePasswordInput;

      const user = await db('users').select('password_hash', 'foreign_source').where({ id: req.session.userId }).first();
      if (!user) throw new AppError(404, 'User not found');
      // Obligate accounts have no usable local password (they sign in through Obligate).
      if (user.foreign_source === 'obligate' || !user.password_hash) {
        throw new AppError(400, 'This account signs in through Obligate — change the password in Obligate');
      }

      const valid = await comparePassword(currentPassword, user.password_hash);
      if (!valid) throw new AppError(400, 'Current password is incorrect');

      const newHash = await hashPassword(newPassword);
      await db('users').where({ id: req.session.userId }).update({ password_hash: newHash, updated_at: new Date() });

      res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
      next(err);
    }
  },
};
