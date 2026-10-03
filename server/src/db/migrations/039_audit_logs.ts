import type { Knex } from 'knex';

/**
 * Migration 039 — audit log (W11-1: ADMIN-FEATURES-8, SECURITY-PARITY-13,
 * RBAC-18, FLEET-AGENT-18).
 *
 * One row per sensitive action: who (user_id + a username snapshot, kept when
 * the account is deleted, and the attempted name of a failed login), what
 * (action, target_type / target_id, details), where from (ip_address resolved
 * through utils/clientIp, user_agent), on which agent (device_id) and whether
 * it succeeded. Mirrors Obliance audit_logs (025_file_explorer.ts) with the
 * Obliguard additions (username snapshot, user agent, success flag).
 *
 *   - tenant_id: the tenant the action belongs to (an action on an agent is
 *     filed in the agent's tenant). NULL = instance-level row (failed login of
 *     an unknown account, instance configuration): only the Default tenant's
 *     god view reads it. A deleted tenant keeps its rows (SET NULL), so the
 *     trail outlives what it describes.
 *   - device_id: no foreign key, on purpose: the "agent deleted" row and the
 *     history of an agent must survive the agent.
 *
 * Indexes: the list (tenant + newest first), the per-agent activity view,
 * the action filter, and the retention purge (created_at).
 */

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('audit_logs')) return;

  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').nullable()
      .references('id').inTable('tenants').onDelete('SET NULL');
    t.integer('user_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.string('username', 255).nullable();
    t.string('action', 100).notNullable();
    t.string('target_type', 50).nullable();
    t.text('target_id').nullable();
    t.integer('device_id').nullable();
    t.jsonb('details').nullable();
    t.string('ip_address', 45).nullable();
    t.text('user_agent').nullable();
    t.boolean('success').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw('CREATE INDEX idx_audit_logs_tenant_created ON audit_logs (tenant_id, created_at DESC)');
  await knex.raw('CREATE INDEX idx_audit_logs_device_created ON audit_logs (device_id, created_at DESC) WHERE device_id IS NOT NULL');
  await knex.raw('CREATE INDEX idx_audit_logs_action ON audit_logs (action)');
  await knex.raw('CREATE INDEX idx_audit_logs_created ON audit_logs (created_at)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_logs');
}
