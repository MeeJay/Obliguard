import crypto from 'node:crypto';
import { db } from '../db';
import { hashPassword } from '../utils/crypto';

/** Thrown by findOrCreateForeignUser when the incoming username matches an existing local account. */
export class AccountLinkRequiredError extends Error {
  constructor(public readonly conflictingUsername: string) {
    super('account_link_required');
  }
}
import type { User } from '@obliview/shared';

/** Internal DB row shape for switch_tokens */
interface SwitchTokenRow {
  id: number;
  user_id: number;
  token: string;
  expires_at: Date;
  used: boolean;
  created_at: Date;
}

/** Shape returned to Obliview when it validates a token */
export interface ForeignUserInfo {
  id: number;
  username: string;
  displayName: string | null;
  role: string;
  email: string | null;
}

export const foreignSsoService = {
  /**
   * Generate a one-time switch token for the given user.
   * TTL: 60 seconds. Single-use.
   */
  async generateSwitchToken(userId: number): Promise<string> {
    const token = crypto.randomBytes(48).toString('hex'); // 96 hex chars
    const expiresAt = new Date(Date.now() + 60_000); // 60 seconds

    await db('switch_tokens').insert({
      user_id: userId,
      token,
      expires_at: expiresAt,
      used: false,
    });

    // Clean up expired tokens opportunistically
    await db('switch_tokens').where('expires_at', '<', new Date()).delete();

    return token;
  },

  /**
   * Validate a switch token and return the associated user.
   * Marks the token as used after first validation.
   * Returns null if token is invalid, expired, or already used.
   */
  async validateSwitchToken(token: string): Promise<ForeignUserInfo | null> {
    const row = await db<SwitchTokenRow>('switch_tokens')
      .where({ token })
      .first();

    if (!row) return null;
    if (row.used) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    // Mark as used
    await db('switch_tokens').where({ id: row.id }).update({ used: true });

    // Fetch the user
    const user = await db('users')
      .where({ id: row.user_id })
      .first('id', 'username', 'display_name', 'role', 'email');

    if (!user) return null;

    return {
      id: user.id as number,
      username: user.username as string,
      displayName: (user.display_name as string | null) ?? null,
      role: user.role as string,
      email: (user.email as string | null) ?? null,
    };
  },

  /**
   * Return a list of all active local users.
   * Used by the foreign platform to list available users for linking.
   */
  async listUsers(): Promise<ForeignUserInfo[]> {
    const rows = await db('users')
      .where({ is_active: true })
      .select('id', 'username', 'display_name', 'role', 'email');

    return rows.map((r: { id: number; username: string; display_name: string | null; role: string; email: string | null }) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name ?? null,
      role: r.role,
      email: r.email ?? null,
    }));
  },

  /**
   * Find or create a local user for the given foreign identity.
   * - If a user with (foreign_source, foreign_id) already exists → return them.
   * - Otherwise create a new user with no password (SSO-only account).
   * Returns the local user + isFirstLogin flag.
   */
  async findOrCreateForeignUser(opts: {
    foreignSource: string;
    foreignId: number;
    foreignSourceUrl: string;
    username: string;
    displayName: string | null;
    role: string;
    email: string | null;
  }): Promise<User & { isFirstLogin: boolean }> {
    const { foreignSource, foreignId, foreignSourceUrl, username, displayName, role, email } = opts;

    // Look up via sso_foreign_users — supports multiple linked sources per user
    const link = await db('sso_foreign_users')
      .where({ foreign_source: foreignSource, foreign_user_id: foreignId })
      .first() as { local_user_id: number } | undefined;

    if (link) {
      const existing = await db('users').where({ id: link.local_user_id }).first();
      if (existing) {
        // Update mutable fields in case they changed on the remote side
        await db('users')
          .where({ id: existing.id as number })
          .update({
            username,
            display_name: displayName,
            email,
            foreign_source_url: foreignSourceUrl,
            updated_at: new Date(),
          });

        const updated = await db('users').where({ id: existing.id as number }).first();
        return { ...mapUser(updated), isFirstLogin: false };
      }
    }

    // Check for username collision with any existing account.
    const anyCollision = await db('users')
      .where({ username })
      .first() as Record<string, unknown> | undefined;

    if (anyCollision) {
      if (!anyCollision.password_hash) {
        // The existing account is a password-less SSO account (created via another source).
        // Auto-link this new source — no password proof needed since the account has no secret.
        const colId = anyCollision.id as number;
        await db('sso_foreign_users')
          .insert({ foreign_source: foreignSource, foreign_user_id: foreignId, local_user_id: colId })
          .onConflict(['foreign_source', 'foreign_user_id'])
          .merge({ local_user_id: colId });
        await db('users').where({ id: colId }).update({
          email,
          foreign_source_url: foreignSourceUrl,
          updated_at: new Date(),
        });
        const updated = await db('users').where({ id: colId }).first();
        return { ...mapUser(updated), isFirstLogin: false };
      }
      // The existing account has a password (local account) — require ownership proof.
      throw new AccountLinkRequiredError(username);
    }

    // Create new foreign user (no password)
    const [newId] = await db('users').insert({
      username,
      display_name: displayName,
      password_hash: null,
      role: role === 'admin' ? 'admin' : 'user',
      email,
      is_active: true,
      foreign_source: foreignSource,
      foreign_id: foreignId,
      foreign_source_url: foreignSourceUrl,
      preferred_language: 'en',
      enrollment_version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');

    const id = typeof newId === 'object' ? (newId as { id: number }).id : newId;

    // Record in sso_foreign_users for future multi-source lookups
    await db('sso_foreign_users').insert({
      foreign_source: foreignSource,
      foreign_user_id: foreignId,
      local_user_id: id,
    });

    // Assign to default tenant
    await db('tenant_memberships')
      .insert({ tenant_id: 1, user_id: id, role: 'member' })
      .onConflict(['tenant_id', 'user_id'])
      .ignore();

    const created = await db('users').where({ id }).first();
    return { ...mapUser(created), isFirstLogin: true };
  },

  /**
   * Set (or update) a local password for an SSO user.
   * After this, the user can log in with username + password in addition to SSO.
   */
  async setLocalPassword(userId: number, password: string): Promise<void> {
    const hash = await hashPassword(password);
    await db('users')
      .where({ id: userId })
      .update({ password_hash: hash, updated_at: new Date() });
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

export function mapUser(row: Record<string, unknown>): User {
  return {
    id: row.id as number,
    username: row.username as string,
    displayName: (row.display_name as string | null) ?? null,
    role: row.role as 'admin' | 'user',
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    email: (row.email as string | null) ?? null,
    preferredLanguage: (row.preferred_language as string) ?? 'en',
    enrollmentVersion: (row.enrollment_version as number) ?? 0,
    totpEnabled: Boolean(row.totp_enabled),
    emailOtpEnabled: Boolean(row.email_otp_enabled),
  };
}
