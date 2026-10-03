import type { Knex } from 'knex';

/**
 * Migration 035 — tenant roles become permission sets (W6-1: RBAC-1..5).
 *
 * user_tenants.role is now the slug of a permission set (permission_sets.slug):
 * 'admin' holds every tenant capability, any other slug the capabilities of
 * its set, an unknown slug none. Mirrors Obliance 091_user_tenants_role_varchar.
 *
 *   1. user_tenants.role: VARCHAR(16) → VARCHAR(64), default 'member' → 'user';
 *      the legacy 'member' rows are backfilled to 'user'.
 *   2. The protected sets admin / user / viewer are (re)seeded with the IPS
 *      capability catalogue (their pre-035 keys were never read at runtime).
 *   3. Custom sets have their keys rewritten to the catalogue (legacy keys
 *      mapped, unknown keys dropped).
 *
 * The catalogue is a frozen snapshot here (a migration must not follow later
 * edits of shared/src/types.ts). Idempotent: running it again changes nothing.
 */

const CATALOGUE = [
  'ips.view', 'bans.create', 'bans.lift', 'bans.promote', 'bans.wipe', 'whitelist.write',
  'ip.labels', 'ip.reputation.clear', 'templates.write', 'agents.manage', 'agents.update',
  'agents.delete', 'agents.keys', 'agents.approve', 'firewall.rules.read', 'firewall.rules.write',
  'groups.manage', 'notifications.manage', 'settings', 'integrations.mikrotik', 'integrations.m365',
  'rate_limit.write', 'remote_blocklists', 'users.manage', 'audit.read',
];

const USER_EXCLUDED = new Set([
  'agents.delete', 'agents.keys', 'firewall.rules.write', 'users.manage', 'settings',
  'notifications.manage', 'bans.promote', 'bans.wipe', 'audit.read',
]);

const PROTECTED: Array<{ slug: string; name: string; capabilities: string[] }> = [
  { slug: 'admin', name: 'Admin', capabilities: [...CATALOGUE] },
  { slug: 'user', name: 'User', capabilities: CATALOGUE.filter((c) => !USER_EXCLUDED.has(c)) },
  { slug: 'viewer', name: 'Viewer', capabilities: ['ips.view', 'firewall.rules.read'] },
];

/** Pre-035 keys (015 seed keys and runtime capabilities) → catalogue keys. */
const LEGACY_KEYS: Record<string, string[]> = {
  monitoring: ['ips.view', 'firewall.rules.read'],
  'service.templates': ['templates.write'],
  bans: ['bans.create', 'bans.lift'],
  whitelist: ['whitelist.write'],
  monitor_rw: ['agents.manage', 'agents.update', 'firewall.rules.read'],
  agents_rw: ['agents.manage', 'agents.update', 'firewall.rules.read'],
  group_rw: ['groups.manage'],
};

function parseCaps(raw: unknown): string[] {
  const v = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown; } catch { return []; } })() : raw;
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
}

function rewriteCaps(caps: string[]): string[] {
  const out = new Set<string>();
  for (const c of caps) {
    if (CATALOGUE.includes(c)) out.add(c);
    else for (const m of LEGACY_KEYS[c] ?? []) out.add(m);
  }
  return CATALOGUE.filter((c) => out.has(c));
}

export async function up(knex: Knex): Promise<void> {
  // 1. Role column: slug of a permission set.
  await knex.raw(`ALTER TABLE user_tenants ALTER COLUMN role TYPE VARCHAR(64)`);
  await knex.raw(`ALTER TABLE user_tenants ALTER COLUMN role SET DEFAULT 'user'`);
  await knex('user_tenants').where({ role: 'member' }).update({ role: 'user' });

  // 2. Protected sets (inserted when missing, content reset to the seed).
  for (const p of PROTECTED) {
    await knex('permission_sets')
      .insert({ name: p.name, slug: p.slug, capabilities: JSON.stringify(p.capabilities), is_default: true })
      .onConflict('slug')
      .merge({ name: p.name, capabilities: JSON.stringify(p.capabilities), is_default: true });
  }

  // 3. Custom sets: keys rewritten to the catalogue.
  const rows = await knex('permission_sets')
    .whereNotIn('slug', PROTECTED.map((p) => p.slug))
    .select('id', 'capabilities') as Array<{ id: number; capabilities: unknown }>;
  for (const r of rows) {
    const before = parseCaps(r.capabilities);
    const after = rewriteCaps(before);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await knex('permission_sets').where({ id: r.id }).update({ capabilities: JSON.stringify(after) });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // Any non-admin role (user, viewer, custom slug) goes back to 'member'.
  await knex.raw(`UPDATE user_tenants SET role = 'member' WHERE role <> 'admin'`);
  await knex.raw(`ALTER TABLE user_tenants ALTER COLUMN role SET DEFAULT 'member'`);
  await knex.raw(`ALTER TABLE user_tenants ALTER COLUMN role TYPE VARCHAR(16)`);
}
