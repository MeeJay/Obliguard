import type { Knex } from 'knex';

/**
 * 006_ban_exclusions.ts
 *
 * Per-tenant exclusions for global bans.
 *
 * A tenant admin can "exclude" a global auto-ban from their tenant:
 * the ban still applies globally (other tenants still enforce it),
 * but agents belonging to this tenant will NOT enforce it.
 *
 * This gives tenant admins a safe escape hatch for false-positive auto-bans
 * without revoking the global protection for everyone else.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ip_ban_exclusions', (t) => {
    t.increments('id').primary();
    // Which global ban is being excluded
    t.integer('ban_id').notNullable()
      .references('id').inTable('ip_bans').onDelete('CASCADE');
    // Which tenant is opting out of enforcing this ban
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('created_by').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // A tenant can only exclude a ban once
    t.unique(['ban_id', 'tenant_id']);
  });

  // Fast lookup during ban-delta computation (per tenant)
  await knex.schema.raw(
    'CREATE INDEX idx_ip_ban_exclusions_tenant ON ip_ban_exclusions(tenant_id, ban_id)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP INDEX IF EXISTS idx_ip_ban_exclusions_tenant');
  await knex.schema.dropTableIfExists('ip_ban_exclusions');
}
