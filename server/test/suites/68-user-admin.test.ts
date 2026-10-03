/**
 * 68 — W7-3 delegated user and team management: users.manage and the
 * domination rules (Obliance userScope port).
 *
 *   68.1 /users and /teams need users.manage: a 'user' or 'viewer' member is
 *        refused; a tenant admin lists only the members of its tenant
 *   68.2 a tenant admin of tenant 2 creates a local user in tenant 2; never a
 *        platform administrator
 *   68.3 a custom users.manage set only grants / manages roles whose
 *        capabilities it holds ('admin' never)
 *   68.4 other tenants: their users are not found; an account that also
 *        belongs to a tenant the caller does not administer is refused;
 *        tenant access only changes the operating tenant's row
 *   68.5 platform admins and og_ (SSO) accounts are out of reach
 *   68.6 the last active platform admin cannot be demoted; no platform role
 *        change, no own tenant access change for a tenant admin
 *   68.7 tenant members endpoints: users.manage in that tenant, same rules;
 *        platform admins unchanged
 *   68.8 teams: tenant-local writes, members of the team tenant only,
 *        'ungrouped' scope, scope ids validated
 *   68.9 a manager bound by team grants never changes its own teams nor
 *        adds itself to one (no self-widening)
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import { U, G, TEAMS, PASSWORD } from '../fixtures';
import { createUser, VIEWER_B } from '../seed';

describe('68 delegated user admin (W7-3)', () => {
  let h: Harness;
  let tadmin: { id: number; username: string };
  let ta: Client;

  before(async () => {
    h = await startHarness();
    tadmin = await createUser(h.db, { tenants: [2], tenantRole: 'admin' });
    ta = await h.login(tadmin.username);
    assert.equal((await ta.switchTenant(2)).status, 200);
  });
  after(async () => { await h.close(); });

  const roleOf = async (userId: number, tenantId: number): Promise<string | undefined> =>
    (await h.db('user_tenants').where({ user_id: userId, tenant_id: tenantId }).first('role'))?.role;
  const uname = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

  /** A permission set 'mgr-*' holding users.manage + the viewer capabilities. */
  const managerIn2 = async (): Promise<{ user: { id: number; username: string }; client: Client; slug: string }> => {
    const slug = uname('mgr-');
    await h.db('permission_sets').insert({
      name: slug, slug, is_default: false,
      capabilities: JSON.stringify(['users.manage', 'ips.view', 'firewall.rules.read']),
    });
    const user = await createUser(h.db, { tenants: [2], tenantRole: slug });
    const client = await h.login(user.username);
    assert.equal((await client.switchTenant(2)).status, 200);
    return { user, client, slug };
  };

  lotIt('W7-3', '68.1 users.manage gates /users and /teams; the list is tenant-local', async () => {
    for (const name of ['member_b', VIEWER_B.username]) {
      const c = await h.as(name);
      assert.equal((await c.get('/api/users')).status, 403, name);
      assert.equal((await c.post('/api/users', { username: uname('x'), password: PASSWORD })).status, 403, name);
      assert.equal((await c.get('/api/teams')).status, 403, name);
      assert.equal((await c.post('/api/teams', { name: uname('t') })).status, 403, name);
    }
    const r = await ta.get('/api/users');
    assert.equal(r.status, 200, r.text);
    const ids = (r.json.data as Array<{ id: number }>).map((u) => u.id);
    assert.ok(ids.includes(U.member_b));
    assert.ok(ids.includes(tadmin.id));
    for (const other of [U.default_member, U.member_c, U.admin, U.no_tenant]) {
      assert.ok(!ids.includes(other), `user ${other} must not be listed in tenant 2`);
    }
    assert.equal((await ta.get('/api/teams')).status, 200);
  });

  lotIt('W7-3', '68.2 a tenant admin creates a local user in its tenant, never a platform admin', async () => {
    const name = uname('local');
    const r = await ta.post('/api/users', { username: name, password: PASSWORD, tenantRole: 'viewer' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.data.role, 'user');
    assert.equal(await roleOf(r.json.data.id, 2), 'viewer');
    assert.equal((await h.db('user_tenants').where({ user_id: r.json.data.id }).count('* as n').first())?.n, '1');
    // The new account can sign in and lands in tenant 2.
    const c = await h.login(name);
    assert.equal((await c.get('/api/auth/me')).json.data.currentTenantId, 2);

    const dflt = await ta.post('/api/users', { username: uname('dflt'), password: PASSWORD });
    assert.equal(dflt.status, 201, dflt.text);
    assert.equal(await roleOf(dflt.json.data.id, 2), 'user');

    const plat = uname('plat');
    const refused = await ta.post('/api/users', { username: plat, password: PASSWORD, role: 'admin' });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(await h.db('users').where({ username: plat }).first(), undefined);
    assert.equal((await ta.post('/api/users', { username: uname('bad'), password: PASSWORD, tenantRole: 'no-such-set' })).status, 400);

    // A tenant admin may grant the tenant admin role.
    const sub = await ta.post('/api/users', { username: uname('sub'), password: PASSWORD, tenantRole: 'admin' });
    assert.equal(sub.status, 201, sub.text);
    assert.equal(await roleOf(sub.json.data.id, 2), 'admin');
  });

  lotIt('W7-3', '68.3 a custom users.manage set cannot assign admin nor roles above its own', async () => {
    const { client: mgr } = await managerIn2();
    const adm = uname('adm');
    assert.equal((await mgr.post('/api/users', { username: adm, password: PASSWORD, tenantRole: 'admin' })).status, 403);
    assert.equal((await mgr.post('/api/users', { username: uname('usr'), password: PASSWORD, tenantRole: 'user' })).status, 403);
    assert.equal((await mgr.post('/api/users', { username: uname('usr'), password: PASSWORD })).status, 403, 'default role user is above the set');
    assert.equal(await h.db('users').where({ username: adm }).first(), undefined);
    const ok = await mgr.post('/api/users', { username: uname('vw'), password: PASSWORD, tenantRole: 'viewer' });
    assert.equal(ok.status, 201, ok.text);

    // Dominated (viewer) → manageable; a 'user' or an 'admin' member is not.
    assert.equal((await mgr.put(`/api/users/${ok.json.data.id}`, { displayName: 'Viewer' })).status, 200);
    assert.equal((await mgr.put(`/api/users/${U.member_b}`, { displayName: 'nope' })).status, 403);
    assert.equal((await mgr.del(`/api/users/${tadmin.id}/2fa`)).status, 403);
    assert.equal((await mgr.put(`/api/users/${ok.json.data.id}/tenants`, { assignments: [{ tenantId: 2, role: 'user' }] })).status, 403);
    assert.equal((await mgr.put(`/api/users/${ok.json.data.id}/tenants`, { assignments: [{ tenantId: 2, role: 'admin' }] })).status, 403);
    assert.equal(await roleOf(ok.json.data.id, 2), 'viewer');
  });

  lotIt('W7-3', '68.4 other tenants are out of reach; only the operating tenant row changes', async () => {
    for (const id of [U.default_member, U.member_c]) {
      assert.equal((await ta.get(`/api/users/${id}`)).status, 404);
      assert.equal((await ta.put(`/api/users/${id}`, { displayName: 'x' })).status, 404);
      assert.equal((await ta.put(`/api/users/${id}/password`, { password: 'Other-Pass-9!' })).status, 404);
      assert.equal((await ta.del(`/api/users/${id}/2fa`)).status, 404);
      assert.equal((await ta.del(`/api/users/${id}`)).status, 404);
      assert.equal((await ta.get(`/api/users/${id}/tenants`)).status, 404);
    }
    assert.ok(await h.db('users').where({ id: U.member_c }).first());

    // Also a member of tenant 3, where the caller is not admin: refused.
    const both = await createUser(h.db, { tenants: [2, 3] });
    assert.equal((await ta.put(`/api/users/${both.id}`, { displayName: 'x' })).status, 403);
    // Only the operating tenant's row is shown.
    const rows = (await ta.get(`/api/users/${both.id}/tenants`)).json.data as Array<{ tenantId: number }>;
    assert.deepEqual(rows.map((r) => r.tenantId), [2]);

    // Admin of 2 and 3: the tenant-3 row is kept, never changed from tenant 2.
    const t23 = await createUser(h.db, { tenants: [2, 3], tenantRole: 'admin' });
    const c23 = await h.login(t23.username);
    assert.equal((await c23.switchTenant(2)).status, 200);
    const put = (assignments: unknown) => c23.put(`/api/users/${both.id}/tenants`, { assignments });
    assert.equal((await put([{ tenantId: 2, role: 'viewer' }, { tenantId: 3, role: 'admin' }])).status, 403);
    assert.equal((await put([{ tenantId: 2, role: 'viewer' }])).status, 200);
    assert.equal(await roleOf(both.id, 2), 'viewer');
    assert.equal(await roleOf(both.id, 3), 'user');
    assert.equal((await put([{ tenantId: 1, role: 'user' }])).status, 403);
    assert.equal(await roleOf(both.id, 1), undefined);
  });

  lotIt('W7-3', '68.5 platform admins and og_ accounts cannot be edited by a tenant admin', async () => {
    const plat = await createUser(h.db, { role: 'admin', tenants: [2] });
    assert.equal((await ta.put(`/api/users/${plat.id}`, { displayName: 'x' })).status, 403);
    assert.equal((await ta.put(`/api/users/${plat.id}/password`, { password: 'Other-Pass-9!' })).status, 403);
    assert.equal((await ta.del(`/api/users/${plat.id}`)).status, 403);
    assert.equal((await ta.put(`/api/users/${U.admin}`, { displayName: 'x' })).status, 404, 'not a member of tenant 2');

    // og_ account (SSO): read-only.
    assert.equal((await ta.get(`/api/users/${U.og_sso}`)).status, 200);
    const before = await h.db('users').where({ id: U.og_sso }).first('display_name', 'is_active');
    assert.equal((await ta.put(`/api/users/${U.og_sso}`, { displayName: 'hijack' })).status, 403);
    assert.equal((await ta.put(`/api/users/${U.og_sso}`, { isActive: false })).status, 403);
    assert.equal((await ta.del(`/api/users/${U.og_sso}/2fa`)).status, 403);
    assert.equal((await ta.del(`/api/users/${U.og_sso}`)).status, 403);
    assert.equal((await ta.put(`/api/users/${U.og_sso}/tenants`, { assignments: [{ tenantId: 2, role: 'viewer' }] })).status, 403);
    assert.equal((await ta.put(`/api/tenants/2/members/${U.og_sso}`, { role: 'viewer' })).status, 403);
    assert.deepEqual(await h.db('users').where({ id: U.og_sso }).first('display_name', 'is_active'), before);
    assert.equal(await roleOf(U.og_sso, 2), 'user');
  });

  lotIt('W7-3', '68.6 last admin cannot be demoted; no platform role change by a tenant admin', async () => {
    const local = await createUser(h.db, { tenants: [2] });
    assert.equal((await ta.put(`/api/users/${local.id}`, { role: 'admin' })).status, 403);
    assert.equal((await h.db('users').where({ id: local.id }).first('role')).role, 'user');
    // The edit form resends the unchanged role: accepted.
    assert.equal((await ta.put(`/api/users/${local.id}`, { role: 'user', displayName: 'Local' })).status, 200);
    // A tenant admin cannot change its own tenant role, nor disable itself.
    assert.equal((await ta.put(`/api/users/${tadmin.id}/tenants`, { assignments: [{ tenantId: 2, role: 'viewer' }] })).status, 403);
    assert.equal((await ta.put(`/api/tenants/2/members/${tadmin.id}`, { role: 'viewer' })).status, 403);
    assert.equal((await ta.put(`/api/users/${tadmin.id}`, { isActive: false })).status, 400);
    assert.equal(await roleOf(tadmin.id, 2), 'admin');

    // Platform: the last active platform administrator is never demoted.
    const admin = await h.as('admin');
    const others = await h.db('users').where({ role: 'admin', is_active: true }).whereNot({ id: U.admin }).pluck('id');
    await h.db('users').whereIn('id', others).update({ is_active: false });
    try {
      const r = await admin.put(`/api/users/${U.admin}`, { role: 'user' });
      assert.equal(r.status, 400, r.text);
      assert.match(String(r.json?.error), /last active admin/i);
      assert.equal((await h.db('users').where({ id: U.admin }).first('role')).role, 'admin');
    } finally {
      await h.db('users').whereIn('id', others).update({ is_active: true });
    }
  });

  lotIt('W7-3', '68.7 tenant members endpoints are delegated through users.manage', async () => {
    assert.equal((await (await h.as('member_b')).get('/api/tenants/2/members')).status, 403);
    assert.equal((await ta.get('/api/tenants/2/members')).status, 200);
    assert.equal((await ta.get('/api/tenants/3/members')).status, 403);
    assert.equal((await ta.post('/api/tenants/3/members', { userId: tadmin.id })).status, 403);

    const local = await createUser(h.db, { tenants: [2] });
    assert.equal((await ta.put(`/api/tenants/2/members/${local.id}`, { role: 'viewer' })).status, 200);
    assert.equal(await roleOf(local.id, 2), 'viewer');
    assert.equal((await ta.put(`/api/tenants/2/members/${local.id}`, { role: 'bogus' })).status, 400);
    // Bringing an account of another tenant in stays a platform operation.
    assert.equal((await ta.post('/api/tenants/2/members', { userId: U.member_c })).status, 404);
    assert.equal(await roleOf(U.member_c, 2), undefined);
    assert.equal((await ta.del(`/api/tenants/2/members/${tadmin.id}`)).status, 403);

    const { client: mgr } = await managerIn2();
    assert.equal((await mgr.put(`/api/tenants/2/members/${local.id}`, { role: 'admin' })).status, 403);
    assert.equal((await mgr.del(`/api/tenants/2/members/${U.member_b}`)).status, 403);
    assert.equal(await roleOf(U.member_b, 2), 'user');

    assert.equal((await ta.del(`/api/tenants/2/members/${local.id}`)).status, 200);
    assert.equal(await roleOf(local.id, 2), undefined);

    // Platform admins: unchanged (any tenant, any account).
    const admin = await h.adminIn(1);
    assert.equal((await admin.post('/api/tenants/3/members', { userId: local.id, role: 'viewer' })).status, 200);
    assert.equal(await roleOf(local.id, 3), 'viewer');
  });

  lotIt('W7-3', '68.8 teams: tenant-local writes, tenant members only, ungrouped scope', async () => {
    const created = await ta.post('/api/teams', { name: uname('team') });
    assert.equal(created.status, 201, created.text);
    const id = created.json.data.id as number;
    assert.equal(created.json.data.tenantId, 2);

    const notMember = await ta.put(`/api/teams/${id}/members`, { userIds: [U.member_c] });
    assert.equal(notMember.status, 400, notMember.text);
    assert.equal((await ta.put(`/api/teams/${id}/members`, { userIds: [U.member_b, U.member_b] })).status, 200);
    assert.deepEqual(await h.db('team_memberships').where({ team_id: id }).pluck('user_id'), [U.member_b]);

    const perms = await ta.put(`/api/teams/${id}/permissions`, {
      permissions: [
        { scope: 'ungrouped', scopeId: 42, level: 'ro' },
        { scope: 'group', scopeId: G.B, level: 'rw' },
      ],
    });
    assert.equal(perms.status, 200, perms.text);
    const rows = await h.db('team_permissions').where({ team_id: id }).select('scope', 'scope_id', 'level');
    assert.deepEqual(rows.find((r) => r.scope === 'ungrouped'), { scope: 'ungrouped', scope_id: 0, level: 'ro' });
    assert.equal((await ta.get(`/api/teams/${id}`)).json.data.permissions.length, 2);

    assert.equal((await ta.put(`/api/teams/${id}/permissions`, { permissions: [{ scope: 'group', scopeId: G.C, level: 'ro' }] })).status, 400);
    assert.equal((await ta.put(`/api/teams/${id}/permissions`, { permissions: [{ scope: 'group', scopeId: 0, level: 'ro' }] })).status, 400);
    assert.equal((await h.db('team_permissions').where({ team_id: id })).length, 2);

    // A team of another tenant does not exist here.
    assert.equal((await ta.get(`/api/teams/${TEAMS.C_TEAM.id}`)).status, 404);
    assert.equal((await ta.put(`/api/teams/${TEAMS.C_TEAM.id}`, { name: 'x' })).status, 404);
    assert.equal((await ta.del(`/api/teams/${TEAMS.C_TEAM.id}`)).status, 404);
    assert.equal((await ta.del(`/api/teams/${id}`)).status, 200);
  });

  lotIt('W7-3', '68.9 a team-scoped manager never widens its own rights through teams', async () => {
    const { user: me, client: mgr } = await managerIn2();
    // A team that binds the manager's agent scope (group B only).
    const own = await ta.post('/api/teams', { name: uname('own') });
    assert.equal(own.status, 201, own.text);
    const ownId = own.json.data.id as number;
    assert.equal((await ta.put(`/api/teams/${ownId}/members`, { userIds: [me.id] })).status, 200);
    assert.equal((await ta.put(`/api/teams/${ownId}/permissions`, { permissions: [{ scope: 'group', scopeId: G.B, level: 'ro' }] })).status, 200);

    // Its own team: no grant, can_create, membership or deletion change.
    assert.equal((await mgr.put(`/api/teams/${ownId}/permissions`, { permissions: [{ scope: 'ungrouped', scopeId: 0, level: 'rw' }] })).status, 403);
    assert.equal((await mgr.put(`/api/teams/${ownId}`, { canCreate: true })).status, 403);
    assert.equal((await mgr.put(`/api/teams/${ownId}/members`, { userIds: [] })).status, 403);
    assert.equal((await mgr.del(`/api/teams/${ownId}`)).status, 403);
    assert.deepEqual(await h.db('team_memberships').where({ team_id: ownId }).pluck('user_id'), [me.id]);

    // Another team: manageable, but never with itself as a member.
    const other = await mgr.post('/api/teams', { name: uname('other') });
    assert.equal(other.status, 201, other.text);
    const otherId = other.json.data.id as number;
    assert.equal((await mgr.put(`/api/teams/${otherId}/permissions`, { permissions: [{ scope: 'group', scopeId: G.B, level: 'rw' }] })).status, 200);
    assert.equal((await mgr.put(`/api/teams/${otherId}/members`, { userIds: [me.id] })).status, 403);
    assert.equal((await mgr.put(`/api/teams/${otherId}/members`, { userIds: [U.member_b] })).status, 200);

    // A tenant admin is not bound by teams: it edits its own teams.
    assert.equal((await ta.put(`/api/teams/${otherId}/members`, { userIds: [U.member_b, tadmin.id] })).status, 200);
    assert.equal((await ta.put(`/api/teams/${otherId}`, { canCreate: true })).status, 200);
    assert.equal((await ta.del(`/api/teams/${otherId}`)).status, 200);
    assert.equal((await ta.del(`/api/teams/${ownId}`)).status, 200);
  });
});
