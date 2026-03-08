import type { Knex } from 'knex';

/**
 * Migration 042 — Per-agent notification type overrides.
 *
 * Adds a `notification_types` JSONB column to `agent_devices`.
 * When NULL, the device inherits notification type settings from its parent agent group(s).
 * When set, the device overrides each field (global/down/up/alert/update) independently.
 *
 * Note: Agent GROUP-level notification types are stored within the existing
 * `agent_group_config` JSONB column on `monitor_groups` (no schema change needed there).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.table('agent_devices', (table) => {
    // null = inherit from group chain; non-null = device-level override
    table.jsonb('notification_types').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.table('agent_devices', (table) => {
    table.dropColumn('notification_types');
  });
}
