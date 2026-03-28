import type { Knex } from 'knex';

/**
 * Migration 016 — Add OPNsense built-in service templates.
 *
 * Two new services:
 *   - opnsense:        Web UI / API authentication failures (system.log)
 *   - opnsense_filter:  pf filterlog — blocked connections + NAT pass-throughs (filter.log)
 */
export async function up(knex: Knex): Promise<void> {
  // Only insert if not already present (idempotent for existing installs)
  const existing = await knex('service_templates')
    .whereIn('service_type', ['opnsense', 'opnsense_filter'])
    .select('service_type');

  const existingTypes = new Set(existing.map((r) => r.service_type));

  const toInsert: Array<Record<string, unknown>> = [];

  if (!existingTypes.has('opnsense')) {
    toInsert.push({
      name: 'OPNsense Web UI',
      service_type: 'opnsense',
      is_builtin: true,
      threshold: 5,
      window_seconds: 300,
      mode: 'ban',
      enabled: true,
    });
  }

  if (!existingTypes.has('opnsense_filter')) {
    toInsert.push({
      name: 'OPNsense Firewall (NAT/Block)',
      service_type: 'opnsense_filter',
      is_builtin: true,
      threshold: 30,
      window_seconds: 60,
      mode: 'track',
      enabled: true,
    });
  }

  if (toInsert.length > 0) {
    await knex('service_templates').insert(toInsert);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('service_templates')
    .whereIn('service_type', ['opnsense', 'opnsense_filter'])
    .where('is_builtin', true)
    .del();
}
