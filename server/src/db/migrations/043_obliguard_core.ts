import type { Knex } from 'knex';

/**
 * Migration 043 — Obliguard core tables.
 *
 * Adds:
 *  - service_templates          : global/tenant-scoped log-parser definitions (built-in + custom)
 *  - service_template_assignments: per-group or per-agent overrides (log_path, threshold, etc.)
 *  - ip_events                  : raw failed-auth events pushed by agents
 *  - ip_reputation              : aggregated per-IP stats (updated by BanEngine)
 *  - ip_bans                    : active / expired bans (auto or manual, global or scoped)
 *  - ip_whitelist               : trusted CIDR ranges (overrides bans)
 *
 * Inheritance for service configs mirrors Obliview settings:
 *   agent assignment > group assignment > template defaults
 */
export async function up(knex: Knex): Promise<void> {

  // ── 1. service_templates ──────────────────────────────────────────────────
  await knex.schema.createTable('service_templates', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();
    // Known types: 'ssh','rdp','nginx','apache','iis','ftp','mail','mysql','custom'
    t.string('service_type', 50).notNullable();
    // true  = regex baked into agent binary (built-in parser)
    // false = custom_regex required
    t.boolean('is_builtin').notNullable().defaultTo(false);
    t.text('default_log_path').nullable();
    // Named groups: (?P<ip>...) (?P<username>...)
    // NULL for built-in templates (agent handles parsing internally)
    t.text('custom_regex').nullable();
    t.integer('threshold').notNullable().defaultTo(5);
    t.integer('window_seconds').notNullable().defaultTo(300);
    t.boolean('enabled').notNullable().defaultTo(true);
    // NULL = platform-wide (all tenants); non-null = tenant-scoped custom template
    t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  // ── 2. service_template_assignments ───────────────────────────────────────
  await knex.schema.createTable('service_template_assignments', (t) => {
    t.increments('id').primary();
    t.integer('template_id').notNullable().references('id').inTable('service_templates').onDelete('CASCADE');
    t.string('scope', 20).notNullable();   // 'group' | 'agent'
    t.integer('scope_id').notNullable();   // group_id or agent_devices.id
    // Per-field overrides — NULL means inherit from template (or nearest group override)
    t.text('log_path_override').nullable();
    t.integer('threshold_override').nullable();
    t.integer('window_seconds_override').nullable();
    t.boolean('enabled_override').nullable();
    // When true, agent will include last 50 lines of the log file in its next push
    t.boolean('sample_requested').notNullable().defaultTo(false);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['template_id', 'scope', 'scope_id']);
    t.index(['scope', 'scope_id']);
  });

  // ── 3. ip_events ──────────────────────────────────────────────────────────
  await knex.schema.createTable('ip_events', (t) => {
    t.bigIncrements('id').primary();
    t.integer('device_id').nullable().references('id').inTable('agent_devices').onDelete('CASCADE');
    t.specificType('ip', 'inet').notNullable();
    t.string('username', 255).nullable();
    t.string('service', 50).notNullable();   // 'ssh', 'rdp', 'nginx', 'custom:42', …
    // 'auth_failure' | 'auth_success' | 'port_scan'
    t.string('event_type', 20).notNullable().defaultTo('auth_failure');
    t.timestamp('timestamp', { useTz: true }).notNullable();
    t.text('raw_log').nullable();
    t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw('CREATE INDEX idx_ip_events_ip ON ip_events(ip)');
  await knex.schema.raw('CREATE INDEX idx_ip_events_device ON ip_events(device_id)');
  await knex.schema.raw('CREATE INDEX idx_ip_events_timestamp ON ip_events(timestamp DESC)');
  await knex.schema.raw('CREATE INDEX idx_ip_events_tenant ON ip_events(tenant_id)');
  await knex.schema.raw('CREATE INDEX idx_ip_events_event_type ON ip_events(event_type)');

  // ── 4. ip_reputation ──────────────────────────────────────────────────────
  await knex.schema.createTable('ip_reputation', (t) => {
    t.specificType('ip', 'inet').primary();
    t.bigInteger('total_failures').notNullable().defaultTo(0);
    t.bigInteger('total_successes').notNullable().defaultTo(0);
    t.integer('affected_agents_count').notNullable().defaultTo(0);
    t.specificType('affected_services', 'text[]').nullable();
    t.specificType('attempted_usernames', 'text[]').nullable();
    t.timestamp('first_seen', { useTz: true }).nullable();
    t.timestamp('last_seen', { useTz: true }).nullable();
    t.integer('last_event_device_id').nullable();
    t.string('geo_country_code', 2).nullable();
    t.string('geo_city', 100).nullable();
    t.string('asn', 200).nullable();
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // ── 5. ip_bans ────────────────────────────────────────────────────────────
  await knex.schema.createTable('ip_bans', (t) => {
    t.increments('id').primary();
    t.specificType('ip', 'inet').notNullable();
    // Optional CIDR prefix for subnet bans (e.g. 24 → ban the whole /24)
    t.integer('cidr_prefix').nullable();
    t.text('reason').nullable();
    // 'auto' = created by BanEngine, 'manual' = created by a user
    t.string('ban_type', 20).notNullable().defaultTo('auto');
    // 'global' | 'tenant' | 'group' | 'agent'
    t.string('scope', 20).notNullable().defaultTo('global');
    // NULL for scope='global'; tenant/group/agent id otherwise
    t.integer('scope_id').nullable();
    // Owning tenant (for tenant-scoped bans)
    t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
    // Which tenant's agent first triggered this auto-ban (visible to admin global only)
    t.integer('origin_tenant_id').nullable().references('id').inTable('tenants').onDelete('SET NULL');
    t.integer('banned_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('banned_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // NULL = permanent
    t.timestamp('expires_at', { useTz: true }).nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
  });

  await knex.schema.raw('CREATE INDEX idx_ip_bans_active ON ip_bans(ip) WHERE is_active = true');
  await knex.schema.raw('CREATE INDEX idx_ip_bans_scope ON ip_bans(scope, scope_id) WHERE is_active = true');
  await knex.schema.raw('CREATE INDEX idx_ip_bans_expires ON ip_bans(expires_at) WHERE is_active = true AND expires_at IS NOT NULL');

  // ── 6. ip_whitelist ───────────────────────────────────────────────────────
  await knex.schema.createTable('ip_whitelist', (t) => {
    t.increments('id').primary();
    // Stored as CIDR (supports both single IPs like 1.2.3.4/32 and ranges like 192.168.0.0/24)
    t.specificType('ip', 'cidr').notNullable();
    t.string('label', 255).nullable();
    // 'global' | 'tenant' | 'group' | 'agent'
    t.string('scope', 20).notNullable().defaultTo('global');
    t.integer('scope_id').nullable();
    t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw('CREATE UNIQUE INDEX idx_ip_whitelist_uniq ON ip_whitelist(ip, scope, COALESCE(scope_id, 0))');
  await knex.schema.raw('CREATE INDEX idx_ip_whitelist_scope ON ip_whitelist(scope, scope_id)');

  // ── 7. Seed built-in service templates (platform-wide, no tenant) ─────────
  await knex('service_templates').insert([
    { name: 'SSH',              service_type: 'ssh',    is_builtin: true, threshold: 5,  window_seconds: 300 },
    { name: 'RDP',              service_type: 'rdp',    is_builtin: true, threshold: 3,  window_seconds: 300 },
    { name: 'Nginx',            service_type: 'nginx',  is_builtin: true, threshold: 20, window_seconds: 60  },
    { name: 'Apache',           service_type: 'apache', is_builtin: true, threshold: 20, window_seconds: 60  },
    { name: 'IIS',              service_type: 'iis',    is_builtin: true, threshold: 20, window_seconds: 60  },
    { name: 'FTP',              service_type: 'ftp',    is_builtin: true, threshold: 5,  window_seconds: 300 },
    { name: 'Mail (SMTP/IMAP)', service_type: 'mail',   is_builtin: true, threshold: 5,  window_seconds: 300 },
    { name: 'MySQL',            service_type: 'mysql',  is_builtin: true, threshold: 5,  window_seconds: 300 },
  ]);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ip_whitelist');
  await knex.schema.dropTableIfExists('ip_bans');
  await knex.schema.dropTableIfExists('ip_reputation');
  await knex.schema.dropTableIfExists('ip_events');
  await knex.schema.dropTableIfExists('service_template_assignments');
  await knex.schema.dropTableIfExists('service_templates');
}
