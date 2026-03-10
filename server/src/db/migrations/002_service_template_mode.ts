import type { Knex } from 'knex';

/**
 * 002_service_template_mode.ts
 *
 * Adds:
 *   - service_templates.mode  varchar(20) DEFAULT 'ban'
 *       'ban'   = events trigger the BanEngine as before
 *       'track' = events are stored for visibility/reputation but NOT counted for bans
 *
 *   - ip_events.track_only  boolean DEFAULT false
 *       Set to true when the event was matched by a 'track' mode template.
 *       BanEngine ignores rows where track_only = true.
 */
export async function up(knex: Knex): Promise<void> {
  // service_templates: add mode column
  await knex.schema.alterTable('service_templates', (t) => {
    t.string('mode', 20).notNullable().defaultTo('ban');
  });

  // ip_events: add track_only column
  await knex.schema.alterTable('ip_events', (t) => {
    t.boolean('track_only').notNullable().defaultTo(false);
  });

  // Index to help BanEngine skip track-only rows efficiently
  await knex.schema.raw(
    'CREATE INDEX idx_ip_events_track_only ON ip_events(track_only) WHERE track_only = false',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP INDEX IF EXISTS idx_ip_events_track_only');

  await knex.schema.alterTable('ip_events', (t) => {
    t.dropColumn('track_only');
  });

  await knex.schema.alterTable('service_templates', (t) => {
    t.dropColumn('mode');
  });
}
