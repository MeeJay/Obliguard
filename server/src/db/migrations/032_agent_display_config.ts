import type { Knex } from 'knex';

/**
 * Add display_config JSONB column to agent_devices.
 *
 * Stores per-device UI display preferences (hidden cores, grouped thread view,
 * hidden temperature probes, renamed drives, combined charts, etc.)
 * as an AgentDisplayConfig object. Null = all defaults apply.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.jsonb('display_config').nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('display_config');
  });
}
