import { db } from '../db';
import { hashPassword, comparePassword } from '../utils/crypto';
import type { User, UserPreferences } from '@obliview/shared';
import { logger } from '../utils/logger';

interface UserRow {
  id: number;
  username: string;
  password_hash: string | null;
  display_name: string | null;
  role: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  preferences?: UserPreferences | null;
  email?: string | null;
  preferred_language?: string;
  enrollment_version?: number;
  totp_enabled?: boolean;
  email_otp_enabled?: boolean;
  foreign_source?: string | null;
  foreign_id?: number | null;
  foreign_source_url?: string | null;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as User['role'],
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    preferences: row.preferences ?? null,
    email: row.email ?? null,
    preferredLanguage: row.preferred_language ?? 'en',
    enrollmentVersion: row.enrollment_version ?? 0,
    totpEnabled: row.totp_enabled ?? false,
    emailOtpEnabled: row.email_otp_enabled ?? false,
  };
}

/** Returned when a user exists but has no local password (SSO-only account). */
export class SsoOnlyError extends Error {
  constructor(public readonly foreignSource: string) {
    super('SSO_ONLY');
    this.name = 'SsoOnlyError';
  }
}

export const authService = {
  async authenticate(username: string, password: string): Promise<User | null> {
    const row = await db<UserRow>('users')
      .where({ username, is_active: true })
      .first();

    if (!row) return null;

    // Foreign (SSO-only) users have no local password — reject with specific error
    if (!row.password_hash) {
      throw new SsoOnlyError(row.foreign_source ?? 'obliview');
    }

    const valid = await comparePassword(password, row.password_hash);
    if (!valid) return null;

    return rowToUser(row);
  },

  async getUserById(id: number): Promise<User | null> {
    const row = await db<UserRow>('users').where({ id }).first();
    if (!row) return null;
    return rowToUser(row);
  },

  async createUser(
    username: string,
    password: string,
    role: string = 'user',
    displayName?: string,
  ): Promise<User> {
    const passwordHash = await hashPassword(password);

    const [row] = await db<UserRow>('users')
      .insert({
        username,
        password_hash: passwordHash,
        display_name: displayName || null,
        role,
      })
      .returning('*');

    return rowToUser(row);
  },

  async ensureDefaultAdmin(username: string, password: string): Promise<void> {
    const existing = await db('users').where({ role: 'admin' }).first();
    if (existing) return;

    await this.createUser(username, password, 'admin', 'Administrator');
    logger.info(`Default admin user "${username}" created`);
  },
};
