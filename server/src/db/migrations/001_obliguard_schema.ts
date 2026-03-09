import type { Knex } from 'knex';

/**
 * 001_obliguard_schema.ts
 *
 * Consolidated Obliguard schema — single migration representing the final state
 * after all 44 original Obliview → Obliguard migrations.
 *
 * Tables created (in dependency order):
 *   Core auth / multi-tenancy
 *     users, session, password_reset_tokens
 *     tenants, user_tenants
 *
 *   Groups & hierarchy
 *     monitor_groups, group_closure
 *
 *   Teams & RBAC
 *     user_teams, team_memberships, team_permissions
 *
 *   Settings
 *     settings
 *
 *   Notifications
 *     notification_channels, notification_bindings, notification_log,
 *     notification_channel_tenants
 *
 *   Agent system
 *     agent_api_keys, agent_devices, agent_services
 *
 *   Remediations
 *     remediation_actions, remediation_bindings, remediation_runs
 *
 *   Infrastructure / config
 *     smtp_servers, app_config, live_alerts
 *
 *   Obliguard IPS core (migration 043)
 *     service_templates, service_template_assignments
 *     ip_events, ip_reputation, ip_bans, ip_whitelist
 *
 * NOTE: monitors, heartbeats, heartbeat_stats, incidents, maintenance_windows,
 *       maintenance_window_disables, monitor_type enum, and monitor_status enum
 *       are intentionally EXCLUDED — they were dropped in migration 044.
 */

