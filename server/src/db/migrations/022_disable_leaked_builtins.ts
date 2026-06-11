import type { Knex } from 'knex';

/**
 * 022_disable_leaked_builtins.ts
 *
 * Re-asserts the opt-in invariant established by migration 007 for the built-in
 * templates that "leaked" past it.
 *
 * Migration 007 disabled all global templates (owner_scope IS NULL) so they
 * became opt-in. But built-ins SEEDED AFTER 007 were inserted with enabled=true
 * and were never re-disabled:
 *   - 016: opnsense (mode=ban), opnsense_filter (mode=track)
 *   - 017: mikrotik_ssh, mikrotik_winbox, mikrotik_web (all mode=ban)
 *
 * Consequence: these services auto-ban (or track) on every install with NO
 * operator action, breaking the "no template enabled ⇒ no enforcement" model.
 *
 * This migration disables ONLY those specific leaked service_types at the GLOBAL
 * level. It is deliberately surgical:
 *   - The original 8 built-ins (ssh, rdp, nginx, apache, iis, ftp, mail, mysql)
 *     are NOT touched — any intentional global enable of those is preserved.
 *   - service_template_assignments (group/agent enabled_override = the "bind"
 *     mechanism) are NEVER touched — intentional per-scope binds survive.
 *
 * To use opnsense / mikrotik after this, bind them like any other built-in:
 * enable globally in Service Templates, or add a group/agent assignment.
 */
const LEAKED_GLOBAL_BUILTINS = [
  'opnsense',
  'opnsense_filter',
  'mikrotik_ssh',
  'mikrotik_winbox',
  'mikrotik_web',
];

export async function up(knex: Knex): Promise<void> {
  await knex('service_templates')
    .whereNull('owner_scope') // global/platform built-ins only
    .whereIn('service_type', LEAKED_GLOBAL_BUILTINS)
    .update({ enabled: false });
}

export async function down(knex: Knex): Promise<void> {
  // Revert to the leaked (always-on) state these built-ins shipped with.
  await knex('service_templates')
    .whereNull('owner_scope')
    .whereIn('service_type', LEAKED_GLOBAL_BUILTINS)
    .update({ enabled: true });
}
