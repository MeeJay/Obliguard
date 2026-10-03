/**
 * 71 — W7 integration (W7-6): the followups wired across lots.
 *   - team scope (RBAC-8) also gates the dashboard summary, MikroTik device
 *     routes, local template assignments and agent notification bindings;
 *   - tenant admins bypass team scope on groups (list, update, delete);
 *   - agent update POLICY writes stay platform-admin only at the agent level
 *     too (owner directive C17), other device fields follow agents.manage;
 *   - the Default tenant prefers the global IP label over other tenants' rows.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup, createUser, createMikrotikDevice } from '../seed';
import { TENANT_CAPABILITY_KEYS } from '@obliview/shared';

/** Every tenant capability without being 'admin': only the team rule decides. */
const OPERATOR = 'w76-operator';

describe('71 W7 integration', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
    await h.db('permission_sets').insert({ name: 'W7-6 operator', slug: OPERATOR, capabilities: JSON.stringify([...TENANT_CAPABILITY_KEYS]) });
  });
  after(async () => { await h.close(); });

  let seq = 0;
  async function team(tenantId: number, members: number[], grants: Array<[string, number, 'ro' | 'rw']>): Promise<void> {
    const [t] = await h.db('user_teams')
      .insert({ name: `t71-${tenantId}-${Date.now()}-${++seq}`, tenant_id: tenantId, can_create: false })
      .returning('id') as Array<{ id: number }>;
    for (const uid of members) await h.db('team_memberships').insert({ team_id: t.id, user_id: uid });
    for (const [scope, scopeId, level] of grants) {
      await h.db('team_permissions').insert({ team_id: t.id, scope, scope_id: scopeId, level });
    }
  }

  /** A tenant-2 operator holding RO on `ro` and RW on `rw` (agent grants). */
  async function restricted(ro: number, rw: number) {
    const u = await createUser(h.db, { tenants: [2], tenantRole: OPERATOR });
    await team(2, [u.id], [['agent', ro, 'ro'], ['agent', rw, 'rw']]);
    return h.login(u.username);
  }

  lotIt('W7-6', '71.1 the dashboard summary counts only the agents a restricted user sees', async () => {
    const g = await createGroup(h.db, { tenantId: 2 });
    const a = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: g });
    const b = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: g });
    const c = await restricted(a.id, b.id);
    const r = await c.get('/api/dashboard/summary');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.agentsTotal, 2);
    const full = await (await h.adminIn(2)).get('/api/dashboard/summary');
    assert.ok(full.json.data.agentsTotal > 2, 'the tenant admin view is not restricted');
  });

  lotIt('W7-6', '71.2 MikroTik routes follow team grants (404 hidden, 403 read-only)', async () => {
    const ro = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: '198.51.100.71' });
    const rw = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: '198.51.100.72' });
    const hidden = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: '198.51.100.73' });
    const c = await restricted(ro.id, rw.id);
    assert.equal((await c.get(`/api/mikrotik/${hidden.id}/credentials`)).status, 404);
    const r = await c.get(`/api/mikrotik/${ro.id}/credentials`);
    assert.equal(r.status, 403);
    assert.match(r.json.error, /read-only/i);
    assert.equal((await c.get(`/api/mikrotik/${rw.id}/credentials`)).status, 200);
  });

  lotIt('W7-6', '71.3 local template assignments and agent bindings follow team grants', async () => {
    const ro = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const rw = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const hidden = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const tpl = await (await h.adminIn(2)).post('/api/service-templates', { name: `t71-${Date.now()}`, serviceType: 'ssh' });
    assert.equal(tpl.status, 201, tpl.text);
    const id = tpl.json.data.id as number;
    const c = await restricted(ro.id, rw.id);

    assert.equal((await c.put(`/api/service-templates/${id}/assign/agent/${hidden.id}`, {})).status, 404);
    assert.equal((await c.put(`/api/service-templates/${id}/assign/agent/${ro.id}`, {})).status, 403);
    assert.equal((await c.put(`/api/service-templates/${id}/assign/agent/${rw.id}`, {})).status, 200);
    assert.equal((await c.get(`/api/service-templates/local/agent/${hidden.id}`)).status, 404);
    assert.equal((await c.get(`/api/service-templates/local/agent/${ro.id}`)).status, 200);

    const ch = await (await h.adminIn(2)).post('/api/notifications/channels', {
      name: `w76-${Date.now()}`, type: 'webhook', config: { url: 'https://example.com/w76' },
    });
    assert.equal(ch.status, 201, ch.text);
    const channelId = ch.json.data.id as number;
    assert.equal((await c.post('/api/notifications/bindings', { channelId, scope: 'agent', scopeId: hidden.id })).status, 404);
    assert.equal((await c.post('/api/notifications/bindings', { channelId, scope: 'agent', scopeId: ro.id })).status, 403);
    assert.equal((await c.post('/api/notifications/bindings', { channelId, scope: 'agent', scopeId: rw.id })).status, 201);
  });

  lotIt('W7-6', '71.4 a tenant admin without teams lists, updates and deletes the groups of its tenant', async () => {
    const ta = await createUser(h.db, { tenants: [2], tenantRole: 'admin' });
    const c = await h.login(ta.username);
    const g = await createGroup(h.db, { tenantId: 2 });
    const foreign = await createGroup(h.db, { tenantId: 3 });
    const listed = ((await c.get('/api/groups')).json.data as Array<{ id: number }>).map((x) => x.id);
    assert.ok(listed.includes(g), 'tenant group listed');
    assert.ok(!listed.includes(foreign), 'other tenant group not listed');
    assert.equal((await c.put(`/api/groups/${g}`, { name: 'w76-renamed' })).status, 200);
    assert.equal((await c.put(`/api/groups/${foreign}`, { name: 'w76-hijack' })).status, 404);
    assert.equal((await c.del(`/api/groups/${g}`)).status, 200);

    // A plain 'user' member without RW grants still cannot.
    const g2 = await createGroup(h.db, { tenantId: 2 });
    assert.equal((await (await h.as('member_b')).put(`/api/groups/${g2}`, { name: 'w76-member' })).status, 403);
  });

  lotIt('W7-6', '71.5 agent update policy writes are platform-admin only (owner directive C17)', async () => {
    const d = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const ta = await createUser(h.db, { tenants: [2], tenantRole: 'admin' });
    const c = await h.login(ta.username);
    const p = await c.patch(`/api/agent/devices/${d.id}`, { updatePolicy: 'auto' });
    assert.equal(p.status, 403);
    assert.equal((await c.patch('/api/agent/devices/bulk', { deviceIds: [d.id], updatePolicy: 'off' })).status, 403);
    assert.equal((await h.db('agent_devices').where({ id: d.id }).first('update_policy')).update_policy, null);
    assert.equal((await c.patch(`/api/agent/devices/${d.id}`, { name: 'w76-name' })).status, 200);
    assert.equal((await (await h.adminIn(2)).patch(`/api/agent/devices/${d.id}`, { updatePolicy: 'auto' })).status, 200);
  });

  lotIt('W7-6', '71.6 the Default tenant prefers the global IP label', async () => {
    const ip = '203.0.113.76';
    await h.db('ip_display_names').insert([
      { ip, label: 'tenant-3', tenant_id: 3 },
      { ip, label: 'global', tenant_id: null },
      { ip, label: 'tenant-2', tenant_id: 2 },
    ]);
    const labelFor = async (r: { json: any }) => (r.json.data as Array<{ ip: string; label: string }>).find((x) => x.ip === ip)?.label;
    assert.equal(await labelFor(await (await h.adminIn(1)).get('/api/ip-labels')), 'global');
    assert.equal(await labelFor(await (await h.adminIn(2)).get('/api/ip-labels')), 'tenant-2');
  });
});
