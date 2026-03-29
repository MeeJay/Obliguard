import type { Knex } from 'knex';

/**
 * Migration 017 — MikroTik remote device support.
 *
 * Adds:
 *   - `device_type` column to `agent_devices` ('agent' | 'mikrotik')
 *   - `mikrotik_credentials` table (API host, port, TLS, user/pass, syslog routing)
 *   - Built-in service templates for MikroTik auth services
 */
export async function up(knex: Knex): Promise<void> {
  // 1. Add device_type to agent_devices
  await knex.schema.alterTable('agent_devices', (t) => {
    t.string('device_type', 20).notNullable().defaultTo('agent');
  });

  // 2. Create mikrotik_credentials table
  await knex.schema.createTable('mikrotik_credentials', (t) => {
    t.increments('id').primary();
    t.integer('device_id').unsigned().notNullable().unique()
      .references('id').inTable('agent_devices').onDelete('CASCADE');
    t.string('api_host', 255).notNullable();
    t.integer('api_port').notNullable().defaultTo(8728);
    t.boolean('api_use_tls').notNullable().defaultTo(false);
    t.string('api_username', 255).notNullable().defaultTo('admin');
    t.text('api_password_enc').notNullable(); // AES-256-GCM encrypted
    t.string('syslog_identifier', 255).notNullable(); // source IP for syslog routing
    t.string('address_list_name', 255).notNullable().defaultTo('obliguard_blocklist');
    t.timestamp('last_api_connected_at', { useTz: true }).nullable();
    t.text('last_api_error').nullable();
    t.timestamp('last_syslog_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // 3. Seed MikroTik built-in service templates
  const existing = await knex('service_templates')
    .whereIn('service_type', ['mikrotik_ssh', 'mikrotik_winbox', 'mikrotik_web'])
    .select('service_type');
  const existingTypes = new Set(existing.map((r) => r.service_type));

  const toInsert: Array<Record<string, unknown>> = [];

  if (!existingTypes.has('mikrotik_ssh')) {
    toInsert.push({
      name: 'MikroTik SSH',
      service_type: 'mikrotik_ssh',
      is_builtin: true,
      threshold: 5,
      window_seconds: 300,
      mode: 'ban',
      enabled: true,
    });
  }
  if (!existingTypes.has('mikrotik_winbox')) {
    toInsert.push({
      name: 'MikroTik Winbox',
      service_type: 'mikrotik_winbox',
      is_builtin: true,
      threshold: 5,
      window_seconds: 300,
      mode: 'ban',
      enabled: true,
    });
  }
  if (!existingTypes.has('mikrotik_web')) {
    toInsert.push({
      name: 'MikroTik Web UI',
      service_type: 'mikrotik_web',
      is_builtin: true,
      threshold: 5,
      window_seconds: 300,
      mode: 'ban',
      enabled: true,
    });
  }

  if (toInsert.length > 0) {
    await knex('service_templates').insert(toInsert);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('service_templates')
    .whereIn('service_type', ['mikrotik_ssh', 'mikrotik_winbox', 'mikrotik_web'])
    .where('is_builtin', true)
    .del();

  await knex.schema.dropTableIfExists('mikrotik_credentials');

  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('device_type');
  });
}
