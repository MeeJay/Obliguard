import type { Knex } from 'knex';

/**
 * 024_ip_reputation_perf.ts
 *
 * Kills the Postgres CPU hot-spot behind the recurring outages.
 *
 * The per-event ip_reputation upsert recomputed `affected_agents_count` with a
 * correlated subquery:
 *     SELECT COUNT(DISTINCT device_id) FROM ip_events WHERE ip_events.ip = ?
 * That is O(rows-for-that-ip) on EVERY event, and ip_events grows without bound
 * (the connection/auth firehose — millions of rows). Under an active brute force
 * (exactly when an IPS is busiest) it degrades to O(n²) and pins Postgres,
 * starving the connection pool → API timeouts → the UI "loads forever".
 *
 * Fix: maintain the set of devices that have seen each IP INCREMENTALLY in a
 * small `affected_device_ids int[]` column (same array-union trick already used
 * for affected_services / attempted_usernames), so the upsert never touches
 * ip_events again.
 *
 * Plus a composite index for the 30s BanEngine threshold query, which filters
 * ip_events by (device_id, service, event_type, timestamp).
 *
 * No backfill: the column defaults to '{}' (instant ADD COLUMN on PG11+, no
 * table rewrite). affected_agents_count self-heals as new events arrive — we do
 * NOT run a heavy UPDATE across millions of rows on an already-stressed DB.
 */
export async function up(knex: Knex): Promise<void> {
  const hasCol = await knex.schema.hasColumn('ip_reputation', 'affected_device_ids');
  if (!hasCol) {
    // Constant default → metadata-only change, instant even on huge tables.
    await knex.raw(
      `ALTER TABLE ip_reputation ADD COLUMN affected_device_ids integer[] NOT NULL DEFAULT '{}'`,
    );
  }

  // Composite index for BanEngine.evaluateThresholds():
  //   WHERE device_id=? AND service=? AND event_type=? AND timestamp>=? GROUP BY ip
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_ip_events_ban_eval
       ON ip_events (device_id, service, event_type, "timestamp")`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_ip_events_ban_eval');
  const hasCol = await knex.schema.hasColumn('ip_reputation', 'affected_device_ids');
  if (hasCol) {
    await knex.raw('ALTER TABLE ip_reputation DROP COLUMN affected_device_ids');
  }
}