export async function up(knex: Knex): Promise<void> {

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — Core auth tables
  // ══════════════════════════════════════════════════════════════════════════

  // users — local auth, 2FA, preferences, language, enrollment
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('username', 64).notNullable().unique();
    t.string('password_hash', 255).notNullable();
    t.string('display_name', 128).nullable();
    t.string('role', 16).notNullable().defaultTo('user');
    t.boolean('is_active').notNullable().defaultTo(true);

    // 2FA (migration 031)
    t.string('email', 255).nullable();
    t.text('totp_secret').nullable();
    t.boolean('totp_enabled').notNullable().defaultTo(false);
    t.boolean('email_otp_enabled').notNullable().defaultTo(false);

    // User preferences blob (migration 028)
    t.jsonb('preferences').nullable().defaultTo(null);

    // Enrollment wizard version + preferred locale (migration 038)
    t.string('preferred_language', 10).notNullable().defaultTo('en');
    t.integer('enrollment_version').notNullable().defaultTo(0);

    t.timestamps(true, true);
  });

  // session — managed by connect-pg-simple
  await knex.schema.createTable('session', (t) => {
    t.string('sid').primary();
    t.json('sess').notNullable();
    t.timestamp('expire', { useTz: true }).notNullable();
  });
  await knex.schema.raw('CREATE INDEX idx_session_expire ON session(expire)');

  // password_reset_tokens (migration 038)
  await knex.schema.createTable('password_reset_tokens', (t) => {
    t.increments('id').primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('token_hash', 255).notNullable().unique();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — Multi-tenancy
  // ══════════════════════════════════════════════════════════════════════════

  // tenants (migration 039) — created early so all subsequent tables can FK to it
  await knex.schema.createTable('tenants', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('slug', 64).notNullable().unique();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // user_tenants junction (migration 039)
  await knex.schema.createTable('user_tenants', (t) => {
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('role', 16).notNullable().defaultTo('member'); // 'admin' | 'member'
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['user_id', 'tenant_id']);
  });

  // Seed default tenant
  await knex('tenants').insert({ id: 1, name: 'Default', slug: 'default' });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3 — Groups & closure table
  // ══════════════════════════════════════════════════════════════════════════

  // monitor_groups — used for agent groups and generic hierarchy
  // (name kept from Obliview origin; Obliguard reuses this for agent grouping)
  await knex.schema.createTable('monitor_groups', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();
    t.string('slug', 255).notNullable().unique();
    t.text('description').nullable();
    t.integer('parent_id').unsigned().nullable()
      .references('id').inTable('monitor_groups').onDelete('CASCADE');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_general').notNullable().defaultTo(false);

    // Group kind (migration 017): 'monitor' | 'agent'
    t.string('kind', 16).notNullable().defaultTo('monitor');

    // Group-level notification flag (migration 012)
    t.boolean('group_notifications').notNullable().defaultTo(false);

    // Agent group thresholds — default thresholds applied when approving a device (migration 018)
    t.jsonb('agent_thresholds').nullable().defaultTo(null);

    // Agent group config: push interval, heartbeat monitoring, max missed pushes (migration 021)
    t.jsonb('agent_group_config').nullable().defaultTo(null);

    // Export UUID (migration 023)
    t.uuid('uuid').notNullable().defaultTo(knex.raw('gen_random_uuid()')).unique();

    // Tenant isolation (migration 039)
    t.integer('tenant_id').notNullable().defaultTo(1)
      .references('id').inTable('tenants').onDelete('CASCADE');

    t.timestamps(true, true);

    t.index('parent_id');
    t.index('slug');
  });

  // group_closure — closure table for efficient ancestor/descendant queries
  await knex.schema.createTable('group_closure', (t) => {
    t.integer('ancestor_id').unsigned().notNullable()
      .references('id').inTable('monitor_groups').onDelete('CASCADE');
    t.integer('descendant_id').unsigned().notNullable()
      .references('id').inTable('monitor_groups').onDelete('CASCADE');
    t.integer('depth').notNullable();

    t.primary(['ancestor_id', 'descendant_id']);
    t.index('descendant_id');
    t.index('ancestor_id');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4 — Teams & RBAC
  // ══════════════════════════════════════════════════════════════════════════

  // user_teams (migration 013)
  await knex.schema.createTable('user_teams', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable().unique();
    t.text('description').nullable();
    t.boolean('can_create').notNullable().defaultTo(false);

    // Export UUID (migration 023)
    t.uuid('uuid').notNullable().defaultTo(knex.raw('gen_random_uuid()')).unique();

    // Tenant isolation (migration 039)
    t.integer('tenant_id').notNullable().defaultTo(1)
      .references('id').inTable('tenants').onDelete('CASCADE');

    t.timestamps(true, true);
  });

  // team_memberships (migration 013)
  await knex.schema.createTable('team_memberships', (t) => {
    t.integer('team_id').unsigned().notNullable()
      .references('id').inTable('user_teams').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.primary(['team_id', 'user_id']);
  });

  // team_permissions (migration 013)
  await knex.schema.createTable('team_permissions', (t) => {
    t.increments('id').primary();
    t.integer('team_id').unsigned().notNullable()
      .references('id').inTable('user_teams').onDelete('CASCADE');
    t.string('scope', 20).notNullable(); // 'group' or 'monitor'
    t.integer('scope_id').notNullable();
    t.string('level', 5).notNullable(); // 'ro' or 'rw'

    t.unique(['team_id', 'scope', 'scope_id']);
    t.index(['scope', 'scope_id']);
    t.index('team_id');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — Settings
  // ══════════════════════════════════════════════════════════════════════════

  // settings — key/value inheritance store (global / group scopes only in Obliguard)
  await knex.schema.createTable('settings', (t) => {
    t.increments('id').primary();
    t.string('scope', 20).notNullable(); // 'global', 'group'
    t.integer('scope_id').nullable();    // null for global, group_id otherwise
    t.string('key', 100).notNullable();
    t.jsonb('value').notNullable();

    // Tenant isolation (migration 039)
    t.integer('tenant_id').notNullable().defaultTo(1)
      .references('id').inTable('tenants').onDelete('CASCADE');

    t.timestamps(true, true);

    t.unique(['scope', 'scope_id', 'key']);
    t.index(['scope', 'scope_id']);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6 — Notifications
  // ══════════════════════════════════════════════════════════════════════════

  // notification_channels (migration 007 + 023 uuid + 039 tenant_id)
  await knex.schema.createTable('notification_channels', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();
    t.string('type', 50).notNullable(); // plugin type: 'webhook', 'discord', etc.
    t.jsonb('config').notNullable().defaultTo('{}');
    t.boolean('is_enabled').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().nullable()
      .references('id').inTable('users').onDelete('SET NULL');

    // Export UUID (migration 023)
    t.uuid('uuid').notNullable().defaultTo(knex.raw('gen_random_uuid()')).unique();

    // Tenant isolation (migration 039)
    t.integer('tenant_id').notNullable().defaultTo(1)
      .references('id').inTable('tenants').onDelete('CASCADE');

    t.timestamps(true, true);
  });

  // notification_bindings (migration 007)
  await knex.schema.createTable('notification_bindings', (t) => {
    t.increments('id').primary();
    t.integer('channel_id').unsigned().notNullable()
      .references('id').inTable('notification_channels').onDelete('CASCADE');
    t.string('scope', 20).notNullable(); // 'global', 'group'
    t.integer('scope_id').nullable();    // null for global
    t.string('override_mode', 10).notNullable().defaultTo('merge'); // 'merge' | 'replace'

    t.unique(['channel_id', 'scope', 'scope_id']);
    t.index(['scope', 'scope_id']);
  });

  // notification_log (migration 007)
  // Note: monitor_id was present originally but dropped in migration 044 (Obliguard has no monitors)
  await knex.schema.createTable('notification_log', (t) => {
    t.increments('id').primary();
    t.integer('channel_id').unsigned().notNullable()
      .references('id').inTable('notification_channels').onDelete('CASCADE');
    t.string('event_type', 50).notNullable(); // 'status_change', 'test', 'ban', etc.
    t.boolean('success').notNullable();
    t.text('message').nullable();
    t.text('error').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index('channel_id');
    t.index('created_at');
  });

  // notification_channel_tenants — cross-tenant channel sharing (migration 041)
  await knex.schema.createTable('notification_channel_tenants', (t) => {
    t.integer('channel_id').notNullable()
      .references('id').inTable('notification_channels').onDelete('CASCADE');
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['channel_id', 'tenant_id']);
  });
  await knex.schema.raw('CREATE INDEX nct_channel_id ON notification_channel_tenants(channel_id)');
  await knex.schema.raw('CREATE INDEX nct_tenant_id ON notification_channel_tenants(tenant_id)');

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 7 — Agent system
  // ══════════════════════════════════════════════════════════════════════════

  // agent_api_keys (migration 014)
  await knex.schema.createTable('agent_api_keys', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();
    t.uuid('key').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    t.integer('created_by').unsigned().nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_used_at').nullable();

    // Tenant isolation (migration 039)
    t.integer('tenant_id').notNullable().defaultTo(1)
      .references('id').inTable('tenants').onDelete('CASCADE');

    t.index('key');
  });

  // agent_devices — registered agents with all accumulated columns
  // Migrations: 015 (base), 019 (name+heartbeat_monitoring), 021 (agent_max_missed_pushes),
  //             025 (sensor_display_names), 026 (override_group_settings), 032 (display_config),
  //             033 (pending_command + uninstall_commanded_at), 040 (updating_since),
  //             042 (notification_types), 039 (tenant_id)
  await knex.schema.createTable('agent_devices', (t) => {
    t.increments('id').primary();

    // Unique machine identifier (UUID generated by the agent on first run)
    t.string('uuid', 64).notNullable().unique();

    t.string('hostname', 255).notNullable();

    // Custom display name (shown instead of hostname when set) (migration 019)
    t.string('name', 255).nullable().defaultTo(null);

    t.string('ip', 45).nullable();
    t.jsonb('os_info').nullable(); // { platform, distro, release, arch }
    t.string('agent_version', 32).nullable();

    // Which API key was used to register this device (null if key deleted)
    t.integer('api_key_id').unsigned().nullable()
      .references('id').inTable('agent_api_keys').onDelete('SET NULL');

    // pending | approved | refused
    t.string('status', 16).notNullable().defaultTo('pending');

    // Config pushed to the agent in each push response
    t.integer('check_interval_seconds').notNullable().defaultTo(60);

    // Approval tracking
    t.integer('approved_by').unsigned().nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('approved_at').nullable();

    // Optional agent group assignment
    t.integer('group_id').unsigned().nullable()
      .references('id').inTable('monitor_groups').onDelete('SET NULL');

    // heartbeat_monitoring: false → offline = 'inactive' (grey), no notification (migration 019)
    t.boolean('heartbeat_monitoring').notNullable().defaultTo(true);

    // Per-device max missed pushes override (null = use group/system default) (migration 021)
    t.integer('agent_max_missed_pushes').nullable().defaultTo(null);

    // Friendly names for temperature sensor keys (migration 025)
    t.jsonb('sensor_display_names').nullable().defaultTo(null);

    // Override flag for group-inherited settings (migration 026)
    t.boolean('override_group_settings').notNullable().defaultTo(false);

    // Per-device UI display preferences (migration 032)
    t.jsonb('display_config').nullable().defaultTo(null);

    // Command queued by admin, delivered on next push (migration 033)
    t.string('pending_command', 50).nullable().defaultTo(null);
    t.timestamp('uninstall_commanded_at').nullable().defaultTo(null);

    // Set when agent is about to self-update; cleared on reconnect (migration 040)
    t.timestamp('updating_since', { useTz: true }).nullable().defaultTo(null);

    // Per-device notification type overrides (migration 042)
    // null = inherit from group; non-null = device-level override
    t.jsonb('notification_types').nullable();

    // Tenant isolation (migration 039)
    t.integer('tenant_id').notNullable().defaultTo(1)
      .references('id').inTable('tenants').onDelete('CASCADE');

    t.timestamps(true, true);

    t.index('status');
    t.index('api_key_id');
  });

  // agent_services — auto-detected services running on each device
  // (referenced in agent.service.ts; columns derived from usage)
  await knex.schema.createTable('agent_services', (t) => {
    t.increments('id').primary();
    t.integer('device_id').unsigned().notNullable()
      .references('id').inTable('agent_devices').onDelete('CASCADE');
    t.string('service_type', 50).notNullable(); // 'ssh', 'rdp', 'nginx', 'custom:42', …
    t.integer('port').nullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('last_seen_at', { useTz: true }).nullable();

    t.unique(['device_id', 'service_type']);
    t.index('device_id');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 8 — Remediations
  // ══════════════════════════════════════════════════════════════════════════

  // remediation_actions (migration 024 + 027 uuid + 039 tenant_id)
  await knex.schema.createTable('remediation_actions', (t) => {
    t.increments('id').primary();
    t.string('name', 100).notNullable();
    t.string('type', 30).notNullable(); // webhook | n8n | script | docker_restart | ssh
    t.jsonb('config').notNullable().defaultTo('{}');
    t.boolean('enabled').notNullable().defaultTo(true);

    // Export UUID (migration 027)
    t.uuid('uuid').notNullable().defaultTo(knex.raw('gen_random_uuid()')).unique();

    // Tenant isolation (migration 039)
    t.integer('tenant_id').notNullable().defaultTo(1)
      .references('id').inTable('tenants').onDelete('CASCADE');

    t.timestamps(true, true);
  });

  // remediation_bindings (migration 024)
  await knex.schema.createTable('remediation_bindings', (t) => {
    t.increments('id').primary();
    t.integer('action_id').unsigned().notNullable()
      .references('id').inTable('remediation_actions').onDelete('CASCADE');
    t.string('scope', 20).notNullable(); // global | group | agent
    t.integer('scope_id').nullable();
    t.string('override_mode', 20).notNullable().defaultTo('merge'); // merge | replace | exclude
    t.string('trigger_on', 20).notNullable().defaultTo('down');     // down | up | both
    t.integer('cooldown_seconds').notNullable().defaultTo(300);

    t.unique(['action_id', 'scope', 'scope_id']);
    t.index(['scope', 'scope_id']);
  });

  // remediation_runs — audit log of every execution attempt (migration 024)
  await knex.schema.createTable('remediation_runs', (t) => {
    t.increments('id').primary();
    t.integer('action_id').unsigned().notNullable()
      .references('id').inTable('remediation_actions').onDelete('CASCADE');
    t.integer('monitor_id').unsigned().notNullable(); // kept as generic "scope entity id"
    t.string('triggered_by', 10).notNullable(); // down | up
    t.string('status', 20).notNullable();       // success | failed | timeout | cooldown_skip
    t.text('output').nullable();
    t.text('error').nullable();
    t.integer('duration_ms').nullable();
    t.timestamp('triggered_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['monitor_id', 'triggered_at']);
    t.index(['action_id', 'triggered_at']);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 9 — Infrastructure / config
  // ══════════════════════════════════════════════════════════════════════════

  // smtp_servers (migration 029 + 039 tenant_id)
  // tenant_id NULL = platform-level; non-null = tenant-scoped
  await knex.schema.createTable('smtp_servers', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('host', 255).notNullable();
    t.integer('port').notNullable().defaultTo(587);
    t.boolean('secure').notNullable().defaultTo(false);
    t.string('username', 255).notNullable();
    t.string('password', 255).notNullable();
    t.string('from_address', 255).notNullable();
    t.integer('tenant_id').nullable()
      .references('id').inTable('tenants').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  // app_config — simple key/value store for platform settings (migration 030)
  await knex.schema.createTable('app_config', (t) => {
    t.string('key', 64).primary();
    t.text('value').notNullable();
  });

  // Default app_config values
  await knex('app_config').insert([
    { key: 'allow_2fa',         value: 'false' },
    { key: 'force_2fa',         value: 'false' },
    { key: 'otp_smtp_server_id', value: '' },
  ]);

  // live_alerts — real-time alert feed per tenant (migration 040_live_alerts)
  await knex.schema.createTable('live_alerts', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.string('severity', 16).notNullable(); // 'down' | 'up' | 'warning' | 'info'
    t.text('title').notNullable();
    t.text('message').notNullable();
    t.text('navigate_to').nullable();
    // dedup: skip if unread + same (tenant_id, stable_key)
    t.text('stable_key').nullable();
    t.timestamp('read_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.raw('CREATE INDEX live_alerts_tenant_created ON live_alerts(tenant_id, created_at DESC)');
  await knex.schema.raw('CREATE INDEX live_alerts_stable_key ON live_alerts(tenant_id, stable_key) WHERE stable_key IS NOT NULL');

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 10 — Obliguard IPS core (migration 043)
  // ══════════════════════════════════════════════════════════════════════════

  // service_templates — global/tenant-scoped log-parser definitions
  await knex.schema.createTable('service_templates', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();
    // Known types: 'ssh','rdp','nginx','apache','iis','ftp','mail','mysql','custom'
    t.string('service_type', 50).notNullable();
    // true = regex baked into agent binary (built-in parser)
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
    t.integer('tenant_id').nullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('created_by').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  // service_template_assignments — per-group or per-agent overrides
  await knex.schema.createTable('service_template_assignments', (t) => {
    t.increments('id').primary();
    t.integer('template_id').notNullable()
      .references('id').inTable('service_templates').onDelete('CASCADE');
    t.string('scope', 20).notNullable();  // 'group' | 'agent'
    t.integer('scope_id').notNullable();  // group_id or agent_devices.id
    // Per-field overrides — NULL means inherit from template (or nearest group override)
    t.text('log_path_override').nullable();
    t.integer('threshold_override').nullable();
    t.integer('window_seconds_override').nullable();
    t.boolean('enabled_override').nullable();
    // When true, agent will include last 50 lines of log in its next push
    t.boolean('sample_requested').notNullable().defaultTo(false);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['template_id', 'scope', 'scope_id']);
    t.index(['scope', 'scope_id']);
  });

  // ip_events — raw failed-auth events pushed by agents
  await knex.schema.createTable('ip_events', (t) => {
    t.bigIncrements('id').primary();
    t.integer('device_id').nullable()
      .references('id').inTable('agent_devices').onDelete('CASCADE');
    t.specificType('ip', 'inet').notNullable();
    t.string('username', 255).nullable();
    t.string('service', 50).notNullable(); // 'ssh', 'rdp', 'nginx', 'custom:42', …
    // 'auth_failure' | 'auth_success' | 'port_scan'
    t.string('event_type', 20).notNullable().defaultTo('auth_failure');
    t.timestamp('timestamp', { useTz: true }).notNullable();
    t.text('raw_log').nullable();
    t.integer('tenant_id').nullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.raw('CREATE INDEX idx_ip_events_ip ON ip_events(ip)');
  await knex.schema.raw('CREATE INDEX idx_ip_events_device ON ip_events(device_id)');
  await knex.schema.raw('CREATE INDEX idx_ip_events_timestamp ON ip_events(timestamp DESC)');
  await knex.schema.raw('CREATE INDEX idx_ip_events_tenant ON ip_events(tenant_id)');
  await knex.schema.raw('CREATE INDEX idx_ip_events_event_type ON ip_events(event_type)');

  // ip_reputation — aggregated per-IP stats (updated by BanEngine)
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

  // ip_bans — active / expired bans (auto or manual, global or scoped)
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
    t.integer('tenant_id').nullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    // Which tenant's agent first triggered this auto-ban
    t.integer('origin_tenant_id').nullable()
      .references('id').inTable('tenants').onDelete('SET NULL');
    t.integer('banned_by_user_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('banned_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // NULL = permanent
    t.timestamp('expires_at', { useTz: true }).nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
  });
  await knex.schema.raw('CREATE INDEX idx_ip_bans_active ON ip_bans(ip) WHERE is_active = true');
  await knex.schema.raw('CREATE INDEX idx_ip_bans_scope ON ip_bans(scope, scope_id) WHERE is_active = true');
  await knex.schema.raw('CREATE INDEX idx_ip_bans_expires ON ip_bans(expires_at) WHERE is_active = true AND expires_at IS NOT NULL');

  // ip_whitelist — trusted CIDR ranges (overrides bans)
  await knex.schema.createTable('ip_whitelist', (t) => {
    t.increments('id').primary();
    // Stored as CIDR (supports both single IPs like 1.2.3.4/32 and ranges like 192.168.0.0/24)
    t.specificType('ip', 'cidr').notNullable();
    t.string('label', 255).nullable();
    // 'global' | 'tenant' | 'group' | 'agent'
    t.string('scope', 20).notNullable().defaultTo('global');
    t.integer('scope_id').nullable();
    t.integer('tenant_id').nullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('created_by').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.raw('CREATE UNIQUE INDEX idx_ip_whitelist_uniq ON ip_whitelist(ip, scope, COALESCE(scope_id, 0))');
  await knex.schema.raw('CREATE INDEX idx_ip_whitelist_scope ON ip_whitelist(scope, scope_id)');

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 11 — Seed data
  // ══════════════════════════════════════════════════════════════════════════

  // 8 built-in service templates (platform-wide, no tenant)
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
  // Drop in reverse dependency order

  // Obliguard IPS core
  await knex.schema.dropTableIfExists('ip_whitelist');
  await knex.schema.dropTableIfExists('ip_bans');
  await knex.schema.dropTableIfExists('ip_reputation');
  await knex.schema.dropTableIfExists('ip_events');
  await knex.schema.dropTableIfExists('service_template_assignments');
  await knex.schema.dropTableIfExists('service_templates');

  // Infrastructure / config
  await knex.schema.dropTableIfExists('live_alerts');
  await knex.schema.dropTableIfExists('app_config');
  await knex.schema.dropTableIfExists('smtp_servers');

  // Remediations
  await knex.schema.dropTableIfExists('remediation_runs');
  await knex.schema.dropTableIfExists('remediation_bindings');
  await knex.schema.dropTableIfExists('remediation_actions');

  // Agent system
  await knex.schema.dropTableIfExists('agent_services');
  await knex.schema.dropTableIfExists('agent_devices');
  await knex.schema.dropTableIfExists('agent_api_keys');

  // Notifications
  await knex.schema.dropTableIfExists('notification_channel_tenants');
  await knex.schema.dropTableIfExists('notification_log');
  await knex.schema.dropTableIfExists('notification_bindings');
  await knex.schema.dropTableIfExists('notification_channels');

  // Settings
  await knex.schema.dropTableIfExists('settings');

  // Teams & RBAC
  await knex.schema.dropTableIfExists('team_permissions');
  await knex.schema.dropTableIfExists('team_memberships');
  await knex.schema.dropTableIfExists('user_teams');

  // Groups & hierarchy
  await knex.schema.dropTableIfExists('group_closure');
  await knex.schema.dropTableIfExists('monitor_groups');

  // Multi-tenancy
  await knex.schema.dropTableIfExists('user_tenants');
  await knex.schema.dropTableIfExists('tenants');

  // Core auth
  await knex.schema.dropTableIfExists('password_reset_tokens');
  await knex.schema.dropTableIfExists('session');
  await knex.schema.dropTableIfExists('users');
}
