import type { Knex } from 'knex';

/**
 * Migration 044 — Remove all monitor-specific tables.
 *
 * Obliguard has no monitors. Keeps groups, agents, auth, notifications, settings.
 * Cleans up:
 *  - incidents, heartbeat_stats, heartbeats (depend on monitors)
 *  - monitors table
 *  - monitor_type and monitor_status PostgreSQL enums
 *  - monitor-scoped settings entries (scope = 'monitor')
 *  - monitor-scoped notification_bindings (scope = 'monitor')
 *  - notification_logs.monitor_id column (SET NULL FK, column no longer meaningful)
 */
export async function up(knex: Knex): Promise<void> {
  // ── 1. Drop tables that depend on monitors (FK CASCADE would handle data, but
  //       we drop the whole table since they're unused in Obliguard) ──────────
  await knex.schema.dropTableIfExists('incidents');
  await knex.schema.dropTableIfExists('heartbeat_stats');
  await knex.schema.dropTableIfExists('heartbeats');

  // ── 2. Drop monitors ──────────────────────────────────────────────────────
  await knex.schema.dropTableIfExists('monitors');

  // ── 3. Drop PostgreSQL enums ──────────────────────────────────────────────
  await knex.schema.raw('DROP TYPE IF EXISTS monitor_type CASCADE');
  await knex.schema.raw('DROP TYPE IF EXISTS monitor_status CASCADE');

  // ── 4. Clean up monitor-scoped settings (no FK, pure data cleanup) ────────
  await knex('settings').where('scope', 'monitor').delete();

  // ── 5. Clean up monitor-scoped notification_bindings ─────────────────────
  await knex('notification_bindings').where('scope', 'monitor').delete();

  // ── 6. Drop notification_logs.monitor_id (no longer relevant) ────────────
  const hasMonitorId = await knex.schema.hasColumn('notification_logs', 'monitor_id');
  if (hasMonitorId) {
    await knex.schema.alterTable('notification_logs', (t) => {
      t.dropColumn('monitor_id');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  // Re-create monitor_status enum
  await knex.schema.raw(`
    CREATE TYPE monitor_status AS ENUM (
      'up', 'down', 'pending', 'maintenance', 'paused'
    )
  `);

  // Re-create monitor_type enum
  await knex.schema.raw(`
    CREATE TYPE monitor_type AS ENUM (
      'http', 'ping', 'tcp', 'dns', 'ssl', 'smtp',
      'docker', 'game_server', 'push', 'script', 'json_api'
    )
  `);

  // Re-create monitors (minimal — full schema in migration 003)
  await knex.schema.createTable('monitors', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();
    t.text('description').nullable();
    t.specificType('type', 'monitor_type').notNullable();
    t.integer('group_id').nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.specificType('status', 'monitor_status').notNullable().defaultTo('pending');
    t.integer('tenant_id').notNullable().defaultTo(1);
    t.timestamps(true, true);
  });

  // Re-create heartbeats
  await knex.schema.createTable('heartbeats', (t) => {
    t.bigIncrements('id').primary();
    t.integer('monitor_id').notNullable().references('id').inTable('monitors').onDelete('CASCADE');
    t.specificType('status', 'monitor_status').notNullable();
    t.integer('response_time').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Re-add notification_logs.monitor_id
  await knex.schema.alterTable('notification_logs', (t) => {
    t.integer('monitor_id').nullable().references('id').inTable('monitors').onDelete('SET NULL');
  });
}
