import { db } from '../db';
import { randomBytes } from 'crypto';
import { hashPassword, comparePassword } from '../utils/crypto';
import type { User, UserPreferences } from '@obliview/shared';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { logger } from '../utils/logger';

/** Published fallback of DEFAULT_ADMIN_PASSWORD (config.ts). */
export const PUBLISHED_DEFAULT_ADMIN_PASSWORD = 'admin123';
export const MIN_BOOTSTRAP_ADMIN_PASSWORD_LENGTH = 12;

/** The bootstrap admin password is the published default or too short. */
export function isWeakBootstrapPassword(password: string): boolean {
  return password === PUBLISHED_DEFAULT_ADMIN_PASSWORD || password.length < MIN_BOOTSTRAP_ADMIN_PASSWORD_LENGTH;
}

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
  avatar?: string | null;
  preferred_tenant_id?: number | null;
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
    foreignSource: row.foreign_source ?? null,
    avatar: row.avatar ?? null,
    preferredTenantId: row.preferred_tenant_id ?? null,
  };
}

// Hash of a random secret, computed once: compared against when the account
// is unknown, has no local password (SSO-only) or is an Obligate account, so a
// sign-in costs one password hash in every case and neither the answer nor
// its timing tells which accounts exist or which are SSO accounts (owner
// decision: no SSO_ONLY hint, same as Obliance auth.service burnPasswordCompare).
let timingDummyHash: Promise<string> | null = null;
async function burnPasswordCompare(password: string): Promise<void> {
  try {
    if (!timingDummyHash) {
      timingDummyHash = hashPassword(randomBytes(24).toString('hex'));
    }
    await comparePassword(password, await timingDummyHash);
  } catch { /* timing only */ }
}

export const authService = {
  async authenticate(username: string, password: string): Promise<User | null> {
    const row = await db<UserRow>('users')
      .where({ username, is_active: true })
      .first();

    // Obligate-provisioned accounts (og_*) sign in through Obligate only, even
    // if a local password was ever set on them: a local password would bypass
    // Obligate's MFA/credential changes and survive the account being disabled
    // there, and a role pushed through sso-user-sync must never become usable
    // through a password session. They get the generic answer, like an unknown
    // or password-less account.
    if (!row || !row.password_hash || row.foreign_source === 'obligate') {
      await burnPasswordCompare(password);
      return null;
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

  /**
   * Creates the bootstrap admin on a database without any admin, with a
   * membership on the Default tenant. Soft warnings only, never blocks boot
   * (owner decision 16, as in Obliance index.ts ensureDefaultAdmin): a weak
   * DEFAULT_ADMIN_PASSWORD is reported at creation, and the published default
   * is reported on every boot for as long as the account still uses it.
   */
  async ensureDefaultAdmin(username: string, password: string): Promise<void> {
    const existing = await db('users').where({ role: 'admin' }).first();
    if (existing) {
      await warnIfBootstrapAdminStillDefault(username);
      return;
    }

    if (isWeakBootstrapPassword(password)) {
      logger.warn(
        { username },
        'SECURITY: the default admin is being created with a weak or published password '
        + `(DEFAULT_ADMIN_PASSWORD is "${PUBLISHED_DEFAULT_ADMIN_PASSWORD}" or shorter than ${MIN_BOOTSTRAP_ADMIN_PASSWORD_LENGTH} characters). `
        + 'Change it right after the first login, and set a strong DEFAULT_ADMIN_PASSWORD for new installs.',
      );
    }

    const user = await this.createUser(username, password, 'admin', 'Administrator');
    // Platform admins have implicit access to every tenant, but an explicit
    // Default membership keeps tenant listings and member management coherent.
    await db('user_tenants')
      .insert({ user_id: user.id, tenant_id: MASTER_TENANT_ID, role: 'admin' })
      .onConflict(['user_id', 'tenant_id'])
      .ignore();
    logger.info(`Default admin user "${username}" created`);
  },
};

/** Boot-time reminder while the bootstrap admin still logs in with the published default. */
async function warnIfBootstrapAdminStillDefault(username: string): Promise<void> {
  try {
    const row = await db<UserRow>('users').where({ username, role: 'admin', is_active: true }).first();
    if (!row?.password_hash) return;
    if (await comparePassword(PUBLISHED_DEFAULT_ADMIN_PASSWORD, row.password_hash)) {
      logger.warn(
        { username },
        `SECURITY: the admin account "${username}" still uses the published default password. Change it now.`,
      );
    }
  } catch (err) {
    // A reminder only: never block boot.
    logger.debug(err, 'Default admin password check failed');
  }
}
