import type { Knex } from 'knex';

/**
 * Migration 037 — ban provenance v2 (W9-1: BROKEN-15, owner decisions 6, 7, 17).
 *
 *   1. ip_bans.origin_ref: where an imported ban comes from, 'blocklist:<id>'
 *      (remote blocklist) or 'mikrotik:<deviceId>' (router address-list
 *      import). Imported bans get the new ban_type 'remote' (ban_type is a
 *      free varchar(20), no CHECK constraint to widen). Indexed for the
 *      per-source reconciliation (active rows only).
 *   2. ip_bans.lift_reason: why a row was deactivated (lift, wipe, expiry,
 *      external_withdraw, remote_sync). The BanEngine lift watermark ignores
 *      'remote_sync' (a source dropping an address is not an operator Lift).
 *   3. remote_blocklists.enforce: a list only creates bans when it enforces.
 *      Existing obli.tools lists keep protecting (true, owner decision 6);
 *      existing URL lists, which never banned before, start listed-only; new lists
 *      created through the API start off (remoteBlocklist.service create).
 *      The column default stays true for rows written outside the API.
 *   4. remote_blocked_ips.status: 'banned' | 'suspicious' as reported by the
 *      source (obli.tools), so an enforcing list bans only 'banned' entries.
 *      Legacy obli.tools rows with no matching obli.tools ban are marked
 *      'suspicious' (that is what the old pull did not ban).
 *   5. mikrotik_credentials.tls_fingerprint: SHA-256 fingerprint of the
 *      router's API-SSL certificate, pinned on first successful login (TOFU,
 *      owner decision 17).
 *   6. GiST index of the active bans as networks (inet_ops): the imports
 *      skip targets an active global ban already covers (network >>=
 *      target), one lookup per imported entry. Without it a big list
 *      (hundreds of thousands of entries) scans every active ban per entry.
 *   7. Legacy imported bans (ban_type 'auto' with the obli.tools / MikroTik
 *      import reasons) become 'remote' so they are never re-shared or counted
 *      as local detections. With exactly one obli.tools list its rows get
 *      that list's origin_ref; otherwise a bare 'blocklist' / 'mikrotik'.
 *
 * Idempotent (hasColumn guards). The down migration turns 'remote' rows back
 * into 'auto' and drops the columns.
 */

const ORIGIN_INDEX = 'idx_ip_bans_origin_ref_active';
const NETWORK_INDEX = 'idx_ip_bans_active_network_gist';
/** Same expression as ban.service networkSql() (the planner matches it). */
const NETWORK_EXPR = 'set_masklen(ip, COALESCE(cidr_prefix, masklen(ip)))';

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('ip_bans', 'origin_ref'))) {
    await knex.schema.alterTable('ip_bans', (t) => {
      t.string('origin_ref', 64).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('ip_bans', 'lift_reason'))) {
    await knex.schema.alterTable('ip_bans', (t) => {
      t.string('lift_reason', 24).nullable();
    });
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${ORIGIN_INDEX} ON ip_bans (origin_ref) WHERE is_active AND origin_ref IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${NETWORK_INDEX} ON ip_bans USING gist ((${NETWORK_EXPR}) inet_ops) WHERE is_active`);

  if (!(await knex.schema.hasColumn('remote_blocklists', 'enforce'))) {
    await knex.schema.alterTable('remote_blocklists', (t) => {
      t.boolean('enforce').notNullable().defaultTo(true);
    });
    // URL lists never created bans before this migration (only the obli.tools
    // pull did): keep them listed-only so an upgrade does not suddenly ban up
    // to 500 000 addresses per list fleet-wide. An admin opts in per list.
    await knex('remote_blocklists').where({ source_type: 'url' }).update({ enforce: false });
  }

  if (!(await knex.schema.hasColumn('remote_blocked_ips', 'status'))) {
    await knex.schema.alterTable('remote_blocked_ips', (t) => {
      t.string('status', 16).notNullable().defaultTo('banned');
    });
    await knex.raw(`
      UPDATE remote_blocked_ips AS ri
         SET status = 'suspicious'
        FROM remote_blocklists AS bl
       WHERE bl.id = ri.blocklist_id
         AND bl.source_type = 'oblitools'
         AND NOT EXISTS (
           SELECT 1 FROM ip_bans b
            WHERE b.reason LIKE 'obli.tools:%'
              AND set_masklen(b.ip, COALESCE(b.cidr_prefix, masklen(b.ip))) = ri.ip
         )
    `);
  }

  if (!(await knex.schema.hasColumn('mikrotik_credentials', 'tls_fingerprint'))) {
    await knex.schema.alterTable('mikrotik_credentials', (t) => {
      t.string('tls_fingerprint', 128).nullable();
    });
  }

  // Legacy imported bans: provenance from their reason text.
  const oblitools = await knex('remote_blocklists').where({ source_type: 'oblitools' }).pluck('id') as number[];
  const oblitoolsRef = oblitools.length === 1 ? `blocklist:${oblitools[0]}` : 'blocklist';
  await knex('ip_bans')
    .where({ ban_type: 'auto' })
    .whereNull('origin_app')
    .where('reason', 'like', 'obli.tools:%')
    .update({ ban_type: 'remote', origin_ref: oblitoolsRef });
  await knex('ip_bans')
    .where({ ban_type: 'auto' })
    .whereNull('origin_app')
    .where('reason', 'like', 'MikroTik import:%')
    .update({ ban_type: 'remote', origin_ref: 'mikrotik' });
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('ip_bans', 'origin_ref')) {
    await knex('ip_bans').where({ ban_type: 'remote' }).update({ ban_type: 'auto' });
  }
  await knex.raw(`DROP INDEX IF EXISTS ${ORIGIN_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${NETWORK_INDEX}`);
  for (const [table, column] of [
    ['ip_bans', 'origin_ref'],
    ['ip_bans', 'lift_reason'],
    ['remote_blocklists', 'enforce'],
    ['remote_blocked_ips', 'status'],
    ['mikrotik_credentials', 'tls_fingerprint'],
  ] as const) {
    if (await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => { t.dropColumn(column); });
    }
  }
}
