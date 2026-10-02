import type { Knex } from 'knex';

/**
 * Migration 029 — ownership of group/agent scope ids (W1-2).
 *
 * Whitelist entries and rate-limit policies scoped to a group or an agent now
 * belong to the tenant owning that group/agent (tenantScope.service). Legacy
 * rows were stamped with the CREATOR's tenant, typically Default (id 1) for a
 * platform admin acting through the god view.
 *
 *   1. Re-stamp: a group/agent row whose tenant_id is NULL or Default is moved
 *      to the tenant owning its target. A row stamped with another tenant
 *      (a tenant writing on a foreign target) is NEVER moved onto the target's
 *      tenant: it stays as is, is no longer delivered (delivery only counts
 *      rows of the agent's own tenant) and the target's tenant may delete it.
 *   2. Rows whose target no longer exists are left untouched (inert). Nothing
 *      is deleted; both anomalies are logged with their ids.
 *   3. ip_whitelist uniqueness becomes (ip, scope, scope_id, tenant_id): two
 *      tenants may whitelist the same address.
 *
 * Idempotent; the down migration restores the old index only (re-stamped
 * tenant ids are kept: the old owner cannot be recovered and is not needed).
 */

const OLD_INDEX = 'CREATE UNIQUE INDEX idx_ip_whitelist_uniq ON ip_whitelist(ip, scope, COALESCE(scope_id, 0))';
const NEW_INDEX = 'CREATE UNIQUE INDEX idx_ip_whitelist_uniq ON ip_whitelist(ip, scope, COALESCE(scope_id, 0), COALESCE(tenant_id, 0))';

const TARGETS = [
  { scope: 'agent', table: 'agent_devices' },
  { scope: 'group', table: 'monitor_groups' },
] as const;

async function restamp(knex: Knex, table: 'ip_whitelist' | 'rate_limit_policies'): Promise<void> {
  if (!(await knex.schema.hasTable(table)) || !(await knex.schema.hasColumn(table, 'tenant_id'))) return;

  for (const { scope, table: target } of TARGETS) {
    const moved = await knex.raw(
      `UPDATE ${table} AS r SET tenant_id = t.tenant_id
         FROM ${target} AS t
        WHERE r.scope = ? AND r.scope_id = t.id
          AND (r.tenant_id IS NULL OR r.tenant_id = 1)
          AND r.tenant_id IS DISTINCT FROM t.tenant_id`,
      [scope],
    ) as { rowCount?: number };
    if (moved.rowCount) {
      console.warn(`[migration 029] ${table}: ${moved.rowCount} ${scope}-scoped row(s) re-stamped to their target tenant`);
    }

    const foreign = await knex.raw(
      `SELECT r.id FROM ${table} AS r JOIN ${target} AS t ON t.id = r.scope_id
        WHERE r.scope = ? AND r.tenant_id IS DISTINCT FROM t.tenant_id`,
      [scope],
    ) as { rows: Array<{ id: number }> };
    if (foreign.rows.length > 0) {
      console.warn(`[migration 029] ${table}: ${scope}-scoped row(s) owned by another tenant than their target, left untouched (no longer delivered): ids ${foreign.rows.map((r) => r.id).join(', ')}`);
    }

    const orphans = await knex.raw(
      `SELECT r.id FROM ${table} AS r
        WHERE r.scope = ? AND NOT EXISTS (SELECT 1 FROM ${target} AS t WHERE t.id = r.scope_id)`,
      [scope],
    ) as { rows: Array<{ id: number }> };
    if (orphans.rows.length > 0) {
      console.warn(`[migration 029] ${table}: ${scope}-scoped row(s) whose target no longer exists, left untouched: ids ${orphans.rows.map((r) => r.id).join(', ')}`);
    }
  }
}

export async function up(knex: Knex): Promise<void> {
  await restamp(knex, 'ip_whitelist');
  await restamp(knex, 'rate_limit_policies');

  await knex.raw('DROP INDEX IF EXISTS idx_ip_whitelist_uniq');
  await knex.raw(NEW_INDEX);
}

export async function down(knex: Knex): Promise<void> {
  // Fails if two tenants now hold the same entry; resolve those rows first.
  await knex.raw('DROP INDEX IF EXISTS idx_ip_whitelist_uniq');
  await knex.raw(OLD_INDEX);
}
