import type { Knex } from 'knex';

/**
 * 008_ip_reputation_clears.ts
 *
 * Per-tenant "clear suspicious" baseline for IP reputation.
 *
 * When a tenant admin (or global admin) marks an IP as "cleared", we snapshot
 * the current total_failures counter into baseline_failures.  The IP is
 * considered suspicious again only when total_failures exceeds that baseline
 * (i.e., new attacks occurred after the clear).
 *
 * - Tenant admin:  inserts/updates a row for (ip, tenant_id)
 * - Global admin:  resets total_failures = 0 on ip_reputation AND deletes all
 *                  per-tenant clear rows for that IP (clean slate across everyone)
 *
 * UNIQUE(ip, tenant_id) — one baseline per (IP, tenant).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ip_reputation_tenant_clears', (t) => {
    t.increments('id').primary();
    t.text('ip').notNullable();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');

    /**
     * The total_failures value at the moment the clear was issued.
     * Suspicious = ip_reputation.total_failures > baseline_failures
     */
    t.integer('baseline_failures').notNullable().defaultTo(0);

    t.timestamp('cleared_at').notNullable().defaultTo(knex.fn.now());
    t.integer('cleared_by').nullable().references('id').inTable('users').onDelete('SET NULL');

    t.unique(['ip', 'tenant_id']);
  });

  await knex.schema.raw(
    'CREATE INDEX idx_ip_rep_clears_ip ON ip_reputation_tenant_clears (ip)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ip_reputation_tenant_clears');
}
