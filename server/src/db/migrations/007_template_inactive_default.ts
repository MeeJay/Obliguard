import type { Knex } from 'knex';

/**
 * 007_template_inactive_default.ts
 *
 * Switches service templates to an opt-in model.
 *
 * Previously, global templates (owner_scope IS NULL) were enabled=true by default,
 * meaning they applied to ALL agents unless explicitly unbound.
 *
 * After this migration, templates are enabled=false by default.
 * Groups and agents must explicitly activate a template via service_template_assignments
 * (enabled_override = true) for the BanEngine to count events toward auto-bans.
 *
 * This prevents e.g. RDP templates from triggering bans on Linux agents, or nginx
 * templates from triggering bans on personal machines.
 */
export async function up(knex: Knex): Promise<void> {
  // Disable all global (platform-wide) templates — they become opt-in from now on.
  // Tenant-scoped custom templates keep their current enabled state.
  await knex('service_templates')
    .whereNull('owner_scope')  // global templates only
    .update({ enabled: false });
}

export async function down(knex: Knex): Promise<void> {
  // Restore: re-enable all global templates (revert to opt-out model).
  await knex('service_templates')
    .whereNull('owner_scope')
    .update({ enabled: true });
}
