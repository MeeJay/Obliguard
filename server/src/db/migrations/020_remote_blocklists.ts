import type { Knex } from 'knex';

/**
 * Migration 020 — Remote blocklists.
 *
 * Adds tables for subscribing to external IP blocklists (URL-based or
 * guard.obli.tools centralized feed) and storing their blocked IPs locally.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('remote_blocklists', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('source_type', 32).notNullable(); // 'oblitools' | 'url'
    t.text('url').notNullable();
    t.text('api_key').nullable(); // Bearer token for obli.tools
    t.boolean('enabled').notNullable().defaultTo(true);
    t.integer('sync_interval').notNullable().defaultTo(600); // seconds
    t.timestamp('last_sync_at', { useTz: true }).nullable();
    t.integer('last_sync_count').notNullable().defaultTo(0);
    t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('remote_blocked_ips', (t) => {
    t.increments('id').primary();
    t.integer('blocklist_id').notNullable().references('id').inTable('remote_blocklists').onDelete('CASCADE');
    t.specificType('ip', 'inet').notNullable();
    t.string('reason', 256).nullable();
    t.timestamp('first_seen', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.integer('reports').notNullable().defaultTo(1);
    t.specificType('sources', 'text[]').nullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['blocklist_id', 'ip']);
  });

  await knex.schema.raw(
    'CREATE INDEX idx_remote_blocked_ips_bl ON remote_blocked_ips(blocklist_id) WHERE enabled = true',
  );
  await knex.schema.raw(
    'CREATE INDEX idx_remote_blocked_ips_ip ON remote_blocked_ips(ip)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('remote_blocked_ips');
  await knex.schema.dropTableIfExists('remote_blocklists');
}
