import type { Knex } from 'knex';

/**
 * Remediation system — three tables:
 *
 *  remediation_actions  : global pool of actions (webhook, script, docker, ssh, …)
 *  remediation_bindings : scope-based bindings (global / group / monitor)
 *                         with the same merge/replace/exclude inheritance model
 *                         used by notification_bindings.
 *  remediation_runs     : audit log of every execution attempt.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('remediation_actions', (t) => {
    t.increments('id').primary();
    t.string('name', 100).notNullable();
    t.string('type', 30).notNullable();  // webhook | n8n | script | docker_restart | ssh
    t.jsonb('config').notNullable().defaultTo('{}');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('remediation_bindings', (t) => {
    t.increments('id').primary();
    t.integer('action_id').unsigned().notNullable()
      .references('id').inTable('remediation_actions').onDelete('CASCADE');
    t.string('scope', 20).notNullable();        // global | group | monitor
    t.integer('scope_id').nullable();
    t.string('override_mode', 20).notNullable().defaultTo('merge'); // merge | replace | exclude
    t.string('trigger_on', 20).notNullable().defaultTo('down');     // down | up | both
    t.integer('cooldown_seconds').notNullable().defaultTo(300);
    t.unique(['action_id', 'scope', 'scope_id']);
    t.index(['scope', 'scope_id']);
  });

  await knex.schema.createTable('remediation_runs', (t) => {
    t.increments('id').primary();
    t.integer('action_id').unsigned().notNullable()
      .references('id').inTable('remediation_actions').onDelete('CASCADE');
    t.integer('monitor_id').unsigned().notNullable();
    t.string('triggered_by', 10).notNullable();  // down | up
    // success | failed | timeout | cooldown_skip
    t.string('status', 20).notNullable();
    t.text('output').nullable();
    t.text('error').nullable();
    t.integer('duration_ms').nullable();
    t.timestamptz('triggered_at').notNullable().defaultTo(knex.fn.now());
    t.index(['monitor_id', 'triggered_at']);
    t.index(['action_id', 'triggered_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('remediation_runs');
  await knex.schema.dropTableIfExists('remediation_bindings');
  await knex.schema.dropTableIfExists('remediation_actions');
}
