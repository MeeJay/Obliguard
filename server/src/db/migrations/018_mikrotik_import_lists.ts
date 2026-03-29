import type { Knex } from 'knex';

/**
 * Migration 018 — Add import_address_lists to mikrotik_credentials.
 *
 * Allows bidirectional sync: MikroTik address-lists (e.g. "blacklist" populated
 * by honeypot rules) are periodically polled and new IPs are imported as
 * global auto-bans in Obliguard, then propagated to all agents.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mikrotik_credentials', (t) => {
    // Comma-separated list of MikroTik address-list names to import from.
    // Empty or null = import disabled for this device.
    t.text('import_address_lists').nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mikrotik_credentials', (t) => {
    t.dropColumn('import_address_lists');
  });
}
