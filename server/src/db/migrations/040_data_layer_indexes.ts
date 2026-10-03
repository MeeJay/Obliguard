import type { Knex } from 'knex';

/**
 * 040_data_layer_indexes.ts (W12-1 / DATA-REALTIME-16)
 *
 * Composite indexes for the tenant / time hot paths, built CONCURRENTLY so a
 * large ip_events table keeps taking agent inserts during the upgrade (hence
 * `transaction: false`: CREATE / DROP INDEX CONCURRENTLY cannot run inside a
 * transaction, and each statement goes alone).
 *
 *  - ip_events (tenant_id, timestamp DESC): LiveEvents, dashboard "today",
 *    NetMap: tenant-scoped reads ordered by time;
 *  - ip_events (device_id, timestamp DESC): per-agent timelines, and the
 *    agent_devices ON DELETE CASCADE lookup;
 *  - ip_reputation (last_seen DESC NULLS LAST) and (total_failures DESC): the
 *    IP reputation list sorts, and the retention purge (last_seen < cutoff);
 *  - ip_bans (banned_at DESC) WHERE is_active: active ban lists, newest first
 *    (ip_bans has no created_at: banned_at is its creation time).
 *
 * Then the low-value single-column indexes go: idx_ip_events_event_type (a
 * handful of distinct values, never selective, paid on every insert),
 * idx_ip_events_device and idx_ip_events_tenant (each the exact prefix of a
 * composite above, which serves the same lookups and the CASCADE deletes).
 *
 * An interrupted CONCURRENTLY build leaves an INVALID index that IF NOT
 * EXISTS would then skip: such leftovers are dropped and rebuilt.
 */
export const config = { transaction: false };

const CREATED: ReadonlyArray<{ name: string; def: string }> = [
  { name: 'idx_ip_events_tenant_ts',          def: 'ON ip_events (tenant_id, "timestamp" DESC)' },
  { name: 'idx_ip_events_device_ts',          def: 'ON ip_events (device_id, "timestamp" DESC)' },
  { name: 'idx_ip_reputation_last_seen',      def: 'ON ip_reputation (last_seen DESC NULLS LAST)' },
  { name: 'idx_ip_reputation_total_failures', def: 'ON ip_reputation (total_failures DESC)' },
  { name: 'idx_ip_bans_active_banned_at',     def: 'ON ip_bans (banned_at DESC) WHERE is_active' },
];

/** Indexes made redundant by the composites (definitions kept for down()). */
const DROPPED: ReadonlyArray<{ name: string; def: string }> = [
  { name: 'idx_ip_events_event_type', def: 'ON ip_events (event_type)' },
  { name: 'idx_ip_events_device',     def: 'ON ip_events (device_id)' },
  { name: 'idx_ip_events_tenant',     def: 'ON ip_events (tenant_id)' },
];

async function dropInvalid(knex: Knex, name: string): Promise<void> {
  const res = await knex.raw(
    `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ? AND NOT i.indisvalid`,
    [name],
  ) as { rows: unknown[] };
  if (res.rows.length > 0) await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
}

async function createConcurrently(knex: Knex, name: string, def: string): Promise<void> {
  await dropInvalid(knex, name);
  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ${def}`);
}

export async function up(knex: Knex): Promise<void> {
  for (const { name, def } of CREATED) await createConcurrently(knex, name, def);
  for (const { name } of DROPPED) await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
}

export async function down(knex: Knex): Promise<void> {
  for (const { name, def } of DROPPED) await createConcurrently(knex, name, def);
  for (const { name } of CREATED) await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
}
