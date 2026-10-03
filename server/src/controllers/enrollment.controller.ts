import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { z } from 'zod';
import { APP_THEME_IDS } from '../validators/profile.schema';
import { mergePreferences, normEmail } from './profile.controller';
import { auditService } from '../services/audit.service';

// Must match REQUIRED_ENROLLMENT_VERSION in client/src/components/layout/ProtectedRoute.tsx
export const REQUIRED_ENROLLMENT_VERSION = 2;

const enrollmentSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  // Required for a local account without an address; ignored otherwise
  // (Obligate accounts, or an address already on file). An empty string (the
  // wizard of an account without an address that skips the profile step) is
  // "no address", not an invalid one.
  email: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().email().max(255).nullable().optional()),
  preferredLanguage: z.string().max(10).default('en'),
  toastEnabled: z.boolean().default(true),
  toastPosition: z.enum(['top-center', 'bottom-right']).default('bottom-right'),
  preferredTheme: z.enum(APP_THEME_IDS).default('obli-operator'),
});

export const enrollmentController = {
  async complete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const parsed = enrollmentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid input');
      }

      const { displayName, email, preferredLanguage, toastEnabled, toastPosition, preferredTheme } = parsed.data;

      const currentUser = await db('users')
        .where({ id: userId })
        .select('foreign_source', 'email', 'enrollment_version')
        .first() as { foreign_source: string | null; email: string | null; enrollment_version: number | null } | undefined;
      if (!currentUser) throw new AppError(404, 'User not found');

      // The wizard runs once. Re-running it would let a session alone rewrite
      // the profile (and, before, the e-mail address): profile changes go
      // through PUT /profile, which re-authenticates recovery changes.
      if ((currentUser.enrollment_version ?? 0) >= REQUIRED_ENROLLMENT_VERSION) {
        throw new AppError(409, 'Enrollment is already completed');
      }

      // The email of an Obligate account is owned by Obligate (re-synced at
      // every SSO sign-in), and an address already on file is a recovery
      // channel that only PUT /profile may change (with the current
      // password): in both cases the stored one is kept.
      const isObligateAccount = currentUser.foreign_source === 'obligate';
      const keepStoredEmail = isObligateAccount || !!currentUser.email;
      let nextEmail: string | null = null;
      if (!keepStoredEmail) {
        nextEmail = email ? email.trim() : null;
        if (!nextEmail) throw new AppError(400, 'An email address is required');
        const existing = await db('users')
          .whereRaw('lower(email) = ?', [normEmail(nextEmail)])
          .whereNot({ id: userId })
          .first('id');
        if (existing) {
          throw new AppError(409, 'This email address is already in use');
        }
      }

      // Merged into the stored preferences (NetMap tabs, SSO-synced keys…).
      const preferences = await mergePreferences(userId, { toastEnabled, toastPosition, preferredTheme });

      // Conditional on the version: a concurrent second submit gets the 409.
      const [row] = await db('users')
        .where({ id: userId })
        .andWhere((q) => { q.whereNull('enrollment_version').orWhere('enrollment_version', '<', REQUIRED_ENROLLMENT_VERSION); })
        .update({
          display_name: displayName !== undefined ? displayName : db.raw('display_name'),
          email: keepStoredEmail ? db.raw('email') : nextEmail,
          preferred_language: preferredLanguage,
          preferences,
          enrollment_version: REQUIRED_ENROLLMENT_VERSION,
          updated_at: new Date(),
        })
        .returning(['id', 'username', 'display_name', 'role', 'is_active', 'created_at', 'updated_at', 'preferences', 'email', 'preferred_language', 'enrollment_version']);

      if (!row) throw new AppError(409, 'Enrollment is already completed');

      await auditService.logReq(req, {
        action: 'auth.enrollment_completed',
        targetType: 'user',
        targetId: row.id,
        details: { emailSet: nextEmail !== null, language: preferredLanguage },
      });

      res.json({
        success: true,
        data: {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          role: row.role,
          isActive: row.is_active,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          preferences: row.preferences ?? null,
          email: row.email,
          preferredLanguage: row.preferred_language,
          enrollmentVersion: row.enrollment_version,
        },
      });
    } catch (err) {
      next(err);
    }
  },
};
