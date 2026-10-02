import type { Knex } from 'knex';

/**
 * Migration 032 — ban lifecycle (W3-1 / D4).
 *
 *   1. ip_bans.lifted_at: when a ban was deactivated (Lift, wipe, expiry,
 *      external withdraw). The BanEngine only counts auth failures newer than
 *      the latest global lift of an address, so a Lift is not undone by the
 *      next 30 s cycle. Indexed on (ip, lifted_at DESC) for that lookup.
 *   2. Dedupe active duplicates: per (ip, prefix, scope, scope_id, tenant_id)
 *      the oldest active row is kept. Its expiry becomes the longest of the
 *      group (permanent wins), and the per-tenant exclusions of the other rows
 *      are re-pointed to it BEFORE they are deleted (exclusions are ON DELETE
 *      CASCADE, 006).
 *   3. A partial unique index then allows one active row per key. The prefix
 *      is part of the key: a single address and the subnet starting at the
 *      same address are different bans (ip holds the network address, the
 *      prefix lives in cidr_prefix, legacy rows may carry it in the mask).
 *
 * Idempotent. The down migration drops the index and the column (deleted
 * duplicates are not restored).
 */

const KEY = 'ip, COALESCE(cidr_prefix, masklen(ip)), scope, COALESCE(scope_id, 0), COALESCE(tenant_id, 0)';
const UNIQUE_INDEX = 'idx_ip_bans_active_uniq';
const LIFTED_INDEX = 'idx_ip_bans_ip_lifted';

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('ip_bans', 'lifted_at'))) {
    await knex.schema.alterTable('ip_bans', (t) => {
      t.timestamp('lifted_at', { useTz: true }).nullable();
    });
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${LIFTED_INDEX} ON ip_bans (ip, lifted_at DESC)`);

  // Duplicates of the oldest active row of each key.
  await knex.raw('DROP TABLE IF EXISTS _ban_dedupe');
  await knex.raw(`
    CREATE TEMP TABLE _ban_dedupe AS
    SELECT id, keep_id FROM (
      SELECT id,
             first_value(id) OVER w AS keep_id,
             row_number()    OVER w AS rn
        FROM ip_bans
       WHERE is_active
      WINDOW w AS (PARTITION BY ${KEY} ORDER BY banned_at ASC, id ASC)
    ) ranked
    WHERE rn > 1
  `);

  const { rows: [{ count }] } = await knex.raw('SELECT count(*)::int AS count FROM _ban_dedupe') as { rows: Array<{ count: number }> };
  if (count > 0) {
    // The kept row covers the longest window of its duplicates (NULL = permanent).
    await knex.raw(`
      UPDATE ip_bans AS k
         SET expires_at = CASE WHEN a.any_permanent THEN NULL ELSE a.max_expires END
        FROM (
          SELECT d.keep_id,
                 bool_or(b.expires_at IS NULL) AS any_permanent,
                 max(b.expires_at)             AS max_expires
            FROM _ban_dedupe d
            JOIN ip_bans b ON b.id = d.id
           GROUP BY d.keep_id
        ) AS a
       WHERE k.id = a.keep_id
         AND k.expires_at IS NOT NULL
         AND (a.any_permanent OR a.max_expires > k.expires_at)
    `);

    // Exclusions follow the kept row before the duplicates (and their cascade) go.
    await knex.raw(`
      INSERT INTO ip_ban_exclusions (ban_id, tenant_id, created_by, created_at)
      SELECT d.keep_id, e.tenant_id, e.created_by, e.created_at
        FROM ip_ban_exclusions e
        JOIN _ban_dedupe d ON d.id = e.ban_id
      ON CONFLICT (ban_id, tenant_id) DO NOTHING
    `);

    await knex.raw('DELETE FROM ip_bans WHERE id IN (SELECT id FROM _ban_dedupe)');
    console.warn(`[migration 032] ip_bans: removed ${count} duplicate active ban row(s)`);
  }
  await knex.raw('DROP TABLE IF EXISTS _ban_dedupe');

  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ip_bans (${KEY}) WHERE is_active`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS ${UNIQUE_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${LIFTED_INDEX}`);
  if (await knex.schema.hasColumn('ip_bans', 'lifted_at')) {
    await knex.schema.alterTable('ip_bans', (t) => {
      t.dropColumn('lifted_at');
    });
  }
}
