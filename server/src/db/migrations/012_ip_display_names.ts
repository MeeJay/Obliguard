import type { Knex } from 'knex';

/**
 * 012_ip_display_names.ts
 *
 * Per-tenant custom display names for known IP addresses.
 * Lets operators label any IP (whitelisted, suspicious, banned, etc.)
 * with a human-readable name (e.g., "AIRBOX", "Office NAT") that is then
 * shown on the network map and reputation tables instead of the raw address.
 *
 * Scope:
 *   tenant_id = NULL  →  global label set by a global admin (visible to all)
 *   tenant_id = N     →  tenant-scoped label (overrides global for that tenant)
 *
 * UNIQUE(ip, tenant_id) ensures at most one label per (IP, tenant).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ip_display_names', (t) => {
    t.increments('id').primary();
    t.text('ip').notNullable();
    t.text('label').notNullable();
    t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['ip', 'tenant_id']);
  });

  await knex.schema.raw('CREATE INDEX idx_ip_display_names_ip ON ip_display_names(ip)');
  await knex.schema.raw('CREATE INDEX idx_ip_display_names_tenant ON ip_display_names(tenant_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ip_display_names');
}
