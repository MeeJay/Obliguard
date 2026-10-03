/**
 * 02 — tenant membership, tenant switch, god-view reads, favourite tenant.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, waitFor } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { U } from '../fixtures';
import { createUser, createGroup, insertBan, insertWhitelist, nextIp } from '../seed';

describe('02 tenant membership', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const idsOf = (res: { json: any }) => ((res.json?.data ?? []) as Array<{ id: number }>).map((r) => r.id);

  it('02.1 tenant switch is membership-bound [BASELINE]', async () => {
    const mb = await h.login('member_b');
    const r = await mb.switchTenant(3);
    assert.equal(r.status, 403);
    const banId = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 3, originTenantId: 3 });
    const bc = await h.login('member_bc');
    assert.equal((await bc.switchTenant(3)).status, 200);
    const list = await bc.get('/api/bans?pageSize=1000');
    assert.equal(list.status, 200);
    assert.ok(idsOf(list).includes(banId));
  });

  it('02.2 capabilities come from membership [BASELINE]', async () => {
    const ipA = nextIp();
    const nt = await h.as('no_tenant');
    const r1 = await nt.post('/api/bans', { ip: ipA });
    assert.equal(r1.status, 403);
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [ipA])).length, 0);
    const ipB = nextIp();
    const mb = await h.as('member_b');
    const r2 = await mb.post('/api/bans', { ip: ipB });
    assert.equal(r2.status, 201);
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [ipB])).length, 1);
  });

  it('02.3 a platform admin without membership lands on Default [BASELINE]', async () => {
    const a = await h.login('admin');
    const me = await a.get('/api/auth/me');
    assert.equal(me.json?.data?.currentTenantId, 1);
  });

  lotIt('A1', '02.4 a user without tenant gets noTenantAccess (profile still reachable)', async () => {
    const nt = await h.login('no_tenant');
    const me = await nt.get('/api/auth/me');
    assert.equal(me.json?.data?.noTenantAccess, true);
    assert.equal(me.json?.data?.currentTenantId ?? null, null);
    const bans = await nt.get('/api/bans');
    assert.equal(bans.status, 403);
    assert.equal(bans.json?.code, 'noTenantAccess');
    assert.equal((await nt.get('/api/profile')).status, 200);
    assert.equal((await nt.get('/api/profile/2fa/status')).status, 200);
  });

  lotIt('A1', '02.5 a forged session tenant is revalidated', async () => {
    const mb = await h.login('member_b');
    await h.setSessionTenant(mb, 3);
    const bans = await mb.get('/api/bans');
    assert.equal(bans.status, 403);
    assert.equal(bans.json?.code, 'noTenantAccess');
    const me = await mb.get('/api/auth/me');
    assert.equal(me.json?.data?.currentTenantId, 2);
  });

  lotIt('A1', '02.6 removing a membership revokes access and tenant sockets', async () => {
    const x = await createUser(h.db, { tenants: [2, 3] });
    const c = await h.login(x.username);
    assert.equal((await c.switchTenant(3)).status, 200);
    const s = await h.socket(c);
    assert.ok(s.ok);
    const admin = await h.as('admin');
    assert.equal((await admin.del(`/api/tenants/3/members/${x.id}`)).status, 200);
    assert.equal((await c.get('/api/bans')).status, 403);
    if (s.ok) await waitFor(() => s.events.some((e) => e.event === 'disconnect'), 2000);
  });

  lotIt('A1', '02.7 switching to a missing tenant is refused', async () => {
    const a = await h.login('admin');
    const r = await a.switchTenant(999);
    assert.equal(r.status, 404);
    const me = await a.get('/api/auth/me');
    assert.equal(me.json?.data?.currentTenantId, 1);
  });

  lotIt('A1', '02.8 legacy team capabilities grant nothing outside membership', async () => {
    const mb = await h.login('member_b');
    await h.setSessionTenant(mb, 3);
    const a = nextIp();
    const r1 = await mb.post('/api/bans', { ip: a });
    assert.equal(r1.status, 403);
    assert.equal(r1.json?.code, 'noTenantAccess');
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [a])).length, 0);
    const b = nextIp();
    const r2 = await mb.post('/api/whitelist', { ip: `${b}/32` });
    assert.equal(r2.status, 403);
    assert.equal((await h.db('ip_whitelist').whereRaw('ip = ?::cidr', [`${b}/32`])).length, 0);
  });

  lotIt('A12', '02.9 group writes are bound to the operating tenant', async () => {
    const x3 = await createGroup(h.db, { tenantId: 3, name: 'x3-orig' });
    const [team] = await h.db('user_teams').insert({ name: `t3-${x3}`, tenant_id: 3 }).returning('id') as Array<{ id: number }>;
    await h.db('team_memberships').insert({ team_id: team.id, user_id: U.member_b });
    await h.db('team_permissions').insert({ team_id: team.id, scope: 'group', scope_id: x3, level: 'rw' });
    const mb = await h.login('member_b');
    const r1 = await mb.put(`/api/groups/${x3}`, { name: 'x' });
    assert.ok([403, 404].includes(r1.status), `got ${r1.status}`);
    assert.equal((await h.db('monitor_groups').where({ id: x3 }).first()).name, 'x3-orig');

    const x2 = await createGroup(h.db, { tenantId: 2, name: 'x2-orig' });
    const dm = await h.as('default_member');
    const r2 = await dm.put(`/api/groups/${x2}`, { name: 'x' });
    assert.ok([403, 404].includes(r2.status), `got ${r2.status}`);
    assert.equal((await h.db('monitor_groups').where({ id: x2 }).first()).name, 'x2-orig');
  });

  it('02.10 god-view reads for a Default member [BASELINE]', async () => {
    const dm = await h.as('default_member');
    const banId = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 3, originTenantId: 3 });
    const list = await dm.get('/api/bans?pageSize=1000');
    assert.ok(idsOf(list).includes(banId));
    assert.equal((await dm.get(`/api/bans/${banId}`)).status, 200);

    const wT = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'tenant', tenantId: 3 });
    const wA = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'agent', scopeId: 3, tenantId: 3 });
    const wl = await dm.get('/api/whitelist');
    assert.ok(idsOf(wl).includes(wT));
    assert.ok(idsOf(wl).includes(wA));

    const devs = await dm.get('/api/agent/devices');
    assert.ok(idsOf(devs).includes(2));
    assert.ok(idsOf(devs).includes(3));
    assert.equal((await dm.get('/api/agent/devices/3')).status, 200);
    assert.equal((await dm.get('/api/agent/devices/3/templates')).status, 200);
    const fw = await dm.get('/api/agent/devices/3/firewall/rules');
    assert.equal(fw.status, 503);
  });

  // ── Favourite tenant (owner answer 3, lot A1) ─────────────────────────────

  const prefOf = async (id: number) => (await h.db('users').where({ id }).first('preferred_tenant_id'))?.preferred_tenant_id ?? null;

  lotIt('A1', '02.11 the favourite tenant is honoured at login', async () => {
    const x = await createUser(h.db, { tenants: [2, 3] });
    const c = await h.login(x.username);
    const r = await c.post('/api/tenant/default', { tenantId: 3 });
    assert.equal(r.status, 200);
    assert.equal(r.json?.data?.preferredTenantId, 3);
    assert.equal(await prefOf(x.id), 3);
    const again = await h.login(x.username);
    const me = await again.get('/api/auth/me');
    assert.equal(me.json?.data?.currentTenantId, 3);
    // A1 may expose it at data.preferredTenantId or on the user payload.
    assert.equal(me.json?.data?.preferredTenantId ?? me.json?.data?.user?.preferredTenantId, 3);
  });

  lotIt('A1', '02.12 a favourite that lost its membership falls back to the first membership', async () => {
    const x = await createUser(h.db, { tenants: [2, 3] });
    const c = await h.login(x.username);
    assert.equal((await c.post('/api/tenant/default', { tenantId: 3 })).status, 200);
    const admin = await h.as('admin');
    assert.equal((await admin.del(`/api/tenants/3/members/${x.id}`)).status, 200);
    const again = await h.login(x.username);
    const me = await again.get('/api/auth/me');
    assert.equal(me.json?.data?.currentTenantId, 2);
  });

  lotIt('A1', '02.13 deleting the favourite tenant nulls the preference', async () => {
    const admin = await h.as('admin');
    const t = await admin.post('/api/tenants', { name: 'Fav', slug: `fav-${Date.now()}` });
    assert.equal(t.status, 201);
    const tid = t.json.data.id as number;
    const x = await createUser(h.db, { tenants: [2, tid] });
    const c = await h.login(x.username);
    assert.equal((await c.post('/api/tenant/default', { tenantId: tid })).status, 200);
    assert.equal((await admin.del(`/api/tenants/${tid}`, { confirmName: 'Fav' })).status, 200);
    assert.equal(await prefOf(x.id), null);
    const again = await h.login(x.username);
    assert.equal((await again.get('/api/auth/me')).json?.data?.currentTenantId, 2);
  });

  lotIt('A1', '02.14 a non-member cannot set a favourite tenant', async () => {
    const x = await createUser(h.db, { tenants: [2] });
    const c = await h.login(x.username);
    const r = await c.post('/api/tenant/default', { tenantId: 3 });
    assert.equal(r.status, 403);
    assert.equal(await prefOf(x.id), null);
  });
});
