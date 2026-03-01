import type { Knex } from 'knex';

/**
 * Add sensor_display_names JSONB column to agent_devices.
 *
 * Stores a map of sensorKey → human-readable label so that admins can give
 * friendly names to temperature sensors whose raw labels are cryptic
 * (e.g. "acpitz-acpi-0" → "Motherboard").
 *
 * Key format: "temp:<raw_label>" — the same format used for threshold overrides
 * (see agent.service.ts, _storeMetricsAsHeartbeat).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.jsonb('sensor_display_names').nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('sensor_display_names');
  });
}
