import type { Knex } from 'knex';

/**
 * Migration 019 — Add HTTP ingest token to mikrotik_credentials.
 *
 * For environments where UDP syslog can't be exposed (reverse proxy, Docker, etc.),
 * MikroTik devices can POST log lines to /api/agent/mikrotik/ingest via HTTP.
 * Authentication is done via a unique per-device token.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mikrotik_credentials', (t) => {
    t.string('ingest_token', 64).nullable().unique();
  });

  // Generate tokens for existing devices
  const rows = await knex('mikrotik_credentials').select('id');
  for (const row of rows) {
    const token = require('crypto').randomBytes(32).toString('hex');
    await knex('mikrotik_credentials').where('id', row.id).update({ ingest_token: token });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mikrotik_credentials', (t) => {
    t.dropColumn('ingest_token');
  });
}
