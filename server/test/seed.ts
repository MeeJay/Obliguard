/**
 * Template-database seeder and Knex-parameterised helpers.
 *
 * seedFixtures() runs once on the template database, right after migrations.
 * Every helper takes a Knex (the app `db`, or a suite-owned instance as in
 * suite 14) and only inserts columns that exist at migration 025, so suite 14
 * can use them on a partially migrated database.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import type { Knex } from 'knex';
import {
  PASSWORD, TOTP_SECRET, USERS, KEYS, GROUPS, D, TEAMS, OG, DYNAMIC_BLOCKS,
} from './fixtures';

const BCRYPT_COST = 4;

export async function seedFixtures(knex: Knex): Promise<void> {
  // 1. Tenants (id 1 'Default' comes from migration 001, inserted with an
  //    explicit id that never advances tenants_id_seq — see 14#1).
  await knex('tenants').insert([
    { id: 2, name: 'Tenant B', slug: 'tenant-b' },
    { id: 3, name: 'Tenant C', slug: 'tenant-c' },
  ]);
  await knex.raw("SELECT setval(pg_get_serial_sequence('tenants','id'), 100)");

  // 2. Users
  const hash = await bcrypt.hash(PASSWORD, BCRYPT_COST);
  for (const u of USERS) {
    await knex('users').insert({
      id: u.id,
      username: u.username,
      password_hash: hash,
      role: u.role,
      is_active: true,
      email: `${u.username}@verify.test`,
      enrollment_version: 2,
      totp_enabled: !!u.totp,
      totp_secret: u.totp ? TOTP_SECRET : null,
      foreign_source: u.foreign?.source ?? null,
      foreign_id: u.foreign?.id ?? null,
    });
  }

  // 3. Memberships (all 'member')
  for (const u of USERS) {
    for (const t of u.tenants) {
      await knex('user_tenants').insert({ user_id: u.id, tenant_id: t, role: 'member' });
    }
  }

  // 4. Agent API keys: key N belongs to tenant N
  for (const n of [1, 2, 3] as const) {
    await knex('agent_api_keys').insert({ id: n, name: `key-t${n}`, key: KEYS[n], tenant_id: n, created_by: 1 });
  }

  // 5. Groups + closure self-rows
  for (const g of GROUPS) {
    await knex('monitor_groups').insert({
      id: g.id, name: g.slug, slug: g.slug, kind: 'agent', tenant_id: g.tenant, evaluate_only: g.evaluateOnly,
    });
    await knex('group_closure').insert({ ancestor_id: g.id, descendant_id: g.id, depth: 0 });
  }

  // 6. Devices
  for (const d of Object.values(D)) {
    await knex('agent_devices').insert({
      id: d.id,
      uuid: d.uuid,
      hostname: d.hostname,
      status: d.status,
      group_id: d.groupId,
      tenant_id: d.tenant,
      api_key_id: d.keyId,
      agent_version: d.version,
      check_interval_seconds: 60,
      ip: null,
    });
  }

  // 7. SSH opted in for group B (and its evaluate-only sibling group)
  const ssh = await knex('service_templates')
    .where({ service_type: 'ssh', is_builtin: true })
    .whereNull('owner_scope')
    .first('id') as { id: number } | undefined;
  if (!ssh) throw new Error('seed: built-in SSH template not found');
  await knex('service_template_assignments').insert([
    { template_id: ssh.id, scope: 'group', scope_id: 2, enabled_override: true },
    { template_id: ssh.id, scope: 'group', scope_id: 4, enabled_override: true },
  ]);

  // 8. Teams
  for (const t of Object.values(TEAMS)) {
    await knex('user_teams').insert({ id: t.id, name: t.name, tenant_id: t.tenant });
    for (const m of t.members) await knex('team_memberships').insert({ team_id: t.id, user_id: m });
    await knex('team_permissions').insert({
      id: t.id,
      team_id: t.id,
      scope: t.perm.scope,
      scope_id: t.perm.scope_id,
      level: t.perm.level,
      capabilities: JSON.stringify(t.perm.capabilities),
    });
  }

  // 9. SSO link of the og_sso fixture
  await knex('sso_foreign_users').insert({ id: 1, foreign_source: 'obligate', foreign_user_id: OG.obligateUserId, local_user_id: OG.userId });

  // 10. Advance the sequences past the explicit ids
  for (const table of ['users', 'agent_api_keys', 'monitor_groups', 'agent_devices', 'user_teams', 'team_permissions', 'sso_foreign_users']) {
    await knex.raw(`SELECT setval(pg_get_serial_sequence('${table}','id'), 100)`);
  }
}

// ── IP allocation ────────────────────────────────────────────────────────────

let dynCounter = 0;

/** Per-process DYNAMIC allocator: 203.0.113.1-254, then 198.51.100.1-254. */
export function nextIp(): string {
  const idx = dynCounter++;
  const block = Math.floor(idx / 254);
  if (block >= DYNAMIC_BLOCKS.length) throw new Error('nextIp: dynamic address pool exhausted');
  return `${DYNAMIC_BLOCKS[block]}.${(idx % 254) + 1}`;
}

