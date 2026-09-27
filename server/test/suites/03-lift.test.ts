/**
 * 03 — Lift semantics (global lift from Default, local exclusion elsewhere).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { insertBan, banRow, exclusions, insertEvents, nextIp } from '../seed';
import { banEngine } from '../../src/services/ban.service';

describe('03 lift', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const globalBan = (ip = nextIp(), extra: Partial<Parameters<typeof insertBan>[1]> = {}) =>
    insertBan(h.db, { ip, scope: 'global', originTenantId: 1, ...extra });

  it('03.1 a Default member lifts a global ban globally [BASELINE]', async () => {
    const id = await globalBan();
    const r = await (await h.as('default_member')).del(`/api/bans/${id}`);
    assert.equal(r.status, 200);
    assert.equal((await banRow(h.db, id))!.is_active, false);
    assert.equal((await exclusions(h.db, id)).length, 0);
  });

  it('03.2 the platform admin in Default lifts globally [BASELINE]', async () => {
    const id = await globalBan();
    const r = await (await h.adminIn(1)).del(`/api/bans/${id}`);
    assert.equal(r.status, 200);
    assert.equal((await banRow(h.db, id))!.is_active, false);
  });

  it('03.3 a tenant member lift is a local exclusion, idempotent [BASELINE]', async () => {
    const id = await globalBan();
    const mb = await h.as('member_b');
    assert.equal((await mb.del(`/api/bans/${id}`)).status, 200);
    assert.equal((await banRow(h.db, id))!.is_active, true);
    let ex = await exclusions(h.db, id);
    assert.deepEqual(ex.map((e) => e.tenant_id), [2]);
    assert.equal((await mb.del(`/api/bans/${id}`)).status, 200);
    ex = await exclusions(h.db, id);
    assert.equal(ex.length, 1);
  });

  it('03.4 the platform admin in tenant B also lifts locally [BASELINE]', async () => {
    const id = await globalBan();
    assert.equal((await (await h.adminIn(2)).del(`/api/bans/${id}`)).status, 200);
    assert.equal((await banRow(h.db, id))!.is_active, true);
    assert.deepEqual((await exclusions(h.db, id)).map((e) => e.tenant_id), [2]);
  });

  it('03.5 a tenant lifts its own tenant ban [BASELINE]', async () => {
    const id = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2 });
    assert.equal((await (await h.as('member_b')).del(`/api/bans/${id}`)).status, 200);
    assert.equal((await banRow(h.db, id))!.is_active, false);
  });

  it('03.6 a tenant cannot lift another tenant ban [BASELINE]', async () => {
    const id = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 3, originTenantId: 3 });
    const r = await (await h.as('member_b')).del(`/api/bans/${id}`);
    assert.ok([403, 404].includes(r.status), `got ${r.status}`);
    assert.equal((await banRow(h.db, id))!.is_active, true);
  });

  it('03.7 a Default member lifts another tenant local ban [BASELINE]', async () => {
    const id = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 3, originTenantId: 3 });
    assert.equal((await (await h.as('default_member')).del(`/api/bans/${id}`)).status, 200);
    assert.equal((await banRow(h.db, id))!.is_active, false);
  });

  it('03.8 lifting an inactive global ban answers 409 [BASELINE]', async () => {
    const id = await globalBan(nextIp(), { isActive: false });
    assert.equal((await (await h.as('member_b')).del(`/api/bans/${id}`)).status, 409);
    assert.equal((await exclusions(h.db, id)).length, 0);
  });

  it('03.9 explicit exclusion and its removal [BASELINE]', async () => {
    const id = await globalBan();
    const mb = await h.as('member_b');
    assert.equal((await mb.post(`/api/bans/${id}/exclude`)).status, 200);
    assert.deepEqual((await exclusions(h.db, id)).map((e) => e.tenant_id), [2]);
    assert.equal((await mb.del(`/api/bans/${id}/exclude`)).status, 200);
    assert.equal((await exclusions(h.db, id)).length, 0);
    assert.equal((await mb.del(`/api/bans/${id}/exclude`)).status, 404);
  });

  it('03.10 push delta honours a local exclusion only for that tenant [BASELINE]', async () => {
    const x = nextIp();
    const id = await globalBan(x);
    const b1 = await h.push(2, 'dev-b-0001');
    assert.ok(b1.json.banList.add.includes(x));
    const c1 = await h.push(3, 'dev-c-0001');
    assert.ok(c1.json.banList.add.includes(x));
    assert.equal((await (await h.as('member_b')).del(`/api/bans/${id}`)).status, 200);
    const b2 = await h.push(2, 'dev-b-0001', { firewallBanned: [x] });
    assert.ok(b2.json.banList.remove.includes(x));
    assert.ok(!b2.json.banList.add.includes(x));
    const c2 = await h.push(3, 'dev-c-0001', { firewallBanned: [x] });
    assert.ok(!c2.json.banList.remove.includes(x));
  });

  it('03.11 a tenant ban is only delivered to that tenant [BASELINE]', async () => {
    const y = nextIp();
    await insertBan(h.db, { ip: y, scope: 'tenant', tenantId: 2, originTenantId: 2 });
    assert.ok((await h.push(2, 'dev-b-0001')).json.banList.add.includes(y));
    assert.ok(!(await h.push(3, 'dev-c-0001')).json.banList.add.includes(y));
  });

  lotIt('D4', '03.12 a lifted auto-ban is not re-minted by the next engine cycle', async () => {
    const z = nextIp();
    await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip: z, service: 'ssh', count: 6, ageSec: 60 });
    await banEngine.run();
    const rows = await h.db('ip_bans').whereRaw('host(ip) = ?', [z]).where({ is_active: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, 'global');
    assert.equal(rows[0].ban_type, 'auto');
    assert.equal((await (await h.as('default_member')).del(`/api/bans/${rows[0].id}`)).status, 200);
    await banEngine.run();
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [z]).where({ is_active: true })).length, 0);
  });
});
