import type { Knex } from 'knex';

/**
 * Migration 042 — agent command queue (W14-1, FLEET-AGENT-11).
 *
 * Replaces the single agent_devices.pending_command string with a queue that
 * keeps an acknowledgement, a result and a history per agent (mirrors
 * Obliance command_queue, reduced to the Obliguard command set):
 *
 *   - type: 'uninstall' | 'restart' | 'firewall_resync';
 *   - status: queued → sent → acked → succeeded | failed, or expired (never
 *     delivered before expires_at). A row delivered to an agent without the
 *     'cmdqueue' capability (legacy config-frame uninstall) stays 'sent' with
 *     legacy = true and finished_at set: such agents never acknowledge;
 *   - created_by: the requesting user (NULL for system requests such as the
 *     "uninstall all agents" of a tenant deletion).
 *
 * One outstanding command per device and type (partial unique index): a
 * second uninstall is refused while one is queued, sent or acknowledged.
 *
 * pending_command stays: it is the fallback of agents that never ack (the
 * legacy config-frame path) and the "uninstalling" flag of the UI. Devices
 * with a queued 'uninstall' get their queue row here.
 */

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('agent_commands')) return;

  await knex.schema.createTable('agent_commands', (t) => {
    t.bigIncrements('id').primary();
    t.integer('device_id').notNullable()
      .references('id').inTable('agent_devices').onDelete('CASCADE');
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.string('type', 32).notNullable();
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.string('status', 16).notNullable().defaultTo('queued');
    t.jsonb('result').nullable();
    t.boolean('legacy').notNullable().defaultTo(false);
    t.integer('created_by').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('sent_at', { useTz: true }).nullable();
    t.timestamp('acked_at', { useTz: true }).nullable();
    t.timestamp('finished_at', { useTz: true }).nullable();
    t.timestamp('expires_at', { useTz: true }).nullable();
  });

  await knex.raw(`ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_type_check
    CHECK (type IN ('uninstall', 'restart', 'firewall_resync'))`);
  await knex.raw(`ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_status_check
    CHECK (status IN ('queued', 'sent', 'acked', 'succeeded', 'failed', 'expired'))`);

  // History of an agent, newest first.
  await knex.raw('CREATE INDEX idx_agent_commands_device_created ON agent_commands (device_id, created_at DESC)');
  // Delivery and expiry sweep: the open rows only.
  await knex.raw(`CREATE INDEX idx_agent_commands_open ON agent_commands (status, created_at)
    WHERE status IN ('queued', 'sent', 'acked') AND finished_at IS NULL`);
  // One outstanding command per device and type (one uninstall at a time).
  await knex.raw(`CREATE UNIQUE INDEX uq_agent_commands_outstanding ON agent_commands (device_id, type)
    WHERE status IN ('queued', 'sent', 'acked') AND finished_at IS NULL`);

  // Uninstalls queued before the upgrade keep their pending_command (legacy
  // fallback) and get their queue row.
  await knex.raw(`INSERT INTO agent_commands (device_id, tenant_id, type, status, created_at)
    SELECT id, tenant_id, 'uninstall', 'queued', COALESCE(updated_at, now())
      FROM agent_devices
     WHERE pending_command = 'uninstall' AND tenant_id IS NOT NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('agent_commands');
}
