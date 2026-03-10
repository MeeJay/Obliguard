import type { Knex } from 'knex';

/**
 * 004_threat_attack.ts
 *
 * Adds per-device threat/attack status timestamps to agent_devices.
 *
 *   agent_devices.last_threat_at  timestamptz NULL — set when an IP from this agent turns suspicious
 *   agent_devices.last_attack_at  timestamptz NULL — set when an IP is banned from this agent's activity
 *
 * These are used by the frontend to display a visual indicator that clears after
 * 3 min (threat) or 10 min (attack) without new events.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.timestamp('last_threat_at', { useTz: true }).nullable();
    t.timestamp('last_attack_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('last_attack_at');
    t.dropColumn('last_threat_at');
  });
}