export type LiteralBlock = '192.0.2' | '198.18' | '198.19' | '2001:db8';

/**
 * Build a LITERAL address from an allowed block:
 *   litIp('192.0.2', 10)        → 192.0.2.10
 *   litIp('198.18', 12, 200)    → 198.18.12.200
 *   litIp('2001:db8', 0x20, 1)  → 2001:db8:20::1   (third group in hex)
 */
export function litIp(block: LiteralBlock, a: number, b = 0): string {
  const octet = (n: number) => Number.isInteger(n) && n >= 0 && n <= 255;
  if (block === '192.0.2') {
    if (!octet(a)) throw new Error(`litIp: bad octet ${a}`);
    return `192.0.2.${a}`;
  }
  if (block === '198.18' || block === '198.19') {
    if (!octet(a) || !octet(b)) throw new Error(`litIp: bad octets ${a}.${b}`);
    return `${block}.${a}.${b}`;
  }
  if (block === '2001:db8') {
    if (!Number.isInteger(a) || a < 0 || a > 0xffff || !Number.isInteger(b) || b < 0 || b > 0xffff) {
      throw new Error(`litIp: bad v6 groups ${a}/${b}`);
    }
    return `2001:db8:${a.toString(16)}::${b.toString(16)}`;
  }
  throw new Error(`litIp: block ${String(block)} is not a literal block`);
}

// ── Row helpers ──────────────────────────────────────────────────────────────

export interface InsertBanOpts {
  ip: string;
  scope?: 'global' | 'tenant' | 'group' | 'agent';
  tenantId?: number | null;
  scopeId?: number | null;
  banType?: 'auto' | 'manual' | 'external';
  originTenantId?: number | null;
  isActive?: boolean;
  expiresAt?: Date | null;
  bannedAt?: Date;
  cidrPrefix?: number | null;
}

export async function insertBan(k: Knex, o: InsertBanOpts): Promise<number> {
  const row: Record<string, unknown> = {
    ip: k.raw('?::inet', [o.ip]),
    scope: o.scope ?? 'global',
    tenant_id: o.tenantId ?? null,
    scope_id: o.scopeId ?? null,
    ban_type: o.banType ?? 'manual',
    origin_tenant_id: o.originTenantId ?? null,
    is_active: o.isActive ?? true,
    expires_at: o.expiresAt ?? null,
    cidr_prefix: o.cidrPrefix ?? null,
  };
  if (o.bannedAt) row.banned_at = o.bannedAt;
  const [r] = await k('ip_bans').insert(row).returning('id') as Array<{ id: number }>;
  return r.id;
}

export interface BanRowT {
  id: number; ip: string; scope: string; scope_id: number | null; tenant_id: number | null;
  origin_tenant_id: number | null; ban_type: string; is_active: boolean; cidr_prefix: number | null;
}

export async function banRow(k: Knex, id: number): Promise<BanRowT | undefined> {
  return k('ip_bans').where({ id }).first() as Promise<BanRowT | undefined>;
}

export async function exclusions(k: Knex, banId: number): Promise<Array<{ id: number; ban_id: number; tenant_id: number }>> {
  return k('ip_ban_exclusions').where({ ban_id: banId }).orderBy('id');
}

export interface InsertWhitelistOpts {
  ip: string;
  scope: 'global' | 'tenant' | 'group' | 'agent';
  scopeId?: number | null;
  tenantId?: number | null;
  createdBy?: number | null;
}

export async function insertWhitelist(k: Knex, o: InsertWhitelistOpts): Promise<number> {
  const [r] = await k('ip_whitelist').insert({
    ip: k.raw('?::cidr', [o.ip]),
    scope: o.scope,
    scope_id: o.scopeId ?? null,
    tenant_id: o.tenantId ?? null,
    created_by: o.createdBy ?? null,
  }).returning('id') as Array<{ id: number }>;
  return r.id;
}

export interface InsertEventsOpts {
  deviceId: number;
  tenantId: number;
  ip: string;
  service?: string;
  eventType?: string;
  count: number;
  ageSec?: number;
}

export async function insertEvents(k: Knex, o: InsertEventsOpts): Promise<void> {
  const ts = new Date(Date.now() - (o.ageSec ?? 30) * 1000);
  const rows = Array.from({ length: o.count }, () => ({
    device_id: o.deviceId,
    tenant_id: o.tenantId,
    ip: o.ip,
    username: 'root',
    service: o.service ?? 'ssh',
    event_type: o.eventType ?? 'auth_failure',
    timestamp: ts,
    raw_log: 'verify',
    track_only: false,
  }));
  if (rows.length > 0) await k('ip_events').insert(rows);
}

