import type { Knex } from 'knex';

/**
 * 009_foreign_sso.ts
 *
 * Adds Foreign SSO support between Obliguard ↔ Obliview.
 *
 * Changes:
 * 1. `users` table:
 *    - `password_hash` made NULLABLE (foreign users have no local password)
 *    - `foreign_source`     VARCHAR(64)  — source platform name (e.g. 'obliview')
 *    - `foreign_id`         INTEGER      — user ID on the foreign platform
 *    - `foreign_source_url` TEXT         — base URL of the foreign platform
 *
 * 2. `switch_tokens` table:
 *    - One-time tokens exchanged during cross-platform SSO redirects
 *    - TTL: 60 seconds, single-use (used = true after validation)
 */
export async function up(knex: Knex): Promise<void> {
  // 1. Alter users table
  await knex.schema.alterTable('users', (t) => {
    t.string('password_hash', 255).nullable().alter();
    t.string('foreign_source', 64).nullable().defaultTo(null);
    t.integer('foreign_id').nullable().defaultTo(null);
    t.text('foreign_source_url').nullable().defaultTo(null);
  });

  // 2. Create switch_tokens table
  await knex.schema.createTable('switch_tokens', (t) => {
    t.increments('id').primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('token', 128).notNullable().unique();
    t.timestamp('expires_at').notNullable();
    t.boolean('used').notNullable().defaultTo(false);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(
    'CREATE INDEX idx_switch_tokens_token ON switch_tokens (token)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('switch_tokens');

  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('foreign_source_url');
    t.dropColumn('foreign_id');
    t.dropColumn('foreign_source');
    t.string('password_hash', 255).notNullable().alter();
  });
}
