import type { Knex } from 'knex';

/**
 * A user's favourite workspace. On sign-in the session lands on this tenant
 * when the user can still use it (tenantService.resolveLoginTenant), instead
 * of the lowest-id membership. Nullable = no preference, use the first one.
 * Deleting the tenant clears the preference (ON DELETE SET NULL).
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('users')) {
    if (!(await knex.schema.hasColumn('users', 'preferred_tenant_id'))) {
      await knex.schema.alterTable('users', (t) => {
        t.integer('preferred_tenant_id').nullable().references('id').inTable('tenants').onDelete('SET NULL');
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('users', 'preferred_tenant_id')) {
    await knex.schema.alterTable('users', (t) => {
      t.dropColumn('preferred_tenant_id');
    });
  }
}
