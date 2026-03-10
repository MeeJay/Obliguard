import type { Knex } from 'knex';

/**
 * 005_agent_peer_links.ts
 *
 * Enables agent-to-agent link detection on the NetMap.
 *
 * New table:
 *   agent_ips — stores all RFC-1918 LAN IPs reported by an agent.
 *               Rebuilt on every push (DELETE + INSERT).
 *   (agent_id, ip_address) are UNIQUE so we can do fast reverse-lookups
 *   "which agent owns this LAN IP within this tenant?"
 *
 * Enriched columns on ip_events:
 *   source_agent_id  — FK to agent_devices; set when the source IP belongs to
 *                      another known agent on the same tenant. NULL = unknown.
 *   source_ip_type   — 'lan' or 'wan'; describes how the match was made.
 *
 * New flag on agent_devices:
 *   wan_matching_enabled — user opt-in: "my WAN IP is dedicated / static,
 *                           so treat it like a fingerprint for peer linking".
 *                           Defaults to FALSE.  When TRUE the agent's last-seen
 *                           WAN IP (agent_devices.ip) is used for peer matching
 *                           in addition to LAN IPs.
 */
export async function up(knex: Knex): Promise<void> {
  // ── agent_ips ─────────────────────────────────────────────────────────────
  await knex.schema.createTable('agent_ips', (t) => {
    t.increments('id');
    t.integer('agent_id').notNullable()
      .references('id').inTable('agent_devices').onDelete('CASCADE');
    t.string('ip_address', 45).notNullable(); // up to IPv6 length
    t.unique(['agent_id', 'ip_address']);
  });

  // Index for reverse-lookup: "which agent has this IP?"
  await knex.schema.raw(
    'CREATE INDEX idx_agent_ips_ip ON agent_ips(ip_address)',
  );

  // ── ip_events enrichment ──────────────────────────────────────────────────
  await knex.schema.alterTable('ip_events', (t) => {
    t.integer('source_agent_id').nullable()
      .references('id').inTable('agent_devices').onDelete('SET NULL');
    t.string('source_ip_type', 10).nullable(); // 'lan' | 'wan'
  });

  // ── agent_devices: WAN matching opt-in ───────────────────────────────────
  await knex.schema.alterTable('agent_devices', (t) => {
    t.boolean('wan_matching_enabled').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('wan_matching_enabled');
  });

  await knex.schema.alterTable('ip_events', (t) => {
    t.dropColumn('source_ip_type');
    t.dropColumn('source_agent_id');
  });

  await knex.schema.raw('DROP INDEX IF EXISTS idx_agent_ips_ip');
  await knex.schema.dropTableIfExists('agent_ips');
}
