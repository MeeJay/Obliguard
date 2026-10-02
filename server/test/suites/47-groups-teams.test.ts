/**
 * 47 — groups and teams are bound to the operating tenant (A12): team grants
 * only target groups / agents of the team's tenant, group writes (create under
 * a parent, update, move, delete, reorder) never cross tenants (the Default
 * tenant included), and legacy Obliview 'monitor' grants no longer break the
 * group listing.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { U, G } from '../fixtures';
import { createGroup, createDevice, createKey, createUser } from '../seed';

const READ_ONLY = /read-only from the Default tenant/;

describe('47 groups and teams tenant scoping (A12)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  let seq = 0;
  async function team(tenantId: number, o: { members?: number[]; canCreate?: boolean } = {}): Promise<number> {
    const [t] = await h.db('user_teams')
      .insert({ name: `t47-${tenantId}-${Date.now()}-${++seq}`, tenant_id: tenantId, can_create: o.canCreate ?? false })
      .returning('id') as Array<{ id: number }>;
    for (const uid of o.members ?? []) await h.db('team_memberships').insert({ team_id: t.id, user_id: uid });
    return t.id;
  }
  const grant = (teamId: number, scope: string, scopeId: number, level = 'rw') =>
    h.db('team_permissions').insert({ team_id: teamId, scope, scope_id: scopeId, level });
  const permsOf = (teamId: number) => h.db('team_permissions').where({ team_id: teamId }).orderBy('id');
  const groupRow = (id: number) => h.db('monitor_groups').where({ id }).first();

  lotIt('A12', '47.1 a team permission on a foreign group or agent is refused (400)', async () => {
    const admin = await h.adminIn(1);
    const t1 = await team(1);

    const foreignGroup = await admin.put(`/api/teams/${t1}/permissions`, {
      permissions: [{ scope: 'group', scopeId: G.B, level: 'rw' }],
    });
    assert.equal(foreignGroup.status, 400, foreignGroup.text);
    assert.equal((await permsOf(t1)).length, 0);

    const key2 = await createKey(h.db, 2);
    const d2 = await createDevice(h.db, { tenantId: 2, keyId: key2.id });
    const foreignAgent = await admin.put(`/api/teams/${t1}/permissions`, {
      permissions: [{ scope: 'agent', scopeId: d2.id, level: 'ro' }],
    });
    assert.equal(foreignAgent.status, 400, foreignAgent.text);
    assert.equal((await permsOf(t1)).length, 0);

    // A mix of own and foreign ids is refused as a whole.
    const mixed = await admin.put(`/api/teams/${t1}/permissions`, {
      permissions: [{ scope: 'group', scopeId: G.DEFAULT, level: 'rw' }, { scope: 'group', scopeId: G.C, level: 'ro' }],
    });
    assert.equal(mixed.status, 400, mixed.text);
    assert.equal((await permsOf(t1)).length, 0);

    // The legacy Obliview scope is no longer accepted by the validator.
    const legacy = await admin.put(`/api/teams/${t1}/permissions`, {
      permissions: [{ scope: 'monitor', scopeId: 1, level: 'rw' }],
    });
    assert.equal(legacy.status, 400, legacy.text);

    // Own-tenant ids are accepted (agent scope included); duplicates merge to the highest level.
    const key1 = await createKey(h.db, 1);
    const d1 = await createDevice(h.db, { tenantId: 1, keyId: key1.id });
    const ok = await admin.put(`/api/teams/${t1}/permissions`, {
      permissions: [
        { scope: 'group', scopeId: G.DEFAULT, level: 'ro' },
        { scope: 'group', scopeId: G.DEFAULT, level: 'rw' },
        { scope: 'agent', scopeId: d1.id, level: 'ro' },
      ],
    });
    assert.equal(ok.status, 200, ok.text);
    const rows = await permsOf(t1);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.scope === 'group')?.level, 'rw');
    assert.equal(rows.find((r) => r.scope === 'agent')?.scope_id, d1.id);
  });

  lotIt('A12', '47.2 team writes follow the operating tenant; Default reads them (god view)', async () => {
    const t3 = await team(3);
    await grant(t3, 'group', G.C, 'ro');
    const fromDefault = await h.adminIn(1);

    const get = await fromDefault.get(`/api/teams/${t3}`);
    assert.equal(get.status, 200, get.text);

    const upd = await fromDefault.put(`/api/teams/${t3}`, { name: 'renamed-from-default' });
    assert.equal(upd.status, 403, upd.text);
    assert.match(String(upd.json?.error ?? upd.text), READ_ONLY);
    const perms = await fromDefault.put(`/api/teams/${t3}/permissions`, { permissions: [] });
    assert.equal(perms.status, 403, perms.text);
    assert.equal((await permsOf(t3)).length, 1);
    const members = await fromDefault.put(`/api/teams/${t3}/members`, { userIds: [U.member_c] });
    assert.equal(members.status, 403, members.text);
    const del = await fromDefault.del(`/api/teams/${t3}`);
    assert.equal(del.status, 403, del.text);
    assert.ok(await h.db('user_teams').where({ id: t3 }).first());

    // From another tenant the team does not exist.
    const fromB = await h.adminIn(2);
    assert.equal((await fromB.get(`/api/teams/${t3}`)).status, 404);
    assert.equal((await fromB.put(`/api/teams/${t3}`, { name: 'x' })).status, 404);
    const listB = await fromB.get('/api/teams?scope=all');
    assert.equal(listB.status, 200);
    assert.ok(!((listB.json?.data ?? []) as Array<{ id: number }>).some((t) => t.id === t3));

    // A permission id of another team is never removed through this team.
    const t2 = await team(2);
    const [foreignPerm] = await permsOf(t3);
    assert.equal((await fromB.del(`/api/teams/${t2}/permissions/${foreignPerm.id}`)).status, 404);
    assert.equal((await permsOf(t3)).length, 1);

    // Teams are created in the operating tenant only (a body tenantId is ignored).
    const cross = await fromDefault.post('/api/teams', { name: `cross-${Date.now()}`, tenantId: 3 });
    assert.equal(cross.status, 201, cross.text);
    assert.equal((await h.db('user_teams').where({ id: cross.json.data.id }).first()).tenant_id, 1);

    // From its own tenant the team is writable.
    const fromC = await h.adminIn(3);
    const own = await fromC.put(`/api/teams/${t3}`, { name: `t3-renamed-${Date.now()}` });
    assert.equal(own.status, 200, own.text);
  });

  lotIt('A12', '47.3 a group cannot move under a foreign parent', async () => {
    const x2 = await createGroup(h.db, { tenantId: 2, name: 'x2-move' });
    const tB = await team(2, { members: [U.member_b] });
    await grant(tB, 'group', x2, 'rw');
    // A tenant-3 team of the same user granting RW on the target parent.
    const tC = await team(3, { members: [U.member_b] });
    await grant(tC, 'group', G.C, 'rw');

    const mb = await h.login('member_b');
    const r1 = await mb.post(`/api/groups/${x2}/move`, { newParentId: G.C });
    assert.ok([403, 404].includes(r1.status), `got ${r1.status}`);
    assert.equal((await groupRow(x2)).parent_id, null);
    const leaked = await h.db('group_closure').where({ ancestor_id: G.C, descendant_id: x2 }).first();
    assert.equal(leaked, undefined);

    // Platform admin from Default: read-only god view (403), nothing moves.
    const admin = await h.adminIn(1);
    const r2 = await admin.post(`/api/groups/${x2}/move`, { newParentId: G.DEFAULT });
    assert.equal(r2.status, 403, r2.text);
    assert.equal((await groupRow(x2)).parent_id, null);

    // Platform admin from tenant 2 moving under a tenant-3 parent: not found.
    const adminB = await h.adminIn(2);
    const r3 = await adminB.post(`/api/groups/${x2}/move`, { newParentId: G.C });
    assert.equal(r3.status, 404, r3.text);
    assert.equal((await groupRow(x2)).parent_id, null);

    // Same-tenant move still works.
    const r4 = await adminB.post(`/api/groups/${x2}/move`, { newParentId: G.B });
    assert.equal(r4.status, 200, r4.text);
    assert.equal((await groupRow(x2)).parent_id, G.B);
  });

  lotIt('A12', '47.4 create, update, delete and reorder never cross tenants', async () => {
    const admin = await h.adminIn(1);
    const adminB = await h.adminIn(2);

    // Create under a foreign parent.
    const name = `child-${Date.now()}`;
    const c1 = await adminB.post('/api/groups', { name, parentId: G.C, kind: 'agent' });
    assert.ok([400, 403, 404].includes(c1.status), `got ${c1.status}`);
    assert.equal(await h.db('monitor_groups').where({ name }).first(), undefined);
    const c2 = await admin.post('/api/groups', { name, parentId: G.B, kind: 'agent' });
    assert.equal(c2.status, 403, c2.text);
    assert.equal(await h.db('monitor_groups').where({ name }).first(), undefined);

    const x3 = await createGroup(h.db, { tenantId: 3, name: 'x3-keep' });
    assert.equal((await adminB.put(`/api/groups/${x3}`, { name: 'x' })).status, 404);
    assert.equal((await admin.put(`/api/groups/${x3}`, { name: 'x' })).status, 403);
    assert.equal((await adminB.del(`/api/groups/${x3}`)).status, 404);
    assert.equal((await admin.del(`/api/groups/${x3}`)).status, 403);
    assert.equal((await groupRow(x3)).name, 'x3-keep');

    const before = (await groupRow(x3)).sort_order;
    const ro = await adminB.post('/api/groups/reorder', { items: [{ id: G.B, sortOrder: 5 }, { id: x3, sortOrder: before + 7 }] });
    assert.equal(ro.status, 404, ro.text);
    assert.equal((await groupRow(x3)).sort_order, before);
    const roD = await admin.post('/api/groups/reorder', { items: [{ id: x3, sortOrder: before + 7 }] });
    assert.equal(roD.status, 403, roD.text);
    assert.equal((await groupRow(x3)).sort_order, before);

    // A foreign group is not readable by id outside Default.
    assert.equal((await adminB.get(`/api/groups/${x3}`)).status, 404);
    assert.equal((await admin.get(`/api/groups/${x3}`)).status, 200);

    // Own tenant still works.
    const fromC = await h.adminIn(3);
    assert.equal((await fromC.put(`/api/groups/${x3}`, { name: 'x3-renamed' })).status, 200);
    assert.equal((await fromC.post('/api/groups/reorder', { items: [{ id: x3, sortOrder: before + 1 }] })).status, 200);
    assert.equal((await groupRow(x3)).sort_order, before + 1);
  });

  lotIt('A12', '47.5 a legacy monitor grant no longer breaks the group listing', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const x2 = await createGroup(h.db, { tenantId: 2, name: 'x2-legacy' });
    const t = await team(2, { members: [u.id] });
    await grant(t, 'monitor', 424242, 'rw');
    await grant(t, 'group', x2, 'ro');

    const c = await h.login(u.username);
    const list = await c.get('/api/groups');
    assert.equal(list.status, 200, list.text);
    assert.ok(((list.json?.data ?? []) as Array<{ id: number }>).some((g) => g.id === x2));
    const tree = await c.get('/api/groups/tree');
    assert.equal(tree.status, 200, tree.text);
    assert.equal((await c.get(`/api/groups/${x2}`)).status, 200);
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200, me.text);

    // The legacy row is ignored at read time, then dropped on the next setPermissions.
    const adminB = await h.adminIn(2);
    const detail = await adminB.get(`/api/teams/${t}`);
    assert.equal(detail.status, 200, detail.text);
    const scopes = ((detail.json?.data?.permissions ?? []) as Array<{ scope: string }>).map((p) => p.scope);
    assert.deepEqual(scopes, ['group']);
    const set = await adminB.put(`/api/teams/${t}/permissions`, { permissions: [{ scope: 'group', scopeId: x2, level: 'rw' }] });
    assert.equal(set.status, 200, set.text);
    const rows = await permsOf(t);
    assert.deepEqual(rows.map((r) => r.scope), ['group']);
  });

  lotIt('A12', '47.6 a team of another tenant grants nothing in the operating tenant', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const x3 = await createGroup(h.db, { tenantId: 3, name: 'x3-other' });
    const t3 = await team(3, { members: [u.id] });
    await grant(t3, 'group', x3, 'rw');
    const c = await h.login(u.username);
    const r = await c.put(`/api/groups/${x3}`, { name: 'hijack' });
    assert.ok([403, 404].includes(r.status), `got ${r.status}`);
    assert.equal((await groupRow(x3)).name, 'x3-other');
    const me = await c.get('/api/auth/me');
    const perms = (me.json?.data?.permissions?.permissions ?? me.json?.data?.user?.permissions?.permissions ?? {}) as Record<string, string>;
    assert.equal(perms[`group:${x3}`], undefined);
  });
});
