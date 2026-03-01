import type { Knex } from 'knex';

/**
 * Agent settings override flag.
 *
 * Adds an explicit override_group_settings boolean so the UI can show an
 * "Override group settings" toggle (exactly like the monitor SettingsPanel).
 *
 * When override_group_settings = false (default) the device inherits
 * checkIntervalSeconds, heartbeatMonitoring, and maxMissedPushes from the
 * parent group's agent_group_config.  The existing per-device columns
 * (check_interval_seconds, heartbeat_monitoring, agent_max_missed_pushes)
 * continue to hold the device-level values and are used when override = true.
 *
 * Note: check_interval_seconds already exists since migration 015; we only
 * add the override flag here.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.boolean('override_group_settings').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('override_group_settings');
  });
}
