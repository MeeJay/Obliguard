import type { Knex } from 'knex';

/**
 * External ban source support.
 *
 * Other apps in the Obli suite (Oblihub honeypot first) can now push bans directly to
 * Obliguard via `POST /api/external-bans`. When they do, Obliguard needs to know:
 *   - WHICH app made the call (audit, filter, cross-app rules later)
 *   - That the ban_type "external" is legitimate alongside the existing "auto" and "manual"
 *
 * `origin_app` mirrors the delegation token's `sub = "app:<app_type>"` — the middleware strips
 * the `app:` prefix and stores just the app_type. NULL for bans that didn't come from an
 * external source (every existing row).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ip_bans', (t) => {
    t.string('origin_app', 32).nullable();
    t.index('origin_app');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ip_bans', (t) => {
    t.dropIndex('origin_app');
    t.dropColumn('origin_app');
  });
}
