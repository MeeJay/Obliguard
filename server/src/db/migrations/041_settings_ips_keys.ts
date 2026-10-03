import type { Knex } from 'knex';

/**
 * Migration 041 — IPS settings cascade (W13-1, ADMIN-FEATURES-11 / UI-PAGES-FLEET-4).
 *
 * The settings table moves from the Obliview monitor keys (check_interval,
 * retry_interval, ... — read by nothing) to the IPS agent keys resolved over
 * global -> tenant -> group chain -> agent (shared/src/settingsDefaults.ts,
 * services/agentConfig.service.ts):
 *
 *   1. obsolete monitor keys and scopes are deleted;
 *   2. tenant_id is honoured: group rows are re-stamped to their group's
 *      tenant (it defaulted to 1 for every write), orphans dropped; global
 *      rows belong to Default (1);
 *   3. one global row per key (duplicates collapsed: NULL scope_id never
 *      fired the old unique index) and a partial unique index for them;
 *   4. the existing values are copied into settings rows:
 *        app_config 'agent_global_config'     -> global
 *        monitor_groups.agent_group_config    -> group (pushIntervalSeconds -> checkIntervalSeconds)
 *        agent_devices override columns       -> agent
 *      Numbers are clamped to the definitions' bounds. The old storage is KEPT
 *      (mirrored by the write paths until the next release) and its readers
 *      move to the resolver. updatePolicy is NOT migrated: the C17 resolver
 *      keeps its own storage (owner directive). evaluateOnly stays in the
 *      evaluate_only columns (read by the ban engine).
 *
 * Idempotent (ON CONFLICT DO NOTHING). down() drops the migrated rows and the
 * index; the deleted monitor keys are not restored (nothing read them).
 */

const OBSOLETE_KEYS = ['check_interval', 'retry_interval', 'max_retries', 'timeout', 'notification_cooldown', 'heartbeat_retention_days'];
const LEVELS = ['global', 'tenant', 'group', 'agent'];
const MIGRATED_KEYS = ['checkIntervalSeconds', 'maxMissedPushes', 'notificationTypes'];
const GLOBAL_INDEX = 'settings_global_key_uq';

/**
 * Clamp SQL for a jsonb number (NULL when not a number). Clamped as numeric
 * BEFORE the int cast: an out-of-range legacy value must not abort the migration.
 */
function clampNum(expr: string, min: number, max: number): string {
  return `CASE WHEN jsonb_typeof(${expr}) = 'number'
    THEN to_jsonb(LEAST(${max}, GREATEST(${min}, round((${expr})::text::numeric)))::int) END`;
}

/** Notification types: boolean fields only, NULL when none is set. */
function cleanTypes(expr: string): string {
  return `(SELECT CASE WHEN count(*) > 0 THEN jsonb_object_agg(f.key, f.value) END
             FROM jsonb_each(CASE WHEN jsonb_typeof(${expr}) = 'object' THEN ${expr} ELSE '{}'::jsonb END) AS f
            WHERE f.key IN ('global', 'down', 'up', 'threat', 'attack') AND jsonb_typeof(f.value) = 'boolean')`;
}

