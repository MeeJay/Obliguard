/**
 * 04 — whitelist: scope from the operating tenant, delete rights, visibility,
 * delivery to agents.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, hostOf } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { insertWhitelist, insertBan, createDevice, createGroup, nextIp, litIp } from '../seed';

describe('04 whitelist', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const wlRows = (cidr: string) => h.db('ip_whitelist').whereRaw('ip = ?::cidr', [cidr]).orderBy('id');
  const wlById = (id: number) => h.db('ip_whitelist').where({ id }).first();
  const idsOf = (res: { json: any }) => ((res.json?.data ?? []) as Array<{ id: number }>).map((r) => r.id);

  it('04.1 a Default member whitelists globally [BASELINE]', async () => {
    const r = await (await h.as('default_member')).post('/api/whitelist', { ip: '192.0.2.0/28' });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.scope, 'global');
    assert.equal(r.json.data.tenantId, null);
    const rows = await wlRows('192.0.2.0/28');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, 'global');
  });

  it('04.2 other tenants whitelist locally, whatever they request [BASELINE]', async () => {
    const mb = await h.as('member_b');
    const a = await mb.post('/api/whitelist', { ip: '192.0.2.16/28' });
    assert.equal(a.status, 201);
    assert.equal(a.json.data.scope, 'tenant');
    assert.equal(a.json.data.tenantId, 2);
    const cidrB = `${nextIp()}/32`;
    const b = await mb.post('/api/whitelist', { ip: cidrB, scope: 'global' });
    assert.equal(b.status, 201);
    assert.equal(b.json.data.scope, 'tenant');
    const cidrC = `${nextIp()}/32`;
    const c = await (await h.adminIn(2)).post('/api/whitelist', { ip: cidrC });
    assert.equal(c.status, 201);
    assert.equal(c.json.data.scope, 'tenant');
    assert.equal(c.json.data.tenantId, 2);
    for (const cidr of ['192.0.2.16/28', cidrB, cidrC]) {
      const rows = await wlRows(cidr);
      assert.equal(rows.length, 1, cidr);
      assert.equal(rows[0].scope, 'tenant');
      assert.equal(rows[0].tenant_id, 2);
    }
  });

  it('04.3 only Default removes a global entry [BASELINE]', async () => {
    const g1 = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'global' });
    assert.equal((await (await h.as('member_b')).del(`/api/whitelist/${g1}`)).status, 403);
    assert.ok(await wlById(g1));
    const g2 = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'global' });
    assert.equal((await (await h.as('default_member')).del(`/api/whitelist/${g2}`)).status, 200);
    assert.equal(await wlById(g2), undefined);
  });

  it('04.4 a tenant cannot remove another tenant entry [BASELINE]', async () => {
    const id = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'tenant', tenantId: 2 });
    const r = await (await h.as('member_c')).del(`/api/whitelist/${id}`);
    assert.ok([403, 404].includes(r.status), `got ${r.status}`);
    assert.ok(await wlById(id));
  });

  lotIt('A5', '04.5 god-view is read-only: a Default member cannot remove a tenant entry', async () => {
    const id = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'tenant', tenantId: 2 });
    const r = await (await h.as('default_member')).del(`/api/whitelist/${id}`);
    assert.ok([403, 404].includes(r.status), `got ${r.status}`);
    assert.ok(await wlById(id));
  });

  it('04.6 tenant visibility of whitelist entries [BASELINE]', async () => {
    const g = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'global' });
    const t2 = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'tenant', tenantId: 2 });
    const t3 = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'tenant', tenantId: 3 });
    const ids = idsOf(await (await h.as('member_b')).get('/api/whitelist'));
    assert.ok(ids.includes(g));
    assert.ok(ids.includes(t2));
    assert.ok(!ids.includes(t3));
  });

  lotIt('A4', '04.7 agent-scope entries of another tenant are not visible', async () => {
    const dev = await createDevice(h.db, { tenantId: 3, keyId: 3 });
    const id = await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'agent', scopeId: dev.id, tenantId: 3 });
    const ids = idsOf(await (await h.as('member_b')).get('/api/whitelist'));
    assert.ok(!ids.includes(id));
  });

  lotIt('A4', '04.8 agent/group scopes must belong to the operating tenant', async () => {
    const t3 = await createDevice(h.db, { tenantId: 3, keyId: 3 });
    const x3 = await createGroup(h.db, { tenantId: 3 });
    const t2 = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const mb = await h.as('member_b');
    const a = `${nextIp()}/32`;
    const r1 = await mb.post('/api/whitelist', { ip: a, scope: 'agent', scopeId: t3.id });
    assert.ok([403, 404].includes(r1.status), `got ${r1.status}`);
    assert.equal((await wlRows(a)).length, 0);
    const b = `${nextIp()}/32`;
    const r2 = await mb.post('/api/whitelist', { ip: b, scope: 'group', scopeId: x3 });
    assert.ok([403, 404].includes(r2.status), `got ${r2.status}`);
    assert.equal((await wlRows(b)).length, 0);
    const c = `${nextIp()}/32`;
    const r3 = await mb.post('/api/whitelist', { ip: c, scope: 'agent', scopeId: t2.id });
    assert.equal(r3.status, 201);
    const rows = await wlRows(c);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant_id, 2);
  });

  lotIt('A4', '04.9 two tenants may whitelist the same address', async () => {
    const w = `${nextIp()}/32`;
    assert.equal((await (await h.as('member_c')).post('/api/whitelist', { ip: w })).status, 201);
    assert.equal((await (await h.as('member_b')).post('/api/whitelist', { ip: w })).status, 201);
    const tenants = (await wlRows(w)).map((r) => r.tenant_id).sort();
    assert.deepEqual(tenants, [2, 3]);
  });

  it('04.10 bulk whitelist follows the operating tenant [BASELINE]', async () => {
    const a = nextIp(); const b = nextIp(); const c = nextIp();
    const r = await (await h.as('member_b')).post('/api/bans/bulk-whitelist', { ips: [a, b] });
    assert.equal(r.status, 200);
    assert.equal(r.json.created, 2);
    for (const ip of [a, b]) {
      const rows = await wlRows(`${ip}/32`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].scope, 'tenant');
      assert.equal(rows[0].tenant_id, 2);
    }
    const r2 = await (await h.as('default_member')).post('/api/bans/bulk-whitelist', { ips: [c] });
    assert.equal(r2.status, 200);
    const rows = await wlRows(`${c}/32`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, 'global');
  });

  lotIt('A4', '04.11 another tenant local entry does not block a bulk whitelist', async () => {
    const v = nextIp();
    await insertWhitelist(h.db, { ip: `${v}/32`, scope: 'tenant', tenantId: 3 });
    const r = await (await h.as('member_b')).post('/api/bans/bulk-whitelist', { ips: [v] });
    assert.equal(r.json?.created, 1);
    assert.ok((await wlRows(`${v}/32`)).some((row) => row.tenant_id === 2));
  });

  it('04.12 whitelist delivery follows the tenant [BASELINE]', async () => {
    const g = nextIp(); const t = nextIp(); const r = nextIp();
    await insertWhitelist(h.db, { ip: `${g}/32`, scope: 'global' });
    await insertWhitelist(h.db, { ip: `${t}/32`, scope: 'tenant', tenantId: 2 });
    await insertWhitelist(h.db, { ip: `${r}/32`, scope: 'tenant', tenantId: 3 });
    const wl = (await h.push(2, 'dev-b-0001')).json.whitelist as string[];
    assert.ok(wl.includes(`${g}/32`));
    assert.ok(wl.includes(`${t}/32`));
    assert.ok(!wl.includes(`${r}/32`));
  });

  lotIt('A4', '04.13 a poisoned agent-scope row of another tenant is not delivered', async () => {
    const p = nextIp();
    await insertWhitelist(h.db, { ip: `${p}/32`, scope: 'agent', scopeId: 2, tenantId: 3 });
    const wl = (await h.push(2, 'dev-b-0001')).json.whitelist as string[];
    assert.ok(!wl.includes(`${p}/32`));
  });

  lotIt('D4', '04.14 ban delivery applies real CIDR containment of the whitelist', async () => {
    await insertWhitelist(h.db, { ip: '198.18.14.0/24', scope: 'tenant', tenantId: 2 });
    await insertWhitelist(h.db, { ip: '198.18.15.4/32', scope: 'global' });
    const in14 = litIp('198.18', 14, 77);
    const near = litIp('198.18', 15, 45);
    const exact = litIp('198.18', 15, 4);
    for (const ip of [in14, near, exact]) await insertBan(h.db, { ip, scope: 'global', originTenantId: 1 });
    const b = (await h.push(2, 'dev-b-0001')).json.banList.add as string[];
    assert.ok(b.map(hostOf).includes(near));
    assert.ok(!b.map(hostOf).includes(in14));
    assert.ok(!b.map(hostOf).includes(exact));
    const c = (await h.push(3, 'dev-c-0001')).json.banList.add as string[];
    assert.ok(c.map(hostOf).includes(in14));
    assert.ok(!c.map(hostOf).includes(exact));
  });

  lotIt('A4', '04.15 Default-tenant writes on another tenant scopes stay refused', async () => {
    const t2 = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const x2 = await createGroup(h.db, { tenantId: 2 });
    const dm = await h.as('default_member');
    const a = `${nextIp()}/32`;
    const r1 = await dm.post('/api/whitelist', { ip: a, scope: 'agent', scopeId: t2.id });
    assert.ok([403, 404].includes(r1.status), `got ${r1.status}`);
    assert.equal((await wlRows(a)).length, 0);
    const b = `${nextIp()}/32`;
    const r2 = await dm.post('/api/whitelist', { ip: b, scope: 'group', scopeId: x2 });
    assert.ok([403, 404].includes(r2.status), `got ${r2.status}`);
    assert.equal((await wlRows(b)).length, 0);
  });
});
