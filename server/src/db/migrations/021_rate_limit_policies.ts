import type { Knex } from 'knex';

/**
 * Migration 021 — Per-IP rate limiting policies.
 *
 * Stores firewall-enforced rate limiting rules, resolved per-agent via the
 * same global → group → agent inheritance the whitelist uses.
 *
 * Two independent policy types (each toggled separately on the platform):
 *   - 'connection' : max concurrent connections per source IP (connlimit / pf max-src-conn)
 *   - 'rate'       : max new connections per second per source IP (hashlimit / pf max-src-conn-rate)
 *
 * Two-tier action:
 *   - over max_value            → `action` ('drop' | 'reject')
 *   - over max_value * ban_mult → escalate to an auto ban (reuses the ban pipeline)
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('rate_limit_policies', (t) => {
    t.increments('id').primary();
    t.string('type', 16).notNullable();                 // 'connection' | 'rate'
    t.string('scope', 16).notNullable();                // 'global' | 'tenant' | 'group' | 'agent'
    t.integer('scope_id').nullable();                   // group_id or agent device id
    t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.integer('port').nullable();                       // null = all inbound TCP
    t.integer('max_value').notNullable();               // conns (connection) or conns/sec (rate)
    t.integer('ban_multiplier').nullable();             // null = never escalate to ban
    t.string('action', 16).notNullable().defaultTo('drop'); // 'drop' | 'reject'
    t.integer('ban_ttl_seconds').nullable();            // null = permanent ban on escalation
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  await knex.schema.raw(
    'CREATE INDEX idx_rate_limit_policies_scope ON rate_limit_policies(scope, scope_id) WHERE enabled = true',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('rate_limit_policies');
}