export async function up(knex: Knex): Promise<void> {
  // 1. Obsolete monitor keys / scopes.
  const obsolete = await knex('settings')
    .whereIn('key', OBSOLETE_KEYS)
    .orWhereNotIn('scope', LEVELS)
    .del();
  if (obsolete) console.warn(`[migration 041] settings: ${obsolete} obsolete monitor setting row(s) deleted`);

  // 2. Owning tenant: group rows follow their group, global rows are Default's.
  await knex.raw(
    `UPDATE settings AS s SET tenant_id = g.tenant_id
       FROM monitor_groups AS g
      WHERE s.scope = 'group' AND s.scope_id = g.id AND s.tenant_id IS DISTINCT FROM g.tenant_id`,
  );
  await knex.raw(`DELETE FROM settings AS s WHERE s.scope = 'group' AND NOT EXISTS (SELECT 1 FROM monitor_groups g WHERE g.id = s.scope_id)`);
  await knex.raw(`UPDATE settings SET tenant_id = 1 WHERE scope = 'global' AND tenant_id <> 1`);

  // 3. One global row per key (the newest wins), then a unique index for them.
  await knex.raw(
    `DELETE FROM settings AS s USING settings AS n
      WHERE s.scope = 'global' AND n.scope = 'global' AND s.scope_id IS NULL AND n.scope_id IS NULL
        AND s.key = n.key AND (s.updated_at, s.id) < (n.updated_at, n.id)`,
  );
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${GLOBAL_INDEX} ON settings (scope, key) WHERE scope_id IS NULL`);
  await knex.raw('CREATE INDEX IF NOT EXISTS settings_tenant_idx ON settings (tenant_id)');

  // 4a. Global defaults (app_config text JSON; an unreadable value is skipped).
  const cfgRow = await knex('app_config').where({ key: 'agent_global_config' }).first('value') as { value: string | null } | undefined;
  let globalCfg: Record<string, unknown> | null = null;
  try { globalCfg = cfgRow?.value ? JSON.parse(cfgRow.value) as Record<string, unknown> : null; } catch { globalCfg = null; }
  if (globalCfg && typeof globalCfg === 'object') {
    await knex.raw(
      `INSERT INTO settings (scope, scope_id, key, value, tenant_id, created_at, updated_at)
       SELECT 'global', NULL, k.key, k.value, 1, NOW(), NOW()
         FROM (VALUES
           ('checkIntervalSeconds', ${clampNum('?::jsonb', 10, 86400)}),
           ('maxMissedPushes',      ${clampNum('?::jsonb', 1, 20)}),
           ('notificationTypes',    ${cleanTypes('?::jsonb')})
         ) AS k(key, value)
        WHERE k.value IS NOT NULL
       ON CONFLICT (scope, key) WHERE scope_id IS NULL DO NOTHING`,
      [
        JSON.stringify(globalCfg.checkIntervalSeconds ?? null), JSON.stringify(globalCfg.checkIntervalSeconds ?? null),
        JSON.stringify(globalCfg.maxMissedPushes ?? null), JSON.stringify(globalCfg.maxMissedPushes ?? null),
        JSON.stringify(globalCfg.notificationTypes ?? null), JSON.stringify(globalCfg.notificationTypes ?? null),
      ],
    );
  }

  // 4b. Group overrides (agent_group_config jsonb).
  const cfg = `(CASE WHEN jsonb_typeof(g.agent_group_config::jsonb) = 'object' THEN g.agent_group_config::jsonb ELSE '{}'::jsonb END)`;
  await knex.raw(
    `INSERT INTO settings (scope, scope_id, key, value, tenant_id, created_at, updated_at)
     SELECT 'group', g.id, k.key, k.value, g.tenant_id, NOW(), NOW()
       FROM monitor_groups AS g
       CROSS JOIN LATERAL (VALUES
         ('checkIntervalSeconds', ${clampNum(`(${cfg} -> 'pushIntervalSeconds')`, 10, 86400)}),
         ('maxMissedPushes',      ${clampNum(`(${cfg} -> 'maxMissedPushes')`, 1, 20)}),
         ('notificationTypes',    ${cleanTypes(`(${cfg} -> 'notificationTypes')`)})
       ) AS k(key, value)
      WHERE g.agent_group_config IS NOT NULL AND k.value IS NOT NULL
     ON CONFLICT (scope, scope_id, key) DO NOTHING`,
  );

  // 4c. Agent overrides (columns). The check interval counts only with override_group_settings.
  await knex.raw(
    `INSERT INTO settings (scope, scope_id, key, value, tenant_id, created_at, updated_at)
     SELECT 'agent', d.id, k.key, k.value, d.tenant_id, NOW(), NOW()
       FROM agent_devices AS d
       CROSS JOIN LATERAL (VALUES
         ('checkIntervalSeconds', CASE WHEN d.override_group_settings AND d.check_interval_seconds IS NOT NULL
            THEN to_jsonb(LEAST(86400, GREATEST(10, d.check_interval_seconds))) END),
         ('maxMissedPushes', CASE WHEN d.agent_max_missed_pushes IS NOT NULL
            THEN to_jsonb(LEAST(20, GREATEST(1, d.agent_max_missed_pushes))) END),
         ('notificationTypes', ${cleanTypes('d.notification_types::jsonb')})
       ) AS k(key, value)
      WHERE k.value IS NOT NULL
     ON CONFLICT (scope, scope_id, key) DO NOTHING`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex('settings').whereIn('key', MIGRATED_KEYS).orWhereIn('scope', ['tenant', 'agent']).del();
  await knex.raw('DROP INDEX IF EXISTS settings_tenant_idx');
  await knex.raw(`DROP INDEX IF EXISTS ${GLOBAL_INDEX}`);
}
