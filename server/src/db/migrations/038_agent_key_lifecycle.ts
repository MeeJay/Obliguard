import type { Knex } from 'knex';

/**
 * Migration 038 — agent API key lifecycle (W10-2: FLEET-AGENT-13,
 * SECURITY-PARITY-19, UI-PAGES-FLEET-14; owner decision 19: an is_active
 * flag as in Obliance, keys are not hashed).
 *
 *   1. agent_api_keys.is_active: revocation flag. Deleting a key used to be
 *      the only way to stop a leaked one, and that released every device it
 *      enrolled (agent_devices.api_key_id → SET NULL). A disabled key is
 *      refused like an unknown one (agentAuth, the WS gate) and its live
 *      sessions are closed, while devices and history stay bound to it.
 *      Existing keys stay active (default true).
 *   2. revoked_at / revoked_by: when and by whom the key was last disabled
 *      (cleared on re-enable). revoked_by follows the user (SET NULL).
 *   3. default_group_id: group a new agent enrolled with this key lands in
 *      (assigned at registration, pre-filled at approval). Deleting the
 *      group clears it (SET NULL). The service checks that the group belongs
 *      to the key's tenant.
 *
 * Mirrors Obliance 089_api_key_is_active.ts and 026_api_key_default_group.ts.
 * Idempotent (hasColumn guards).
 */

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('agent_api_keys', 'is_active'))) {
    await knex.schema.alterTable('agent_api_keys', (t) => {
      t.boolean('is_active').notNullable().defaultTo(true);
    });
  }
  if (!(await knex.schema.hasColumn('agent_api_keys', 'revoked_at'))) {
    await knex.schema.alterTable('agent_api_keys', (t) => {
      t.timestamp('revoked_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('agent_api_keys', 'revoked_by'))) {
    await knex.schema.alterTable('agent_api_keys', (t) => {
      t.integer('revoked_by').unsigned().nullable()
        .references('id').inTable('users').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasColumn('agent_api_keys', 'default_group_id'))) {
    await knex.schema.alterTable('agent_api_keys', (t) => {
      t.integer('default_group_id').unsigned().nullable()
        .references('id').inTable('monitor_groups').onDelete('SET NULL');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['default_group_id', 'revoked_by', 'revoked_at', 'is_active']) {
    if (await knex.schema.hasColumn('agent_api_keys', col)) {
      await knex.schema.alterTable('agent_api_keys', (t) => {
        t.dropColumn(col);
      });
    }
  }
}
