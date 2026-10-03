import type { Knex } from 'knex';

/**
 * Migration 033 — TOTP anti-replay (W4-1, SECURITY-PARITY-6).
 *
 * users.totp_last_step: the last TOTP time step (floor(unix / 30) + drift)
 * accepted for this user. Every local TOTP check claims its step with one
 * atomic UPDATE ... WHERE totp_last_step IS NULL OR totp_last_step < step
 * (twoFactorService.acceptTotpStep): a code accepted once, at sign-in or as a
 * factor-change proof, can never be accepted again, even inside its ±30 s
 * validity window. Null = no code accepted yet.
 *
 * users.totp_secret is not altered here: it is encrypted at rest by the
 * application on its next write (twoFactorService.sealTotpSecret, "enc:v1:"
 * envelope), legacy plaintext values stay readable until then.
 *
 * Idempotent (hasColumn guard).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('users', 'totp_last_step'))) {
    await knex.schema.alterTable('users', (t) => {
      t.bigInteger('totp_last_step').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('users', 'totp_last_step')) {
    await knex.schema.alterTable('users', (t) => {
      t.dropColumn('totp_last_step');
    });
  }
}
