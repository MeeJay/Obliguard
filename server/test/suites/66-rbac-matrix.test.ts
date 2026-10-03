/**
 * 66 — W7-2 route-to-capability matrix and tenant ownership on delegated routes.
 *
 *   66.1 one route per capability, parametrised over viewer / user / tenant
 *        admin / platform admin on the Default tenant and on tenant 2: refused
 *        (403) exactly when the role lacks the capability (protected sets =
 *        DEFAULT_PERMISSION_SET_CAPABILITIES), Default-only routes refused
 *        from tenant 2, platform-only routes refused to every non-platform role
 *   66.2 agents: delete / uninstall / firewall writes / keys are not in the
 *        'user' set; approve is; the tenant admin holds them, on its tenant only
 *   66.3 groups: create = groups.manage AND (team canCreate OR RW on the
 *        parent); agent-config / reorder = groups.manage on the operating
 *        tenant, the update policy stays platform-admin only
 *   66.4 service templates: own templates, platform templates from Default
 *        (or a platform admin) only, no write on another tenant's template /
 *        scope / device
 *   66.5 IP labels: Default → global label (one row per IP), other tenants →
 *        their own label; IP validated
 *   66.6 IP reputation: /:ip/clear is a tenant clear except for the platform
 *        admin on Default (global); POST gated per target status
 *   66.7 integrations and notifications: MikroTik :id bound to the tenant,
 *        import poll platform-only, channel sharing Default-only
 *
 * Principals: viewer_b (seed), member_b ('user'), admin_b (tenant role
 * 'admin' on tenant 2, fixtures.ADMIN_B) and their Default counterparts
 * (default_member + two suite-created users), plus the platform admin
 * switched to each tenant.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Knex } from 'knex';
import { startHarness } from '../harness';
import type { Harness, Client, Res } from '../harness';
import { lotIt } from '../lots';
import { ADMIN_B, D, G, KEYS, TEAMS } from '../fixtures';
import { createUser, createDevice, createGroup, createMikrotikDevice, nextIp, VIEWER_B } from '../seed';
import { DEFAULT_PERMISSION_SET_CAPABILITIES } from '@obliview/shared';
import type { TenantCapability } from '@obliview/shared';

type Role = 'viewer' | 'user' | 'admin' | 'platform';

interface Principal { role: Role; tenant: 1 | 2; client: Client; label: string }

/** admin_b: seeded by seed.ts once it knows ADMIN_B, created here otherwise. */
async function ensureAdminB(db: Knex): Promise<void> {
  const row = await db('users').where({ username: ADMIN_B.username }).first('id') as { id: number } | undefined;
  if (!row) {
    await createUser(db, { username: ADMIN_B.username, tenants: [ADMIN_B.tenant], tenantRole: ADMIN_B.tenantRole });
    return;
  }
  await db('user_tenants').where({ user_id: row.id, tenant_id: ADMIN_B.tenant }).update({ role: ADMIN_B.tenantRole });
}

/** Whether a role holds a capability through the protected sets (platform = all). */
function holds(role: Role, cap: TenantCapability): boolean {
  if (role === 'platform' || role === 'admin') return true;
  return (DEFAULT_PERMISSION_SET_CAPABILITIES[role] as readonly string[]).includes(cap);
}

interface MatrixCase {
  cap: TenantCapability | 'ips.view';
  /** Who may pass besides the capability holders. */
  access?: 'platform';
  defaultTenantOnly?: boolean;
  call: (c: Client) => Promise<Res>;
  /** Statuses accepted when the caller passes the guard. */
  ok: number[];
}

const NONE = 999999;

