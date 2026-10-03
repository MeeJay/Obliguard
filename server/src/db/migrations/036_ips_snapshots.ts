import type { Knex } from 'knex';

/**
 * Migration 036 — IPS dashboard snapshots (W8-4: DATA-REALTIME-9), the
 * Obliguard counterpart of Obliance's fleet_daily_snapshot /
 * fleet_hourly_snapshot.
 *
 * One row per (tenant, bucket): ips_daily_snapshot (bucket = a day in the
 * database timezone) and ips_hourly_snapshot (bucket = the start of an hour).
 * A row holds what that tenant's dashboard shows, the Default tenant's row
 * being the whole install (not a sum of the tenant rows: distinct IPs and
 * global bans cannot be summed). Written by ipsSnapshot.service with an
 * idempotent onConflict(tenant_id, bucket) merge.
 *
 *   flows  (counted over the bucket, re-computable from ip_events / ip_bans):
 *          events, failures, unique_ips, auto_bans, manual_bans
 *   gauges (state when the bucket was last the current one, NULL = unknown,
 *          e.g. a bucket backfilled from ip_events at boot):
 *          active_bans, agents_total, agents_connected
 *
 * Idempotent (hasTable guards).
 */
const FLOWS = ['events', 'failures', 'unique_ips', 'auto_bans', 'manual_bans'] as const;
const GAUGES = ['active_bans', 'agents_total', 'agents_connected'] as const;

function columns(knex: Knex, t: Knex.CreateTableBuilder): void {
  t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
  for (const c of FLOWS) t.integer(c).notNullable().defaultTo(0);
  for (const c of GAUGES) t.integer(c).nullable();
  t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('ips_daily_snapshot'))) {
    await knex.schema.createTable('ips_daily_snapshot', (t) => {
      t.increments('id').primary();
      t.date('bucket').notNullable();
      columns(knex, t);
      t.unique(['tenant_id', 'bucket']);
    });
  }
  if (!(await knex.schema.hasTable('ips_hourly_snapshot'))) {
    await knex.schema.createTable('ips_hourly_snapshot', (t) => {
      t.increments('id').primary();
      t.timestamp('bucket', { useTz: true }).notNullable();
      columns(knex, t);
      t.unique(['tenant_id', 'bucket']);
    });
    // Retention sweep (bucket < cutoff) across tenants.
    await knex.schema.alterTable('ips_hourly_snapshot', (t) => { t.index(['bucket']); });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ips_hourly_snapshot');
  await knex.schema.dropTableIfExists('ips_daily_snapshot');
}
