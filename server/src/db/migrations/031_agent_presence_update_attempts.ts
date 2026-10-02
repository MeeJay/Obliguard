import type { Knex } from 'knex';

/**
 * 031_agent_presence_update_attempts.ts — agent presence and the closed-loop
 * update lifecycle (W2-1: FLEET-AGENT-1/9, DATA-REALTIME-18, UI-PAGES-FLEET-2).
 *
 * agent_devices:
 *   - last_seen_at: last heartbeat / events frame / push (60 s resolution).
 *     updated_at stays an audit field (admin edits, commands move it), so the
 *     UI's "last seen" no longer lies. Backfilled from updated_at for
 *     approved devices (the best value available at deploy);
 *   - last_online_at / last_offline_at: WS registration / offline grace expiry;
 *   - capabilities: what the agent build reports in its heartbeat
 *     (e.g. 'tls_unverified'), jsonb array, '[]' by default.
 *
 * agent_update_attempts: one row per (device, target version). An offer is
 * counted only after the config frame carrying latestVersion was written; at
 * most 3 offers (10 min apart) under every policy, then 'failed'
 * ('no_progress') until an admin retries. The agent reports its progress in
 * update_status frames; the server closes the attempt 'succeeded' when the
 * agent reports the target, 'failed' on an error, a revert or a timeout.
 *
 * tenants.agent_update_policy: the TENANT level of the C17 update policy
 * (global -> tenant -> group -> agent; 'off' absolute at any level). NULL =
 * inherit the global policy.
 *
 * Every step is guarded (idempotent, order-independent).
 */
const PHASES = ['offered', 'downloading', 'verifying', 'installing', 'restarting', 'succeeded', 'failed', 'cancelled'];

export async function up(knex: Knex): Promise<void> {
  for (const col of ['last_seen_at', 'last_online_at', 'last_offline_at']) {
    if (!(await knex.schema.hasColumn('agent_devices', col))) {
      await knex.schema.alterTable('agent_devices', (t) => {
        t.timestamp(col, { useTz: true }).nullable().defaultTo(null);
      });
    }
  }
  if (!(await knex.schema.hasColumn('agent_devices', 'capabilities'))) {
    await knex.schema.alterTable('agent_devices', (t) => {
      t.jsonb('capabilities').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    });
  }
  // Best value available at deploy: the last push (or admin edit) of approved agents.
  await knex.raw("UPDATE agent_devices SET last_seen_at = updated_at WHERE last_seen_at IS NULL AND status = 'approved'");

  if (!(await knex.schema.hasTable('agent_update_attempts'))) {
    await knex.schema.createTable('agent_update_attempts', (t) => {
      t.increments('id').primary();
      t.integer('device_id').notNullable().references('id').inTable('agent_devices').onDelete('CASCADE');
      t.string('target_version', 64).notNullable();
      t.integer('offered_count').notNullable().defaultTo(0);
      t.timestamp('last_offered_at', { useTz: true }).nullable().defaultTo(null);
      t.string('phase', 16).notNullable().defaultTo('offered');
      t.text('last_error').nullable().defaultTo(null);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('finished_at', { useTz: true }).nullable().defaultTo(null);
      t.unique(['device_id', 'target_version']);
    });
  }
  await knex.raw('ALTER TABLE agent_update_attempts DROP CONSTRAINT IF EXISTS agent_update_attempts_phase_check');
  await knex.raw(
    `ALTER TABLE agent_update_attempts ADD CONSTRAINT agent_update_attempts_phase_check CHECK (phase IN (${PHASES.map((p) => `'${p}'`).join(',')}))`,
  );
  // Sweeps (timeouts) read the open attempts by phase and age.
  await knex.raw('CREATE INDEX IF NOT EXISTS agent_update_attempts_phase_updated_idx ON agent_update_attempts (phase, updated_at)');

  if (!(await knex.schema.hasColumn('tenants', 'agent_update_policy'))) {
    await knex.schema.alterTable('tenants', (t) => {
      t.string('agent_update_policy', 16).nullable().defaultTo(null);
    });
  }
  await knex.raw('ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_agent_update_policy_check');
  await knex.raw(
    "ALTER TABLE tenants ADD CONSTRAINT tenants_agent_update_policy_check CHECK (agent_update_policy IS NULL OR agent_update_policy IN ('auto','manual','off'))",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_agent_update_policy_check');
  if (await knex.schema.hasColumn('tenants', 'agent_update_policy')) {
    await knex.schema.alterTable('tenants', (t) => {
      t.dropColumn('agent_update_policy');
    });
  }
  await knex.schema.dropTableIfExists('agent_update_attempts');
  for (const col of ['capabilities', 'last_offline_at', 'last_online_at', 'last_seen_at']) {
    if (await knex.schema.hasColumn('agent_devices', col)) {
      await knex.schema.alterTable('agent_devices', (t) => {
        t.dropColumn(col);
      });
    }
  }
}
