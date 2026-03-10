import type { Knex } from 'knex';

/**
 * 003_local_templates.ts
 *
 * Adds per-agent and per-group "local" templates to service_templates.
 *
 *   service_templates.owner_scope   varchar(20) NULL  — 'agent' | 'group' | NULL (global)
 *   service_templates.owner_scope_id integer    NULL  — agent_devices.id or monitor_groups.id
 *
 * Local templates:
 *  - Visible only on the owning agent/group detail page (not in the global list)
 *  - Automatically assigned to their owner on creation
 *  - Scoped to a single tenant (existing tenant_id column handles this)
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('service_templates', (t) => {
    t.string('owner_scope', 20).nullable();   // 'agent' | 'group' | null
    t.integer('owner_scope_id').nullable();   // FK to agent_devices.id or monitor_groups.id
  });

  await knex.schema.raw(
    'CREATE INDEX idx_service_templates_owner ON service_templates(owner_scope, owner_scope_id) WHERE owner_scope IS NOT NULL',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP INDEX IF EXISTS idx_service_templates_owner');
  await knex.schema.alterTable('service_templates', (t) => {
    t.dropColumn('owner_scope_id');
    t.dropColumn('owner_scope');
  });
}
