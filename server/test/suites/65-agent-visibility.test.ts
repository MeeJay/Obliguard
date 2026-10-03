/**
 * 65 — agent visibility and per-agent write permission through teams (RBAC-8,
 * TEAM_SCOPE_MODE 'restrict_if_granted'): a user holding team grants in the
 * operating tenant lists, reads and writes only the agents those grants cover
 * (group subtree, direct agent, 'ungrouped'); a hidden agent answers 404, a
 * read-only one 403 on a write; a user without grants keeps the whole tenant;
 * platform admins and tenant admins are never restricted.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import { D, G, U } from '../fixtures';
import { createDevice, createGroup, createUser } from '../seed';
import { permissionService, UNGROUPED_SCOPE_ID } from '../../src/services/permission.service';
import { dashboardService } from '../../src/services/dashboard.service';
import { TENANT_CAPABILITY_KEYS } from '@obliview/shared';
import { __resetAgentUpdateStateForTest, __setServedAgentVersionForTest } from '../../src/services/agent.service';

/**
 * Tenant role holding every tenant capability without being 'admin': the route
 * guards pass, so only the team rule decides.
 */
const OPERATOR = 'w71-operator';

const READ_ONLY = /read-only/i;

describe('65 agent visibility through teams (RBAC-8)', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
    await h.db('permission_sets').insert({ name: 'W7-1 operator', slug: OPERATOR, capabilities: JSON.stringify([...TENANT_CAPABILITY_KEYS]) });
  });
  after(async () => {
    __resetAgentUpdateStateForTest();
    await h.close();
  });

  let seq = 0;
  async function team(tenantId: number, members: number[], grants: Array<[string, number, 'ro' | 'rw']>): Promise<number> {
    const [t] = await h.db('user_teams')
      .insert({ name: `t65-${tenantId}-${Date.now()}-${++seq}`, tenant_id: tenantId, can_create: false })
      .returning('id') as Array<{ id: number }>;
    for (const uid of members) await h.db('team_memberships').insert({ team_id: t.id, user_id: uid });
    for (const [scope, scopeId, level] of grants) {
      await h.db('team_permissions').insert({ team_id: t.id, scope, scope_id: scopeId, level });
    }
    return t.id;
  }

  /** A group G of tenant 2 with a sub-group, and agents in G, the sub-group, another group and no group. */
  async function layout() {
    const g = await createGroup(h.db, { tenantId: 2 });
    const sub = await createGroup(h.db, { tenantId: 2 });
    await h.db('monitor_groups').where({ id: sub }).update({ parent_id: g });
    await h.db('group_closure').insert({ ancestor_id: g, descendant_id: sub, depth: 1 });
    const other = await createGroup(h.db, { tenantId: 2 });
    const inG = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: g });
    const inSub = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: sub });
    const inOther = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: other });
    const ungrouped = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: null });
    return { g, sub, other, inG: inG.id, inSub: inSub.id, inOther: inOther.id, ungrouped: ungrouped.id };
  }

  async function listedIds(c: Client, query = ''): Promise<number[]> {
    const r = await c.get(`/api/agent/devices${query}`);
    assert.equal(r.status, 200, r.text);
    return (r.json.data as Array<{ id: number }>).map((d) => d.id);
  }
  const name = async (id: number) => (await h.db('agent_devices').where({ id }).first('name'))?.name ?? null;

  lotIt('W7-1', '65.1 a RO grant on a group: only that subtree is listed, 404 elsewhere, 403 on writes', async () => {
    const L = await layout();
    const u = await createUser(h.db, { tenants: [2], tenantRole: OPERATOR });
    await team(2, [u.id], [['group', L.g, 'ro']]);
    const c = await h.login(u.username);

    const ids = await listedIds(c);
    assert.ok(ids.includes(L.inG) && ids.includes(L.inSub), 'group subtree listed');
    for (const hidden of [L.inOther, L.ungrouped, D.B.id, D.B_EVAL.id, D.B_PENDING.id]) {
      assert.ok(!ids.includes(hidden), `agent ${hidden} hidden`);
    }
    // Filters keep the restriction.
    assert.deepEqual((await listedIds(c, `?groupId=${L.other}`)), []);
    assert.deepEqual((await listedIds(c, '?groupId=none')), []);

    const one = await c.get(`/api/agent/devices/${L.inSub}`);
    assert.equal(one.status, 200, one.text);
    assert.equal(one.json.data.accessLevel, 'ro');
    assert.equal((await c.get(`/api/agent/devices/${L.inOther}`)).status, 404);
    assert.equal((await c.get(`/api/agent/devices/${L.inOther}/templates`)).status, 404);

    const ro = await c.patch(`/api/agent/devices/${L.inG}`, { name: 'ro-write' });
    assert.equal(ro.status, 403, ro.text);
    assert.match(String(ro.json?.error ?? ''), READ_ONLY);
    assert.equal(await name(L.inG), null);
    assert.equal((await c.patch(`/api/agent/devices/${L.inOther}`, { name: 'hidden-write' })).status, 404);
    assert.equal(await name(L.inOther), null);
    assert.equal((await c.del(`/api/agent/devices/${L.inG}`)).status, 403);
    assert.equal((await c.post(`/api/agent/devices/${L.inG}/command`, { command: 'uninstall' })).status, 403);
    assert.equal((await c.post(`/api/agent/devices/${L.inG}/firewall/rules`, {})).status, 403);
    assert.equal((await c.post(`/api/agent/devices/${L.inOther}/firewall/rules`, {})).status, 404);

    // Bulk writes drop read-only and hidden agents.
    const bulk = await c.patch('/api/agent/devices/bulk', { deviceIds: [L.inG, L.inOther], status: 'suspended' });
    assert.equal(bulk.status, 200, bulk.text);
    assert.deepEqual(bulk.json.data, { affected: 0, skipped: 2 });
    const statuses = await h.db('agent_devices').whereIn('id', [L.inG, L.inOther]).pluck('status');
    assert.deepEqual(statuses, ['approved', 'approved']);
    const bulkDel = await c.del('/api/agent/devices/bulk', { deviceIds: [L.inG, L.inOther] });
    assert.equal(bulkDel.status, 200, bulkDel.text);
    assert.equal(bulkDel.json.data.affected, 0);

    // Online count and version distribution only cover the visible agents.
    const stats = await c.get('/api/agent/devices/stats');
    assert.equal(stats.status, 200, stats.text);
    assert.equal(stats.json.data.online, 2);
    const versions = await c.get('/api/agent/devices/versions');
    assert.equal(versions.status, 200, versions.text);
    assert.equal(versions.json.data.total, 2);
  });

  lotIt('W7-1', '65.2 RW grants: writes pass on granted agents only', async () => {
    const L = await layout();
    const u = await createUser(h.db, { tenants: [2], tenantRole: OPERATOR });
    await team(2, [u.id], [['group', L.sub, 'rw'], ['agent', L.inOther, 'rw'], ['group', L.g, 'ro']]);
    const c = await h.login(u.username);

    const ids = await listedIds(c);
    assert.ok([L.inG, L.inSub, L.inOther].every((id) => ids.includes(id)));
    assert.ok(!ids.includes(L.ungrouped));

    // The highest level wins: the sub-group is RW although its parent is RO.
    const sub = await c.patch(`/api/agent/devices/${L.inSub}`, { name: 'rw-sub' });
    assert.equal(sub.status, 200, sub.text);
    assert.equal(await name(L.inSub), 'rw-sub');
    const direct = await c.patch(`/api/agent/devices/${L.inOther}`, { name: 'rw-agent' });
    assert.equal(direct.status, 200, direct.text);
    assert.equal(await name(L.inOther), 'rw-agent');
    assert.equal((await c.patch(`/api/agent/devices/${L.inG}`, { name: 'x' })).status, 403);

    const bulk = await c.patch('/api/agent/devices/bulk', { deviceIds: [L.inG, L.inSub, L.ungrouped], overrideGroupSettings: true });
    assert.equal(bulk.status, 200, bulk.text);
    assert.deepEqual(bulk.json.data, { affected: 1, skipped: 2 });

    assert.equal(await permissionService.getAgentPermission(u.id, 2, L.inSub), 'rw');
    assert.equal(await permissionService.getAgentPermission(u.id, 2, L.inG), 'ro');
    assert.equal(await permissionService.getAgentPermission(u.id, 2, L.ungrouped), 'none');
  });

  lotIt('W7-1', '65.3 no team grant in the tenant: every agent of the tenant (default mode)', async () => {
    const L = await layout();
    const u = await createUser(h.db, { tenants: [2], tenantRole: OPERATOR });
    // A team without grants, and a grant through a team of ANOTHER tenant, restrict nothing here.
    await team(2, [u.id], []);
    await team(3, [u.id], [['group', G.C, 'ro']]);
    const c = await h.login(u.username);

    assert.equal(await permissionService.getVisibleAgentIds(u.id, 2), 'all');
    const ids = await listedIds(c);
    for (const id of [L.inG, L.inSub, L.inOther, L.ungrouped, D.B.id, D.B_EVAL.id, D.B_PENDING.id]) {
      assert.ok(ids.includes(id), `agent ${id} listed`);
    }
    assert.ok(!ids.includes(D.C.id), 'never another tenant');
    const one = await c.get(`/api/agent/devices/${L.inOther}`);
    assert.equal(one.json?.data?.accessLevel, 'rw');
    const w = await c.patch(`/api/agent/devices/${L.inOther}`, { name: 'free' });
    assert.equal(w.status, 200, w.text);

    // The fixture member keeps its whole tenant too.
    assert.ok((await listedIds(await h.as('member_b'))).includes(D.B_EVAL.id));
  });

  lotIt('W7-1', '65.4 the ungrouped scope covers the agents in no group of the tenant', async () => {
    const L = await layout();
    const u = await createUser(h.db, { tenants: [2], tenantRole: OPERATOR });
    await team(2, [u.id], [['ungrouped', UNGROUPED_SCOPE_ID, 'rw']]);
    const c = await h.login(u.username);

    const ids = await listedIds(c);
    assert.ok(ids.includes(L.ungrouped) && ids.includes(D.B_PENDING.id));
    assert.ok(![L.inG, L.inSub, L.inOther, D.B.id].some((id) => ids.includes(id)));
    const ungroupedOfC = await createDevice(h.db, { tenantId: 3, keyId: 3, groupId: null });
    assert.ok(!ids.includes(ungroupedOfC.id), 'never the ungrouped agents of another tenant');
    assert.equal(await permissionService.getAgentPermission(u.id, 2, ungroupedOfC.id), 'none');

    const w = await c.patch(`/api/agent/devices/${L.ungrouped}`, { name: 'ungrouped-rw' });
    assert.equal(w.status, 200, w.text);
    assert.equal(await name(L.ungrouped), 'ungrouped-rw');
    assert.equal((await c.patch(`/api/agent/devices/${L.inG}`, { name: 'x' })).status, 404);
  });

  lotIt('W7-1', '65.5 platform admins and tenant admins are never restricted by team grants', async () => {
    const L = await layout();
    const tadmin = await createUser(h.db, { tenants: [2], tenantRole: 'admin' });
    await team(2, [tadmin.id, U.admin], [['group', L.g, 'ro']]);
    for (const c of [await h.login(tadmin.username), await h.adminIn(2)]) {
      const ids = await listedIds(c);
      assert.ok([L.inG, L.inOther, L.ungrouped].every((id) => ids.includes(id)));
      const w = await c.patch(`/api/agent/devices/${L.inOther}`, { name: `admin-${Date.now()}` });
      assert.equal(w.status, 200, w.text);
    }
    assert.equal(await permissionService.getVisibleAgentIds(tadmin.id, 2), 'all');
  });

  lotIt('W7-1', '65.6 dashboard counters cover the visible agents only', async () => {
    const L = await layout();
    const u = await createUser(h.db, { tenants: [2], tenantRole: OPERATOR });
    await team(2, [u.id], [['group', L.g, 'ro']]);
    const visible = await permissionService.getVisibleAgentIds(u.id, 2);
    assert.ok(Array.isArray(visible));
    assert.deepEqual([...visible].sort((a, b) => a - b), [L.inG, L.inSub].sort((a, b) => a - b));
    const restricted = await dashboardService.getSummary(2, visible);
    assert.equal(restricted.agentsTotal, 2);
    assert.deepEqual(restricted.perAgent.map((a) => a.deviceId).sort((a, b) => a - b), [L.inG, L.inSub].sort((a, b) => a - b));
    const full = await dashboardService.getSummary(2);
    assert.ok(full.agentsTotal >= 5);
    assert.equal((await dashboardService.getSummary(2, [])).agentsTotal, 0);
  });

  lotIt('W7-1', '65.7 group update touches writable agents only; a grant ends the Default god view', async () => {
    const L = await layout();
    const u = await createUser(h.db, { tenants: [2], tenantRole: OPERATOR });
    await team(2, [u.id], [['group', L.g, 'ro'], ['group', L.sub, 'rw']]);
    const c = await h.login(u.username);
    __setServedAgentVersionForTest('9.9.9');
    try {
      // A group no grant covers does not exist for the user.
      assert.equal((await c.post(`/api/agent/groups/${L.other}/agent-update`)).status, 404);
      const r = await c.post(`/api/agent/groups/${L.g}/agent-update`);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.data.requested, 1, 'only the RW sub-group agent');
      const requested = await h.db('agent_devices').whereIn('id', [L.inG, L.inSub, L.inOther])
        .whereNotNull('update_requested_at').pluck('id');
      assert.deepEqual(requested, [L.inSub]);
      // Bulk request: read-only and hidden agents count as notFound.
      const b = await c.post('/api/agent/devices/bulk-request-update', { deviceIds: [L.inG, L.inOther] });
      assert.equal(b.status, 200, b.text);
      assert.equal(b.json.data.requested, 0);
      assert.equal(b.json.data.skipped.notFound, 2);
    } finally {
      __resetAgentUpdateStateForTest();
    }

    // Default tenant: without grants the god view reads foreign agents; a grant
    // limits the user to the granted agents of the Default tenant.
    const dDef = await createDevice(h.db, { tenantId: 1, keyId: 1, groupId: null });
    const du = await createUser(h.db, { tenants: [1], tenantRole: OPERATOR });
    const dc = await h.login(du.username);
    assert.equal((await dc.get(`/api/agent/devices/${D.B.id}`)).status, 200);
    await team(1, [du.id], [['ungrouped', UNGROUPED_SCOPE_ID, 'ro']]);
    assert.equal((await dc.get(`/api/agent/devices/${D.B.id}`)).status, 404);
    assert.equal((await dc.get(`/api/agent/devices/${dDef.id}`)).status, 200);
    const ids = await listedIds(dc);
    assert.ok(ids.includes(dDef.id) && !ids.includes(D.B.id));
  });
});
