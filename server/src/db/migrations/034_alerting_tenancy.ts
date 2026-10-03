import type { Knex } from 'knex';

/**
 * Migration 034 — alerting tenancy (W5-1: ADMIN-FEATURES-4, BROKEN-6,
 * ADMIN-FEATURES-6 / DATA-REALTIME-12).
 *
 * notification_bindings.tenant_id: the tenant a binding belongs to. A
 * 'global' binding covers the agents of its tenant only, except one of the
 * Default tenant, which covers every tenant (platform on-call channel).
 * Backfill: group/agent rows take the tenant of their target (except a
 * Default-owned channel not shared to it: a legacy Default row), global rows
 * the tenant of their channel, anything left the Default tenant. Duplicates of
 * (channel, scope, scope id, tenant) are deleted (the lowest id is kept): the
 * old unique (channel_id, scope, scope_id) never matched a NULL scope_id, so
 * every "enable globally" click added a global row. It is replaced by a
 * unique index on (channel_id, scope, COALESCE(scope_id, 0), tenant_id).
 *
 * notification_log.tenant_id / scope / scope_id (nullable): who a delivery
 * was for (the agent's tenant, scope 'agent' + device id; 'group'; a test).
 *
 * live_alerts incident model: resolved_at (NULL = active), incident_kind,
 * device_id, occurrences (bumped by a repeated raise of an open incident) and
 * updated_at (last raise). Partial index (tenant_id, stable_key) WHERE
 * resolved_at IS NULL serves the "open incident of this key" lookup
 * (stable_key exists since 001).
 *
 * Idempotent (hasColumn / IF [NOT] EXISTS guards).
 */
export async function up(knex: Knex): Promise<void> {
  // ── notification_bindings.tenant_id ──
  if (!(await knex.schema.hasColumn('notification_bindings', 'tenant_id'))) {
    await knex.schema.alterTable('notification_bindings', (t) => {
      t.integer('tenant_id').nullable()
        .references('id').inTable('tenants').onDelete('CASCADE');
    });
  }
  // Group/agent rows: the target's tenant, except a Default-owned channel the
  // target's tenant cannot see (not shared to it): such a row was made from
  // the Default tenant before bindings were tenant-checked, and stays a
  // Default row so it keeps firing (the resolvers count the Default tenant's
  // rows on any target). It falls through to the channel-tenant step below.
  for (const [scope, table] of [['group', 'monitor_groups'], ['agent', 'agent_devices']] as const) {
    await knex.raw(`
      UPDATE notification_bindings b SET tenant_id = t.tenant_id
        FROM ${table} t, notification_channels c
       WHERE b.tenant_id IS NULL AND b.scope = ? AND t.id = b.scope_id AND t.tenant_id IS NOT NULL
         AND c.id = b.channel_id
         AND NOT (
           c.tenant_id = 1 AND t.tenant_id <> 1
           AND NOT EXISTS (SELECT 1 FROM notification_channel_tenants ct
                            WHERE ct.channel_id = c.id AND ct.tenant_id = t.tenant_id)
         )`, [scope]);
  }
  await knex.raw(`
    UPDATE notification_bindings b SET tenant_id = c.tenant_id
      FROM notification_channels c
     WHERE b.tenant_id IS NULL AND c.id = b.channel_id AND c.tenant_id IS NOT NULL`);
  await knex.raw(`
    UPDATE notification_bindings SET tenant_id = 1
     WHERE tenant_id IS NULL AND EXISTS (SELECT 1 FROM tenants WHERE id = 1)`);
  // A row still without tenant (no Default tenant row at all) cannot be
  // attributed to anyone: it is dropped rather than left unscoped.
  await knex('notification_bindings').whereNull('tenant_id').delete();
  await knex.raw('ALTER TABLE notification_bindings ALTER COLUMN tenant_id SET NOT NULL');

  await knex.raw(`
    DELETE FROM notification_bindings a
     USING notification_bindings b
     WHERE a.channel_id = b.channel_id
       AND a.scope = b.scope
       AND COALESCE(a.scope_id, 0) = COALESCE(b.scope_id, 0)
       AND a.tenant_id = b.tenant_id
       AND a.id > b.id`);
  await knex.raw('ALTER TABLE notification_bindings DROP CONSTRAINT IF EXISTS notification_bindings_channel_id_scope_scope_id_unique');
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS notification_bindings_scope_tenant_unique
      ON notification_bindings (channel_id, scope, COALESCE(scope_id, 0), tenant_id)`);
  await knex.raw('CREATE INDEX IF NOT EXISTS notification_bindings_tenant_scope ON notification_bindings (tenant_id, scope)');

  // ── notification_log scope ──
  if (!(await knex.schema.hasColumn('notification_log', 'tenant_id'))) {
    await knex.schema.alterTable('notification_log', (t) => {
      t.integer('tenant_id').nullable()
        .references('id').inTable('tenants').onDelete('CASCADE');
      t.string('scope', 20).nullable();
      t.integer('scope_id').nullable();
    });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS notification_log_tenant_created ON notification_log (tenant_id, created_at DESC)');

  // ── live_alerts incident model ──
  if (!(await knex.schema.hasColumn('live_alerts', 'resolved_at'))) {
    await knex.schema.alterTable('live_alerts', (t) => {
      t.timestamp('resolved_at', { useTz: true }).nullable();
      t.string('incident_kind', 40).nullable();
      t.integer('device_id').nullable();
      t.integer('occurrences').notNullable().defaultTo(1);
      t.timestamp('updated_at', { useTz: true }).nullable();
    });
  }
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS live_alerts_open_stable_key
      ON live_alerts (tenant_id, stable_key) WHERE resolved_at IS NULL`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS live_alerts_open_device
      ON live_alerts (device_id, incident_kind) WHERE resolved_at IS NULL AND device_id IS NOT NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS live_alerts_open_device');
  await knex.raw('DROP INDEX IF EXISTS live_alerts_open_stable_key');
  if (await knex.schema.hasColumn('live_alerts', 'resolved_at')) {
    await knex.schema.alterTable('live_alerts', (t) => {
      t.dropColumn('updated_at');
      t.dropColumn('occurrences');
      t.dropColumn('device_id');
      t.dropColumn('incident_kind');
      t.dropColumn('resolved_at');
    });
  }

  await knex.raw('DROP INDEX IF EXISTS notification_log_tenant_created');
  if (await knex.schema.hasColumn('notification_log', 'tenant_id')) {
    await knex.schema.alterTable('notification_log', (t) => {
      t.dropColumn('scope_id');
      t.dropColumn('scope');
      t.dropColumn('tenant_id');
    });
  }

  await knex.raw('DROP INDEX IF EXISTS notification_bindings_tenant_scope');
  await knex.raw('DROP INDEX IF EXISTS notification_bindings_scope_tenant_unique');
  if (await knex.schema.hasColumn('notification_bindings', 'tenant_id')) {
    // Several tenants may now hold the same (channel, scope, scope id): keep
    // one row per key before the pre-034 unique constraint comes back.
    await knex.raw(`
      DELETE FROM notification_bindings a
       USING notification_bindings b
       WHERE a.channel_id = b.channel_id
         AND a.scope = b.scope
         AND a.scope_id = b.scope_id
         AND a.id > b.id`);
    await knex.schema.alterTable('notification_bindings', (t) => {
      t.dropColumn('tenant_id');
    });
    await knex.raw(`
      ALTER TABLE notification_bindings
        ADD CONSTRAINT notification_bindings_channel_id_scope_scope_id_unique UNIQUE (channel_id, scope, scope_id)`);
  }
}
