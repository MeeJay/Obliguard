import type { Knex } from 'knex';

/**
 * 027_agent_update_policy.ts — agent update control (C17-1).
 *
 * The server decides when an agent may self-update: latestVersion is sent in
 * the config frame only when the resolved update policy allows it.
 *
 * Policy levels: global (app_config 'agent_global_config'.updatePolicy),
 * group (monitor_groups.agent_group_config->>'updatePolicy', inherited by
 * sub-groups) and agent (agent_devices.update_policy, this migration).
 *   - values 'auto' | 'manual' | 'off'; NULL / absent = inherit;
 *   - 'off' at any level is absolute (freezes the subtree; global 'off' is the
 *     fleet-wide kill-switch); otherwise the nearest explicit value wins;
 *   - the built-in default (nothing set anywhere) is 'manual', enforced in
 *     code: no app_config write, so existing installs are 'manual' at deploy;
 *   - only groups of the device's own tenant count.
 *
 * An explicit "Update now" is stored in update_requested_* (pinned to the
 * version served at click time, 24 h TTL).
 *
 * Nullable columns only, each guarded (idempotent, order-independent).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('agent_devices', 'update_policy'))) {
    await knex.schema.alterTable('agent_devices', (t) => {
      t.string('update_policy', 8).nullable().defaultTo(null);
    });
  }
  if (!(await knex.schema.hasColumn('agent_devices', 'update_requested_at'))) {
    await knex.schema.alterTable('agent_devices', (t) => {
      t.timestamp('update_requested_at', { useTz: true }).nullable().defaultTo(null);
    });
  }
  if (!(await knex.schema.hasColumn('agent_devices', 'update_requested_version'))) {
    await knex.schema.alterTable('agent_devices', (t) => {
      t.string('update_requested_version', 64).nullable().defaultTo(null);
    });
  }
  if (!(await knex.schema.hasColumn('agent_devices', 'update_requested_by'))) {
    await knex.schema.alterTable('agent_devices', (t) => {
      t.integer('update_requested_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    });
  }
  await knex.raw('ALTER TABLE agent_devices DROP CONSTRAINT IF EXISTS agent_devices_update_policy_check');
  await knex.raw(
    "ALTER TABLE agent_devices ADD CONSTRAINT agent_devices_update_policy_check CHECK (update_policy IS NULL OR update_policy IN ('auto','manual','off'))",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE agent_devices DROP CONSTRAINT IF EXISTS agent_devices_update_policy_check');
  for (const col of ['update_requested_by', 'update_requested_version', 'update_requested_at', 'update_policy']) {
    if (await knex.schema.hasColumn('agent_devices', col)) {
      await knex.schema.alterTable('agent_devices', (t) => {
        t.dropColumn(col);
      });
    }
  }
}
