import type { Knex } from 'knex';

/**
 * 023_evaluate_only.ts
 *
 * Adds "evaluate-only" (dry-run / observation) mode, settable on a group or on a
 * single agent. Semantics enforced elsewhere:
 *   - Events still flow and are stored / shown (for whitelist-rule evaluation).
 *   - The BanEngine does NOT create auto-bans from an evaluate-only agent's events.
 *   - The agent enforces NO bans at its firewall (server sends an empty ban add
 *     list + removes anything already enforced) — zero network impact.
 *
 * Inheritance mirrors the rest of the stack (group → descendant groups → agents):
 * a device is evaluate-only if its own flag is true OR any ancestor group's flag
 * is true (resolved via group_closure).
 */
export async function up(knex: Knex): Promise<void> {
  const hasGroupCol = await knex.schema.hasColumn('monitor_groups', 'evaluate_only');
  if (!hasGroupCol) {
    await knex.schema.alterTable('monitor_groups', (t) => {
      t.boolean('evaluate_only').notNullable().defaultTo(false);
    });
  }

  const hasDeviceCol = await knex.schema.hasColumn('agent_devices', 'evaluate_only');
  if (!hasDeviceCol) {
    await knex.schema.alterTable('agent_devices', (t) => {
      t.boolean('evaluate_only').notNullable().defaultTo(false);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasGroupCol = await knex.schema.hasColumn('monitor_groups', 'evaluate_only');
  if (hasGroupCol) {
    await knex.schema.alterTable('monitor_groups', (t) => {
      t.dropColumn('evaluate_only');
    });
  }
  const hasDeviceCol = await knex.schema.hasColumn('agent_devices', 'evaluate_only');
  if (hasDeviceCol) {
    await knex.schema.alterTable('agent_devices', (t) => {
      t.dropColumn('evaluate_only');
    });
  }
}