let userSeq = 0;
function uniq(prefix: string): string {
  userSeq++;
  return `${prefix}_${process.pid}_${userSeq}_${crypto.randomBytes(2).toString('hex')}`;
}

export interface CreateUserOpts {
  username?: string;
  role?: 'admin' | 'user';
  tenants?: number[];
  email?: string;
}

export async function createUser(k: Knex, o: CreateUserOpts = {}): Promise<{ id: number; username: string }> {
  const username = o.username ?? uniq('u');
  const hash = await bcrypt.hash(PASSWORD, BCRYPT_COST);
  const [r] = await k('users').insert({
    username,
    password_hash: hash,
    role: o.role ?? 'user',
    is_active: true,
    email: o.email ?? `${username}@verify.test`,
    enrollment_version: 2,
  }).returning('id') as Array<{ id: number }>;
  for (const t of o.tenants ?? []) {
    await k('user_tenants').insert({ user_id: r.id, tenant_id: t, role: 'member' });
  }
  return { id: r.id, username };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf: Buffer): string {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export async function createTotpUser(k: Knex, o: { tenants?: number[] } = {}): Promise<{ id: number; username: string; secret: string }> {
  const secret = base32(crypto.randomBytes(20));
  const u = await createUser(k, { tenants: o.tenants ?? [2] });
  await k('users').where({ id: u.id }).update({ totp_enabled: true, totp_secret: secret });
  return { ...u, secret };
}

export async function createKey(k: Knex, tenantId: number): Promise<{ id: number; key: string }> {
  const key = crypto.randomUUID();
  const [r] = await k('agent_api_keys').insert({ name: uniq('key'), key, tenant_id: tenantId, created_by: 1 }).returning('id') as Array<{ id: number }>;
  return { id: r.id, key };
}

export async function createGroup(
  k: Knex,
  o: { tenantId: number; name?: string; evaluateOnly?: boolean },
): Promise<number> {
  const slug = uniq('g').toLowerCase();
  const [r] = await k('monitor_groups').insert({
    name: o.name ?? slug,
    slug,
    kind: 'agent',
    tenant_id: o.tenantId,
    evaluate_only: o.evaluateOnly ?? false,
  }).returning('id') as Array<{ id: number }>;
  await k('group_closure').insert({ ancestor_id: r.id, descendant_id: r.id, depth: 0 });
  return r.id;
}

export interface CreateDeviceOpts {
  uuid?: string;
  tenantId: number;
  keyId: number;
  status?: 'approved' | 'pending' | 'refused' | 'suspended';
  groupId?: number | null;
  version?: string;
  hostname?: string;
  deviceType?: 'agent' | 'mikrotik';
}

export async function createDevice(k: Knex, o: CreateDeviceOpts): Promise<{ id: number; uuid: string; hostname: string }> {
  const uuid = o.uuid ?? `t-${crypto.randomUUID()}`;
  const hostname = o.hostname ?? uuid;
  const row: Record<string, unknown> = {
    uuid,
    hostname,
    status: o.status ?? 'approved',
    group_id: o.groupId ?? null,
    tenant_id: o.tenantId,
    api_key_id: o.keyId,
    agent_version: o.version ?? '1.0.0',
    check_interval_seconds: 60,
  };
  if (o.deviceType) row.device_type = o.deviceType;
  const [r] = await k('agent_devices').insert(row).returning('id') as Array<{ id: number }>;
  return { id: r.id, uuid, hostname };
}

export async function createMikrotikDevice(
  k: Knex,
  o: { tenantId: number; keyId: number; host: string },
): Promise<{ id: number; uuid: string }> {
  // Loaded lazily: src/utils/crypto reads SESSION_SECRET through src/config,
  // which is the same in-process value the app uses to decrypt.
  const { encryptSecret } = await import('../src/utils/crypto');
  const dev = await createDevice(k, { tenantId: o.tenantId, keyId: o.keyId, hostname: o.host, deviceType: 'mikrotik' });
  await k('mikrotik_credentials').insert({
    device_id: dev.id,
    api_host: o.host,
    api_password_enc: encryptSecret('verify'),
    syslog_identifier: o.host,
  });
  return { id: dev.id, uuid: dev.uuid };
}

/** Rewrite the session's currentTenantId directly in the store (forged/stale session). */
export async function setSessionTenant(k: Knex, sid: string, tenantId: number): Promise<void> {
  await k.raw(
    `UPDATE session SET sess = jsonb_set(sess::jsonb, '{currentTenantId}', ?::jsonb)::json WHERE sid = ?`,
    [String(tenantId), sid],
  );
}