const CASES: MatrixCase[] = [
  { cap: 'ips.view', call: (c) => c.get('/api/bans'), ok: [200] },
  { cap: 'bans.create', call: (c) => c.post('/api/bans', {}), ok: [400] },
  { cap: 'bans.lift', call: (c) => c.del(`/api/bans/${NONE}`), ok: [404] },
  { cap: 'bans.promote', defaultTenantOnly: true, call: (c) => c.post(`/api/bans/${NONE}/promote-global`), ok: [404] },
  // Allowed side not exercised (it would wipe the suite's data): see 67 for the guard.
  { cap: 'bans.wipe', access: 'platform', defaultTenantOnly: true, call: (c) => c.post('/api/bans/wipe-reputation'), ok: [] },
  { cap: 'whitelist.write', call: (c) => c.post('/api/whitelist', {}), ok: [400] },
  { cap: 'ip.labels', call: (c) => c.post('/api/ip-labels', {}), ok: [400] },
  { cap: 'ip.reputation.clear', call: (c) => c.post('/api/ip-reputation/not-an-ip/clear'), ok: [400] },
  { cap: 'templates.write', call: (c) => c.post('/api/service-templates', {}), ok: [400] },
  { cap: 'agents.manage', call: (c) => c.patch(`/api/agent/devices/${NONE}`, { name: 'matrix' }), ok: [404] },
  { cap: 'agents.update', call: (c) => c.del(`/api/agent/devices/${NONE}/agent-update`), ok: [404] },
  { cap: 'agents.delete', call: (c) => c.del(`/api/agent/devices/${NONE}`), ok: [404] },
  { cap: 'agents.keys', call: (c) => c.get('/api/agent/keys'), ok: [200] },
  { cap: 'agents.approve', call: (c) => c.patch(`/api/agent/devices/${NONE}`, { status: 'refused' }), ok: [404] },
  { cap: 'firewall.rules.read', call: (c) => c.get(`/api/agent/devices/${NONE}/firewall/rules`), ok: [404] },
  { cap: 'firewall.rules.write', call: (c) => c.del(`/api/agent/devices/${NONE}/firewall/rules/r1`), ok: [404] },
  { cap: 'groups.manage', call: (c) => c.post('/api/groups/reorder', {}), ok: [400] },
  { cap: 'notifications.manage', call: (c) => c.get('/api/notifications/plugins'), ok: [200] },
  // Platform-only until settings rows are tenant-scoped (W13-1, critic C.2).
  { cap: 'settings', access: 'platform', call: (c) => c.get('/api/settings/global/resolved'), ok: [200] },
  { cap: 'integrations.mikrotik', call: (c) => c.get(`/api/mikrotik/${NONE}/credentials`), ok: [404] },
  { cap: 'integrations.m365', call: (c) => c.get(`/api/m365/${NONE}`), ok: [404] },
  { cap: 'rate_limit.write', call: (c) => c.del(`/api/rate-limit-policies/${NONE}`), ok: [404] },
  // Instance setting (owner decision 6): platform admin on Default.
  { cap: 'remote_blocklists', access: 'platform', defaultTenantOnly: true, call: (c) => c.del(`/api/remote-blocklists/${NONE}`), ok: [404] },
];

function expectedAllowed(p: Principal, k: MatrixCase): boolean {
  if (k.defaultTenantOnly && p.tenant !== 1) return false;
  if (k.access === 'platform') return p.role === 'platform';
  if (k.cap === 'ips.view') return true;
  return holds(p.role, k.cap);
}

