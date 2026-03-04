import type { Knex } from 'knex';

/**
 * Add two columns to agent_devices to support server-initiated commands:
 *
 *  pending_command        — command queued by admin, delivered on next agent push
 *                           (e.g. 'uninstall').  Cleared once consumed.
 *  uninstall_commanded_at — timestamp set when the 'uninstall' command is delivered
 *                           to the agent.  Used by the cleanup job to auto-delete
 *                           the device after ~10 minutes of silence.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.string('pending_command', 50).nullable().defaultTo(null);
    t.timestamp('uninstall_commanded_at').nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('pending_command');
    t.dropColumn('uninstall_commanded_at');
  });
}
