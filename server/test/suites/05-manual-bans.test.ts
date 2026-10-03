/**
 * 05 — manual and bulk bans follow the operating tenant; promote; wipe.
 * Destructive checks run last: 05.15 then 05.16.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, hostOf } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { insertBan, insertWhitelist, banRow, nextIp, litIp, createUser } from '../seed';

describe('05 manual bans', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const rowsFor = (ip: string) => h.db('ip_bans').whereRaw('host(ip) = ?', [ip]).orderBy('id');
  const idsOf = (res: { json: any }) => ((res.json?.data ?? []) as Array<{ id: number }>).map((r) => r.id);

  it('05.1 a tenant member bans locally [BASELINE]', async () => {
    const ip = nextIp();
    const r = await (await h.as('member_b')).post('/api/bans', { ip });
    assert.equal(r.status, 201);
    const [row] = await rowsFor(ip);
    assert.equal(row.scope, 'tenant');
    assert.equal(row.tenant_id, 2);
    assert.equal(row.origin_tenant_id, 2);
  });

  it('05.2 the platform admin in Default bans globally [BASELINE]', async () => {
    const ip = nextIp();
    assert.equal((await (await h.adminIn(1)).post('/api/bans', { ip })).status, 201);
    const [row] = await rowsFor(ip);
    assert.equal(row.scope, 'global');
    assert.equal(row.tenant_id, null);
  });

  lotIt('A2', '05.3 a Default member bans globally', async () => {
    const ip = nextIp();
    assert.equal((await (await h.as('default_member')).post('/api/bans', { ip })).status, 201);
    const [row] = await rowsFor(ip);
    assert.equal(row.scope, 'global');
    assert.equal(row.tenant_id, null);
  });

  lotIt('A2', '05.4 the platform admin operating tenant B bans locally', async () => {
    const ip = nextIp();
    assert.equal((await (await h.adminIn(2)).post('/api/bans', { ip })).status, 201);
    const [row] = await rowsFor(ip);
    assert.equal(row.scope, 'tenant');
    assert.equal(row.tenant_id, 2);
  });

  lotIt('A2', '05.5 an explicit global scope from tenant B is never honoured', async () => {
    const ip = nextIp();
    const r = await (await h.adminIn(2)).post('/api/bans', { ip, scope: 'global' });
    assert.ok([201, 403].includes(r.status), `got ${r.status}`);
    const rows = await rowsFor(ip);
    assert.ok(rows.every((x) => x.scope !== 'global'));
    if (r.status === 201) assert.equal(rows[0].scope, 'tenant');
  });

  it('05.5b a tenant member cannot request a global ban [BASELINE]', async () => {
    const ip = nextIp();
    const r = await (await h.as('member_b')).post('/api/bans', { ip, scope: 'global' });
    assert.ok([201, 403].includes(r.status), `got ${r.status}`);
    assert.ok((await rowsFor(ip)).every((x) => x.scope !== 'global'));
  });

  lotIt('A2', '05.6 bulk ban validates, dedupes and follows the operating tenant', async () => {
    const i1 = nextIp();
    const r = await (await h.as('member_b')).post('/api/bans/bulk-ban', { ips: ['not-an-ip', i1, '10.0.0.0/8', i1] });
    assert.equal(r.status, 200);
    assert.equal(r.json.created, 1);
    assert.equal(r.json.skipped, 1);
    assert.equal(r.json.invalid, 2);
    const rows = await rowsFor(i1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, 'tenant');
    assert.equal(rows[0].tenant_id, 2);
    assert.equal((await h.db('ip_bans').whereRaw("ip = '10.0.0.0/8'::inet")).length, 0);
  });

  lotIt('A2', '05.7 bulk ban scope and size limit', async () => {
    // Baseline-harmless ordering: the size-limit list leads with 'not-an-ip'.
    const big = ['not-an-ip'];
    for (let k = 0; k < 5000; k++) big.push(litIp('198.18', 100 + Math.floor(k / 250), 1 + (k % 250)));
    const r0 = await (await h.as('default_member')).post('/api/bans/bulk-ban', { ips: big });
    assert.equal(r0.status, 400);
    assert.equal((await h.db('ip_bans').whereRaw("ip <<= '198.18.96.0/19'::inet")).length, 0);

    const i = nextIp();
    await (await h.as('default_member')).post('/api/bans/bulk-ban', { ips: [i] });
    const [ri] = await rowsFor(i);
    assert.equal(ri?.scope, 'global');
    const j = nextIp();
    await (await h.adminIn(2)).post('/api/bans/bulk-ban', { ips: [j] });
    const [rj] = await rowsFor(j);
    assert.equal(rj?.scope, 'tenant');
    assert.equal(rj?.tenant_id, 2);
  });

  lotIt('A2', '05.8 promote-to-global is Default-only and needs an active ban', async () => {
    const own = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2 });
    assert.equal((await (await h.as('member_b')).post(`/api/bans/${own}/promote-global`)).status, 403);
    assert.equal((await banRow(h.db, own))!.scope, 'tenant');
    const other = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2 });
    assert.equal((await (await h.adminIn(2)).post(`/api/bans/${other}/promote-global`)).status, 403);
    assert.equal((await banRow(h.db, other))!.scope, 'tenant');
    const inactive = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2, isActive: false });
    assert.equal((await (await h.adminIn(1)).post(`/api/bans/${inactive}/promote-global`)).status, 409);
    assert.equal((await banRow(h.db, inactive))!.scope, 'tenant');
  });

  // Owner decision 12 (_defaults.txt): the protected 'user' set no longer holds
  // bans.promote, so the Default member here is a tenant admin (W7-2 re-gating).
  lotIt('A2', '05.8b a Default member holding bans.promote may promote a tenant ban to global', async () => {
    const id = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2 });
    const ta = await createUser(h.db, { tenants: [1], tenantRole: 'admin' });
    const r = await (await h.login(ta.username)).post(`/api/bans/${id}/promote-global`);
    assert.equal(r.status, 200, `Default tenant admin promote answered ${r.status}`);
    const row = (await banRow(h.db, id))!;
    assert.equal(row.scope, 'global');
    assert.equal(row.tenant_id, null);
    assert.equal(row.origin_tenant_id, 2);
  });

  it('05.9 the platform admin in Default promotes a tenant ban [BASELINE]', async () => {
    const id = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2 });
    assert.equal((await (await h.adminIn(1)).post(`/api/bans/${id}/promote-global`)).status, 200);
    const row = (await banRow(h.db, id))!;
    assert.equal(row.scope, 'global');
    assert.equal(row.tenant_id, null);
    assert.equal(row.origin_tenant_id, 2);
  });

  it('05.10a a tenant reads its own and global bans; another tenant ban is not listed [BASELINE]', async () => {
    const mb = await h.as('member_b');
    const own = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2 });
    const glob = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1 });
    const t3 = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 3, originTenantId: 3 });
    assert.equal((await mb.get(`/api/bans/${own}`)).status, 200);
    assert.equal((await mb.get(`/api/bans/${glob}`)).status, 200);
    assert.ok(!idsOf(await mb.get('/api/bans?pageSize=1000')).includes(t3));
  });

  lotIt('A2', '05.10b another tenant ban is not readable by id', async () => {
    const t3 = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 3, originTenantId: 3 });
    assert.equal((await (await h.as('member_b')).get(`/api/bans/${t3}`)).status, 404);
  });

  lotIt('A2', '05.11a another tenant local ban does not block a local ban', async () => {
    const x = nextIp();
    await insertBan(h.db, { ip: x, scope: 'tenant', tenantId: 3, originTenantId: 3 });
    assert.equal((await (await h.as('member_b')).post('/api/bans', { ip: x })).status, 201);
    assert.ok((await rowsFor(x)).some((r) => r.tenant_id === 2 && r.is_active));
  });

  it('05.11b an active global ban blocks a duplicate [BASELINE]', async () => {
    const y = nextIp();
    await insertBan(h.db, { ip: y, scope: 'global', originTenantId: 1 });
    assert.equal((await (await h.as('member_b')).post('/api/bans', { ip: y })).status, 409);
    assert.equal((await rowsFor(y)).length, 1);
  });

  lotIt('A2', '05.12 the whitelist blocks manual bans', async () => {
    await insertWhitelist(h.db, { ip: '198.18.12.192/27', scope: 'global' });
    const inside = litIp('198.18', 12, 200);
    assert.equal((await (await h.as('member_b')).post('/api/bans', { ip: inside })).status, 409);
    assert.equal((await rowsFor(inside)).length, 0);
    const z = nextIp();
    await insertWhitelist(h.db, { ip: `${z}/32`, scope: 'tenant', tenantId: 2 });
    assert.equal((await (await h.as('member_b')).post('/api/bans', { ip: z })).status, 409);
    assert.equal((await (await h.as('member_c')).post('/api/bans', { ip: z })).status, 201);
    const rows = await rowsFor(z);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant_id, 3);
  });

  it('05.13a god-view reputation lists another tenant ban [BASELINE]', async () => {
    const r = nextIp();
    await insertBan(h.db, { ip: r, scope: 'tenant', tenantId: 3, originTenantId: 3 });
    const res = await (await h.as('default_member')).get(`/api/ip-reputation?status=banned&search=${encodeURIComponent(r)}`);
    assert.equal(res.status, 200);
    assert.ok((res.json.data as Array<{ ip: string }>).some((x) => hostOf(x.ip) === r));
  });

  lotIt('A2', '05.13b a tenant reputation view hides another tenant ban', async () => {
    const r = nextIp();
    await insertBan(h.db, { ip: r, scope: 'tenant', tenantId: 3, originTenantId: 3 });
    const res = await (await h.as('member_b')).get(`/api/ip-reputation?status=banned&search=${encodeURIComponent(r)}`);
    assert.equal(res.status, 200);
    assert.ok(!(res.json.data as Array<{ ip: string }>).some((x) => hostOf(x.ip) === r));
  });

  lotIt('B2', '05.14 remote blocklists are not writable by a tenant member', async () => {
    // A VALID body, so a refusal can only come from authorisation (the
    // network guard blocks any sync attempt to the .invalid host).
    const count = async () => Number((await h.db('remote_blocklists').count<{ c: string }[]>({ c: '*' }))[0].c);
    const before = await count();
    const r = await (await h.as('member_b')).post('/api/remote-blocklists', {
      name: 'verify', sourceType: 'url', url: 'https://blocklist.verify.invalid/list.txt', enabled: false,
    });
    assert.equal(r.status, 403);
    assert.equal(await count(), before);
  });

  const activeCount = async () => Number((await h.db('ip_bans').where({ is_active: true }).count<{ c: string }[]>({ c: '*' }))[0].c);

  lotIt('A2', '05.15 wipe-bans is refused outside Default', async () => {
    await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1 });
    const before = await activeCount();
    const r = await (await h.adminIn(2)).post('/api/bans/wipe-bans');
    assert.equal(r.status, 403);
    assert.equal(await activeCount(), before);
  });

  it('05.16 wipe-bans from Default lifts everything [BASELINE, last]', async () => {
    await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1 });
    const r = await (await h.adminIn(1)).post('/api/bans/wipe-bans');
    assert.equal(r.status, 200);
    assert.equal(await activeCount(), 0);
  });
});