describe('66 RBAC matrix and tenant ownership (W7-2)', () => {
  let h: Harness;
  let principals: Principal[] = [];
  const P = (role: Role, tenant: 1 | 2): Client => principals.find((p) => p.role === role && p.tenant === tenant)!.client;

  before(async () => {
    h = await startHarness();
    await ensureAdminB(h.db);
    const viewerDef = await createUser(h.db, { tenants: [1], tenantRole: 'viewer' });
    const adminDef = await createUser(h.db, { tenants: [1], tenantRole: 'admin' });
    principals = [
      { role: 'viewer', tenant: 1, client: await h.login(viewerDef.username), label: 'viewer@Default' },
      { role: 'user', tenant: 1, client: await h.as('default_member'), label: 'user@Default' },
      { role: 'admin', tenant: 1, client: await h.login(adminDef.username), label: 'tenant-admin@Default' },
      { role: 'platform', tenant: 1, client: await h.adminIn(1), label: 'platform@Default' },
      { role: 'viewer', tenant: 2, client: await h.as(VIEWER_B.username), label: 'viewer@B' },
      { role: 'user', tenant: 2, client: await h.as('member_b'), label: 'user@B' },
      { role: 'admin', tenant: 2, client: await h.as(ADMIN_B.username), label: 'tenant-admin@B' },
      { role: 'platform', tenant: 2, client: await h.adminIn(2), label: 'platform@B' },
    ];
  });
  after(async () => { await h.close(); });

  lotIt('W7-2', '66.1 one route per capability: refused exactly when the role lacks it', async () => {
    const wrong: string[] = [];
    for (const k of CASES) {
      for (const p of principals) {
        const allowed = expectedAllowed(p, k);
        if (allowed && k.ok.length === 0) continue;
        const r = await k.call(p.client);
        if (allowed ? !k.ok.includes(r.status) : r.status !== 403) {
          wrong.push(`${k.cap} ${p.label}: ${r.status} (expected ${allowed ? k.ok.join('|') : 403}) ${r.text.slice(0, 120)}`);
        }
      }
    }
    assert.deepEqual(wrong, []);
  });

  lotIt('W7-2', '66.2 agents: destructive capabilities outside the user set, tenant admin on its tenant', async () => {
    const user = P('user', 2);
    const tadmin = P('admin', 2);
    const viewer = P('viewer', 2);

    const dev = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    assert.equal((await user.del(`/api/agent/devices/${dev.id}`)).status, 403);
    assert.equal((await user.post(`/api/agent/devices/${dev.id}/command`, { command: 'uninstall' })).status, 403);
    assert.equal((await user.post('/api/agent/devices/bulk-command', { deviceIds: [dev.id], command: 'uninstall' })).status, 403);
    assert.equal((await user.del('/api/agent/devices/bulk', { deviceIds: [dev.id] })).status, 403);
    assert.equal((await user.post(`/api/agent/devices/${dev.id}/firewall/rules`, { name: 'x' })).status, 403);
    assert.equal((await user.patch(`/api/agent/devices/${dev.id}/firewall/rules/r1`, { enabled: false })).status, 403);
    assert.equal((await user.get('/api/agent/keys')).status, 403);
    assert.equal((await user.post('/api/agent/keys', { name: 'k' })).status, 403);
    assert.equal((await user.get('/api/agent/installer/wizard.exe')).status, 403);
    const row = await h.db('agent_devices').where({ id: dev.id }).first();
    assert.ok(row, 'still there');
    assert.equal(row.pending_command ?? null, null, 'no uninstall queued');

    // 'user' holds agents.manage + agents.approve; the viewer neither.
    const pending = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'pending' });
    assert.equal((await viewer.patch(`/api/agent/devices/${pending.id}`, { status: 'approved' })).status, 403);
    assert.equal((await viewer.patch(`/api/agent/devices/${dev.id}`, { name: 'viewer' })).status, 403);
    assert.notEqual((await user.patch(`/api/agent/devices/${pending.id}`, { status: 'approved' })).status, 403);
    assert.equal((await h.db('agent_devices').where({ id: pending.id }).first()).status, 'approved');

    // Keys: the tenant admin lists, creates and deletes the keys of tenant 2 only.
    const keys = await tadmin.get('/api/agent/keys');
    assert.equal(keys.status, 200, keys.text);
    const keyRows = keys.json.data as Array<{ id: number; key?: string }>;
    assert.ok(keyRows.some((k) => k.id === 2));
    assert.ok(!keyRows.some((k) => k.id === 3 || k.key === KEYS[3]), 'no key of tenant 3');
    const created = await tadmin.post('/api/agent/keys', { name: 'admin-b-key' });
    assert.equal(created.status, 201, created.text);
    const newKey = await h.db('agent_api_keys').where({ name: 'admin-b-key' }).first();
    assert.equal(newKey.tenant_id, 2);
    assert.notEqual((await tadmin.del('/api/agent/keys/3')).status, 200);
    assert.ok(await h.db('agent_api_keys').where({ id: 3 }).first(), "tenant 3's key survives");

    // Destructive actions: tenant 2 only for its admin.
    assert.notEqual((await tadmin.del(`/api/agent/devices/${D.C.id}`)).status, 200);
    assert.ok(await h.db('agent_devices').where({ id: D.C.id }).first(), 'foreign agent untouched');
    const del = await tadmin.del(`/api/agent/devices/${dev.id}`);
    assert.equal(del.status, 200, del.text);
    assert.equal(await h.db('agent_devices').where({ id: dev.id }).first(), undefined);
  });

  lotIt('W7-2', '66.3 groups: create needs canCreate or RW on the parent; agent-config and reorder', async () => {
    const user = P('user', 2);
    const tadmin = P('admin', 2);
    const memberB = (await h.db('users').where({ username: 'member_b' }).first('id')).id as number;

    // No team: no canCreate, no RW anywhere.
    assert.equal((await user.post('/api/groups', { name: 'g66-root' })).status, 403);
    assert.equal((await user.post('/api/groups', { name: 'g66-sub', parentId: G.B })).status, 403);
    assert.equal((await h.db('monitor_groups').whereIn('name', ['g66-root', 'g66-sub'])).length, 0);

    // RW on G.B through B-team: a sub-group of G.B, but still no root group.
    await h.db('team_memberships').insert({ team_id: TEAMS.B_TEAM.id, user_id: memberB });
    try {
      const sub = await user.post('/api/groups', { name: 'g66-sub', parentId: G.B });
      assert.equal(sub.status, 201, sub.text);
      assert.equal(sub.json.data.tenantId, 2);
      assert.equal((await user.post('/api/groups', { name: 'g66-root' })).status, 403);
      // A viewer in the same team is refused by groups.manage.
      assert.equal((await P('viewer', 2).post('/api/groups', { name: 'g66-viewer', parentId: G.B })).status, 403);
    } finally {
      await h.db('team_memberships').where({ team_id: TEAMS.B_TEAM.id, user_id: memberB }).del();
    }

    // The tenant admin bypasses team scope (W7-1): a root group without any team.
    const adminRoot = await tadmin.post('/api/groups', { name: 'g66-admin-root' });
    assert.equal(adminRoot.status, 201, adminRoot.text);
    assert.equal(adminRoot.json.data.tenantId, 2);

    // agent-config: groups.manage on the operating tenant's groups; updatePolicy platform-only.
    const g = await createGroup(h.db, { tenantId: 2 });
    const r1 = await tadmin.patch(`/api/groups/${g}/agent-config`, { agentGroupConfig: { pushIntervalSeconds: 45 } });
    assert.equal(r1.status, 200, r1.text);
    const cfg = (await h.db('monitor_groups').where({ id: g }).first()).agent_group_config;
    assert.equal((typeof cfg === 'string' ? JSON.parse(cfg) : cfg).pushIntervalSeconds, 45);
    assert.equal((await tadmin.patch(`/api/groups/${g}/agent-config`, { agentGroupConfig: { updatePolicy: 'off' } })).status, 403);
    assert.equal((await user.patch(`/api/groups/${g}/agent-config`, { agentGroupConfig: { updatePolicy: 'auto' } })).status, 403);
    const after = (await h.db('monitor_groups').where({ id: g }).first()).agent_group_config;
    assert.equal((typeof after === 'string' ? JSON.parse(after) : after).updatePolicy ?? null, null);
    assert.equal((await tadmin.patch(`/api/groups/${G.C}/agent-config`, { agentGroupConfig: { pushIntervalSeconds: 45 } })).status, 404);
    assert.equal((await P('viewer', 2).patch(`/api/groups/${g}/agent-config`, { agentGroupConfig: { pushIntervalSeconds: 30 } })).status, 403);

    // reorder: own groups only.
    assert.equal((await tadmin.post('/api/groups/reorder', { items: [{ id: g, sortOrder: 3 }] })).status, 200);
    assert.equal((await h.db('monitor_groups').where({ id: g }).first()).sort_order, 3);
    assert.equal((await tadmin.post('/api/groups/reorder', { items: [{ id: G.C, sortOrder: 7 }] })).status, 404);
    assert.notEqual((await h.db('monitor_groups').where({ id: G.C }).first()).sort_order, 7);
    assert.equal((await P('viewer', 2).post('/api/groups/reorder', { items: [{ id: g, sortOrder: 1 }] })).status, 403);
  });

  lotIt('W7-2', '66.4 service templates: tenant-bound writes, platform templates from Default only', async () => {
    const tadmin = P('admin', 2);
    const own = await tadmin.post('/api/service-templates', { name: 't66-b', serviceType: 'ssh' });
    assert.equal(own.status, 201, own.text);
    assert.equal(own.json.data.tenantId, 2);
    assert.equal((await tadmin.put(`/api/service-templates/${own.json.data.id}`, { threshold: 9 })).status, 200);

    const foreign = await (await h.adminIn(3)).post('/api/service-templates', { name: 't66-c', serviceType: 'ssh' });
    assert.equal(foreign.status, 201, foreign.text);
    assert.equal(foreign.json.data.tenantId, 3);
    assert.equal((await tadmin.put(`/api/service-templates/${foreign.json.data.id}`, { threshold: 9 })).status, 404);
    assert.equal((await tadmin.del(`/api/service-templates/${foreign.json.data.id}`)).status, 404);
    assert.ok(await h.db('service_templates').where({ id: foreign.json.data.id }).first());

    // Assignment / sample targets belong to the operating tenant.
    assert.ok([403, 404].includes((await tadmin.put(`/api/service-templates/${own.json.data.id}/assign/group/${G.C}`, {})).status));
    assert.ok([403, 404].includes((await tadmin.post(`/api/service-templates/${own.json.data.id}/sample/${D.C.id}`)).status));
    assert.equal((await h.db('service_template_assignments').where({ template_id: own.json.data.id, scope: 'group', scope_id: G.C })).length, 0);
    assert.equal((await tadmin.put(`/api/service-templates/${own.json.data.id}/assign/group/${G.B}`, {})).status, 200);

    // A platform (built-in) template is shared by every tenant.
    const builtin = await h.db('service_templates').whereNull('tenant_id').where({ is_builtin: true }).orderBy('id').first();
    assert.equal((await tadmin.put(`/api/service-templates/${builtin.id}`, { threshold: 99 })).status, 403);
    assert.equal((await P('user', 2).put(`/api/service-templates/${builtin.id}`, { threshold: 99 })).status, 403);
    assert.equal((await h.db('service_templates').where({ id: builtin.id }).first()).threshold, builtin.threshold);
    const fromDefault = await P('admin', 1).put(`/api/service-templates/${builtin.id}`, { threshold: builtin.threshold + 1 });
    assert.equal(fromDefault.status, 200, fromDefault.text);
    assert.equal((await P('platform', 2).put(`/api/service-templates/${builtin.id}`, { threshold: builtin.threshold })).status, 200);
    assert.equal((await h.db('service_templates').where({ id: builtin.id }).first()).threshold, builtin.threshold);
    assert.equal((await P('viewer', 1).put(`/api/service-templates/${builtin.id}`, { threshold: 1 })).status, 403);
  });

  lotIt('W7-2', '66.5 IP labels: Default writes global labels, other tenants their own', async () => {
    const ip = nextIp();
    const rowsOf = async () => h.db('ip_display_names').where({ ip }).orderBy('id');

    assert.equal((await P('viewer', 2).post('/api/ip-labels', { ip, label: 'nope' })).status, 403);
    assert.equal((await P('user', 2).post('/api/ip-labels', { ip, label: 'B office' })).status, 200);
    let rows = await rowsOf();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant_id, 2);

    // Default → global (tenant_id NULL), replaced in place on a second write.
    assert.equal((await P('user', 1).post('/api/ip-labels', { ip, label: 'Global v1' })).status, 200);
    assert.equal((await P('platform', 1).post('/api/ip-labels', { ip, label: 'Global v2' })).status, 200);
    rows = await rowsOf();
    const globals = rows.filter((r) => r.tenant_id === null);
    assert.equal(globals.length, 1, 'one global label per IP');
    assert.equal(globals[0].label, 'Global v2');

    // A legacy Default label (tenant_id = 1, written before W7-2) is replaced by
    // the global one on the next Default write, and removed by a Default delete.
    await h.db('ip_display_names').insert({ ip, label: 'legacy', tenant_id: 1 });
    assert.equal((await P('admin', 1).post('/api/ip-labels', { ip, label: 'Global v3' })).status, 200);
    rows = await rowsOf();
    assert.deepEqual(rows.map((r) => r.tenant_id).sort(), [2, null].sort());
    await h.db('ip_display_names').insert({ ip, label: 'legacy', tenant_id: 1 });
    const legacyIp = nextIp();
    await h.db('ip_display_names').insert({ ip: legacyIp, label: 'legacy only', tenant_id: 1 });
    assert.equal((await P('user', 1).del(`/api/ip-labels/${encodeURIComponent(legacyIp)}`)).status, 200);
    assert.equal((await h.db('ip_display_names').where({ ip: legacyIp })).length, 0);
    assert.equal((await P('platform', 1).post('/api/ip-labels', { ip, label: 'Global v2' })).status, 200);
    rows = await rowsOf();
    assert.equal(rows.filter((r) => r.tenant_id === 1).length, 0);

    // Tenant 2 sees its own label over the global one; tenant 3 the global one.
    const seen = async (c: Client) => ((await c.get('/api/ip-labels')).json.data as Array<{ ip: string; label: string }>).find((l) => l.ip === ip)?.label;
    assert.equal(await seen(P('user', 2)), 'B office');
    assert.equal(await seen(await h.as('member_c')), 'Global v2');

    // A platform admin operating tenant 2 writes tenant 2's label, never the global one.
    assert.equal((await P('platform', 2).del(`/api/ip-labels/${encodeURIComponent(ip)}`)).status, 200);
    rows = await rowsOf();
    assert.deepEqual(rows.map((r) => r.tenant_id), [null]);

    assert.equal((await P('admin', 2).post('/api/ip-labels', { ip: 'not-an-ip', label: 'x' })).status, 400);
    assert.equal((await P('admin', 2).post('/api/ip-labels', { ip, label: 'x'.repeat(200) })).status, 400);
  });

  lotIt('W7-2', '66.6 IP reputation: tenant clear vs global clear; POST gated per status', async () => {
    const seedRep = async (): Promise<string> => {
      const ip = nextIp();
      await h.db('ip_reputation').insert({ ip, total_failures: 5 });
      return ip;
    };
    const failures = async (ip: string) => Number((await h.db('ip_reputation').whereRaw('host(ip) = ?', [ip]).first()).total_failures);
    const clears = async (ip: string) => (await h.db('ip_reputation_tenant_clears').where({ ip })).map((r) => r.tenant_id).sort();

    const a = await seedRep();
    assert.equal((await P('viewer', 2).post(`/api/ip-reputation/${a}/clear`)).status, 403);
    assert.equal((await P('user', 2).post(`/api/ip-reputation/${a}/clear`)).status, 200);
    assert.deepEqual(await clears(a), [2]);
    assert.equal(await failures(a), 5, 'tenant clear keeps the global counter');

    // The platform admin operating tenant 2 clears for tenant 2 only.
    const b = await seedRep();
    assert.equal((await P('platform', 2).post(`/api/ip-reputation/${b}/clear`)).status, 200);
    assert.deepEqual(await clears(b), [2]);
    assert.equal(await failures(b), 5);
    // A Default member clears for Default; only the platform admin on Default resets globally.
    assert.equal((await P('user', 1).post(`/api/ip-reputation/${b}/clear`)).status, 200);
    assert.deepEqual(await clears(b), [1, 2]);
    assert.equal((await P('platform', 1).post(`/api/ip-reputation/${b}/clear`)).status, 200);
    assert.equal(await failures(b), 0);
    assert.deepEqual(await clears(b), []);

    // POST /ip-reputation: by target status.
    const viewer = P('viewer', 2);
    for (const status of ['banned', 'whitelisted', 'clean', 'suspicious']) {
      assert.equal((await viewer.post('/api/ip-reputation', { ip: nextIp(), status })).status, 403, status);
    }
    const user = P('user', 2);
    const banned = nextIp();
    const rb = await user.post('/api/ip-reputation', { ip: banned, status: 'banned' });
    assert.equal(rb.status, 200, rb.text);
    const ban = await h.db('ip_bans').whereRaw('host(ip) = ?', [banned]).first();
    assert.equal(ban.scope, 'tenant');
    assert.equal(ban.tenant_id, 2);
    // Marking suspicious drops every tenant's clear baseline: Default tenant only.
    const c = await seedRep();
    assert.equal((await user.post('/api/ip-reputation', { ip: c, status: 'suspicious' })).status, 403);
    assert.equal((await P('platform', 2).post('/api/ip-reputation', { ip: c, status: 'suspicious' })).status, 403);
    assert.equal((await P('user', 1).post('/api/ip-reputation', { ip: c, status: 'suspicious' })).status, 200);
    // 'clean' from tenant 2 is a tenant clear.
    assert.equal((await user.post('/api/ip-reputation', { ip: c, status: 'clean' })).status, 200);
    assert.deepEqual(await clears(c), [2]);
    assert.equal(await failures(c), 5);
  });

  lotIt('W7-2', '66.7 integrations and notifications stay bound to the operating tenant', async () => {
    const tadmin = P('admin', 2);
    const ownMk = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: 'mk66-b.verify.test' });
    const foreignMk = await createMikrotikDevice(h.db, { tenantId: 3, keyId: 3, host: 'mk66-c.verify.test' });
    const mine = await tadmin.get(`/api/mikrotik/${ownMk.id}/credentials`);
    assert.equal(mine.status, 200, mine.text);
    assert.equal((await tadmin.get(`/api/mikrotik/${foreignMk.id}/credentials`)).status, 404);
    assert.equal((await tadmin.put(`/api/mikrotik/${foreignMk.id}/credentials`, { apiHost: 'evil.verify.test' })).status, 404);
    assert.equal((await tadmin.post(`/api/mikrotik/${foreignMk.id}/clear-log-cache`)).status, 404);
    assert.equal((await h.db('mikrotik_credentials').where({ device_id: foreignMk.id }).first()).api_host, 'mk66-c.verify.test');
    assert.equal((await P('viewer', 2).get(`/api/mikrotik/${ownMk.id}/credentials`)).status, 403);
    // Polling every tenant's routers is a platform action.
    assert.equal((await tadmin.post('/api/mikrotik/import/poll')).status, 403);

    // Notifications: delegated to notifications.manage, channels bound to their owner tenant.
    assert.equal((await P('user', 2).get('/api/notifications/channels')).status, 403);
    assert.equal((await tadmin.get('/api/notifications/channels')).status, 200);
    assert.equal((await tadmin.put(`/api/notifications/channels/${NONE}/tenants`, { tenantIds: [3] })).status, 404);
    assert.equal((await P('user', 2).put(`/api/notifications/channels/${NONE}/tenants`, { tenantIds: [3] })).status, 403);

    // Settings stay platform-only (critic C.2), tenant admin included.
    assert.equal((await tadmin.put('/api/settings/global/0', { key: 'checkIntervalSeconds', value: 30 })).status, 403);
    // Promote is Default-only even for a platform admin.
    assert.equal((await P('platform', 2).post(`/api/bans/${NONE}/promote-global`)).status, 403);
    assert.equal((await P('admin', 1).post(`/api/bans/${NONE}/promote-global`)).status, 404);
  });
});
