/**
 * 50 — ban engine correctness (W3-1 / D4): whitelist containment at delivery
 * and in the engine, exact scope delivery, CIDR delivery gated by the agent's
 * 'cidr' capability, the non-public / infra protected set, the lift
 * watermark, the deactivation path and the external-ban lifecycle.
 *
 * Literals follow the fixture policy: 198.18.50-59.x (one third octet per
 * test) and 2001:db8:50-59::; the spec's 10.0.0.0/8 range example is played
 * with a 198.18.50.0/24 entry (10.99/16 is the harness XFF block). The
 * non-public checks use 192.168.1.50, 100.64.1.50 and fd00::50, which only
 * ever appear as refused targets.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, hostOf } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup, insertBan, insertEvents, insertWhitelist, nextIp } from '../seed';
import { banEngine, banService } from '../../src/services/ban.service';
import { refreshInfraAddresses } from '../../src/utils/protectedIps';

describe('50 ban engine correctness', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const rowsFor = (ip: string) => h.db('ip_bans').whereRaw('host(ip) = ?', [ip]);
  const activeFor = (ip: string) => rowsFor(ip).where({ is_active: true });
  const addOf = async (uuid: string, keyTenant: 2 | 3, body: Record<string, unknown> = {}) =>
    (await h.push(keyTenant, uuid, body)).json.banList as { add: string[]; remove: string[] };

  /** A fresh approved device of tenant 2 in its own group. */
  const tenantBDevice = async () => {
    const groupId = await createGroup(h.db, { tenantId: 2 });
    const dev = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId });
    return { ...dev, groupId };
  };

  lotIt('D4', '50.1 a range whitelist hides the bans it contains, only where it applies', async () => {
    await insertWhitelist(h.db, { ip: '198.18.50.0/24', scope: 'tenant', tenantId: 2 });
    await insertWhitelist(h.db, { ip: '2001:db8:50::/64', scope: 'global' });
    const inRange = '198.18.50.3';
    const v6In = '2001:db8:50::7';
    const v6Out = '2001:db8:51::7';
    for (const ip of [inRange, v6In, v6Out]) await insertBan(h.db, { ip, scope: 'global', originTenantId: 1 });
    const b = (await addOf('dev-b-0001', 2)).add.map(hostOf);
    assert.ok(!b.includes(inRange), 'tenant B whitelists 198.18.50.0/24');
    assert.ok(!b.includes(v6In));
    assert.ok(b.includes(v6Out));
    const c = (await addOf('dev-c-0001', 3)).add.map(hostOf);
    assert.ok(c.includes(inRange), 'tenant B\'s entry does not apply to tenant C');
    assert.ok(!c.includes(v6In));
  });

  lotIt('D4', '50.2 a /32 whitelist hides its own address only (no string prefix match)', async () => {
    await insertWhitelist(h.db, { ip: '198.18.51.4/32', scope: 'global' });
    for (const ip of ['198.18.51.4', '198.18.51.40', '198.18.51.41']) {
      await insertBan(h.db, { ip, scope: 'global', originTenantId: 1 });
    }
    const add = (await addOf('dev-b-0001', 2)).add.map(hostOf);
    assert.ok(!add.includes('198.18.51.4'));
    assert.ok(add.includes('198.18.51.40'));
    assert.ok(add.includes('198.18.51.41'));
  });

  lotIt('D4', '50.3 whitelisted addresses are not auto-banned; a tenant entry only hides delivery', async () => {
    const g = nextIp();
    await insertWhitelist(h.db, { ip: `${g}/32`, scope: 'global' });
    await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip: g, count: 6 });
    await banEngine.run();
    assert.equal((await rowsFor(g)).length, 0);

    const t = nextIp();
    await insertWhitelist(h.db, { ip: `${t}/32`, scope: 'tenant', tenantId: 2 });
    await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip: t, count: 6 });
    await banEngine.run();
    const rows = await activeFor(t);
    assert.equal(rows.length, 1, 'auto-bans are global: a tenant entry does not stop them');
    assert.ok(!(await addOf('dev-b-0001', 2)).add.map(hostOf).includes(t));
    assert.ok((await addOf('dev-c-0001', 3)).add.map(hostOf).includes(t));
  });

  lotIt('D4', '50.4 group and agent bans reach only their own group / agent', async () => {
    const d1 = await tenantBDevice();
    const d2 = await tenantBDevice();
    const g = nextIp();
    const a = nextIp();
    const tb = nextIp();
    await insertBan(h.db, { ip: g, scope: 'group', scopeId: d1.groupId, tenantId: 2, originTenantId: 2 });
    await insertBan(h.db, { ip: a, scope: 'agent', scopeId: d1.id, tenantId: 2, originTenantId: 2 });
    await insertBan(h.db, { ip: tb, scope: 'tenant', tenantId: 2, originTenantId: 2 });
    const one = (await addOf(d1.uuid, 2)).add;
    assert.ok(one.includes(g));
    assert.ok(one.includes(a));
    assert.ok(one.includes(tb));
    const two = (await addOf(d2.uuid, 2)).add;
    assert.ok(!two.includes(g), 'group ban of another group of the same tenant');
    assert.ok(!two.includes(a), 'agent ban of another agent of the same tenant');
    assert.ok(two.includes(tb));
    const fixture = (await addOf('dev-b-0001', 2)).add;
    assert.ok(!fixture.includes(g));
    assert.ok(!fixture.includes(a));
  });

  lotIt('D4', '50.5 a /24 ban is delivered as CIDR to a cidr-capable agent, as the network address otherwise', async () => {
    const r = await (await h.as('member_b')).post('/api/bans', { ip: '198.18.52.0', cidrPrefix: 24 });
    assert.equal(r.status, 201);
    const capable = await tenantBDevice();
    const legacy = await tenantBDevice();

    const c1 = await addOf(capable.uuid, 2, { capabilities: ['cidr'] });
    assert.ok(c1.add.includes('198.18.52.0/24'));
    assert.ok(!c1.add.includes('198.18.52.0'));
    // Converges once enforced (same textual form reported back).
    const c2 = await addOf(capable.uuid, 2, { capabilities: ['cidr'], firewallBanned: ['198.18.52.0/24'] });
    assert.ok(!c2.add.includes('198.18.52.0/24'));
    assert.ok(!c2.remove.includes('198.18.52.0/24'));

    const l1 = await addOf(legacy.uuid, 2);
    assert.ok(l1.add.includes('198.18.52.0'));
    assert.ok(!l1.add.some((e) => e.includes('/')));
    const l2 = await addOf(legacy.uuid, 2, { firewallBanned: ['198.18.52.0'] });
    assert.ok(!l2.add.includes('198.18.52.0'));
    assert.ok(!l2.remove.includes('198.18.52.0'));

    // A device that stops reporting the capability gets the network address back.
    const c3 = await addOf(capable.uuid, 2, { capabilities: [], firewallBanned: ['198.18.52.0/24'] });
    assert.ok(c3.add.includes('198.18.52.0'));
    assert.ok(c3.remove.includes('198.18.52.0/24'));
  });

  lotIt('D4', '50.6 non-public addresses are never banned globally (engine, manual, external)', async () => {
    for (const ip of ['192.168.1.50', '100.64.1.50', 'fd00::50']) {
      await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip, count: 8 });
    }
    await banEngine.run();
    for (const ip of ['192.168.1.50', '100.64.1.50', 'fd00::50']) {
      assert.equal((await rowsFor(ip)).length, 0, `auto-ban of ${ip}`);
    }
    const dm = await h.adminIn(1);
    for (const ip of ['192.168.1.50', '100.64.1.50', 'fd00::50', '172.16.0.0/24']) {
      assert.equal((await dm.post('/api/bans', { ip })).status, 400, `global ban of ${ip}`);
    }
    await assert.rejects(
      banService.createFromExternal({ ip: '192.168.1.50', reason: null, sourceApp: 'oblihub', expiresAt: null, masterTenantId: 1 }),
      (err: any) => err?.statusCode === 400,
    );
    assert.equal((await rowsFor('192.168.1.50')).length, 0);
    // A tenant-local ban of a LAN address stays the tenant's explicit choice,
    // and is never promoted to global.
    const local = await (await h.as('member_b')).post('/api/bans', { ip: '192.168.1.50' });
    assert.equal(local.status, 201);
    assert.equal((await dm.post(`/api/bans/${local.json.data.id}/promote-global`)).status, 400);
    assert.equal((await rowsFor('192.168.1.50')).filter((r) => r.scope === 'global').length, 0);
  });

  lotIt('D4', '50.7 approved agents\' public addresses are protected (own tenant for scoped bans)', async () => {
    const agentIp = nextIp();
    const pendingIp = nextIp();
    const dev = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    await h.db('agent_devices').where({ id: dev.id }).update({ ip: agentIp });
    const pending = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'pending' });
    await h.db('agent_devices').where({ id: pending.id }).update({ ip: pendingIp });
    await refreshInfraAddresses();

    await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip: agentIp, count: 6 });
    await banEngine.run();
    assert.equal((await rowsFor(agentIp)).length, 0, 'auto-ban of an approved agent address');
    assert.equal((await (await h.adminIn(1)).post('/api/bans', { ip: agentIp })).status, 400);
    assert.equal((await (await h.as('member_b')).post('/api/bans', { ip: agentIp })).status, 400);
    // Another tenant's local ban is its own business (no oracle on foreign infra).
    assert.equal((await (await h.as('member_c')).post('/api/bans', { ip: agentIp })).status, 201);
    // A pending device protects nothing.
    assert.equal((await (await h.adminIn(1)).post('/api/bans', { ip: pendingIp })).status, 201);
  });

  lotIt('D4', '50.8 lift watermark: old failures do not re-ban, new ones do', async () => {
    const z = nextIp();
    await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip: z, count: 6, ageSec: 60 });
    await banEngine.run();
    const [first] = await activeFor(z);
    assert.ok(first, 'auto-ban created');
    assert.equal((await (await h.as('default_member')).del(`/api/bans/${first.id}`)).status, 200);
    const lifted = await h.db('ip_bans').where({ id: first.id }).first();
    assert.equal(lifted.is_active, false);
    assert.ok(lifted.lifted_at, 'lifted_at is stamped');
    await banEngine.run();
    assert.equal((await activeFor(z)).length, 0);

    // Fresh failures after the Lift count again.
    await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip: z, count: 6, ageSec: -2 });
    await banEngine.run();
    const again = await activeFor(z);
    assert.equal(again.length, 1);
    assert.notEqual(again[0].id, first.id);
  });

  lotIt('D4', '50.9 expiry goes through the deactivation path; an expired active row does not block a new ban', async () => {
    const e = nextIp();
    const id = await insertBan(h.db, {
      ip: e, scope: 'tenant', tenantId: 2, originTenantId: 2, expiresAt: new Date(Date.now() - 60_000),
    });
    // The expiry job has not run yet: the stale row holds the unique key.
    const r = await (await h.as('member_b')).post('/api/bans', { ip: e });
    assert.equal(r.status, 201);
    const old = await h.db('ip_bans').where({ id }).first();
    assert.equal(old.is_active, false);
    assert.ok(old.lifted_at);

    const x = nextIp();
    const xid = await insertBan(h.db, { ip: x, scope: 'global', originTenantId: 1, expiresAt: new Date(Date.now() - 1000) });
    assert.ok((await banService.expireBans()) >= 1);
    const row = await h.db('ip_bans').where({ id: xid }).first();
    assert.equal(row.is_active, false);
    assert.ok(row.lifted_at);
  });

  lotIt('D4', '50.10 external bans never reactivate a lifted or scoped row', async () => {
    const ext = (ip: string) => banService.createFromExternal({
      ip, reason: 'verify', sourceApp: 'oblihub', expiresAt: new Date(Date.now() + 3600_000), masterTenantId: 1,
    });

    const lifted = nextIp();
    const liftedId = await insertBan(h.db, { ip: lifted, scope: 'global', originTenantId: 1, isActive: false });
    const a = await ext(lifted);
    assert.equal(a.isNew, true);
    assert.notEqual(a.ban.id, liftedId);
    assert.equal((await h.db('ip_bans').where({ id: liftedId }).first()).is_active, false);

    const scoped = nextIp();
    const scopedId = await insertBan(h.db, { ip: scoped, scope: 'tenant', tenantId: 2, originTenantId: 2 });
    const b = await ext(scoped);
    assert.equal(b.isNew, true);
    const scopedRow = await h.db('ip_bans').where({ id: scopedId }).first();
    assert.equal(scopedRow.scope, 'tenant');
    assert.equal(scopedRow.tenant_id, 2);
    assert.equal(scopedRow.origin_app, null);

    const auto = nextIp();
    const autoId = await insertBan(h.db, { ip: auto, scope: 'global', banType: 'auto', originTenantId: 2 });
    const c = await ext(auto);
    assert.equal(c.isNew, false);
    assert.equal(c.ban.id, autoId);
    const autoRow = await h.db('ip_bans').where({ id: autoId }).first();
    assert.equal(autoRow.ban_type, 'auto');
    assert.equal(autoRow.origin_app, null);
    assert.equal(autoRow.expires_at, null, 'an external refresh does not shorten a permanent ban');

    // Withdraw: only the app's own external row, through the deactivation path.
    assert.equal(await banService.withdrawExternal(auto, 'oblihub'), 0);
    assert.equal(await banService.withdrawExternal(lifted, 'oblihub'), 1);
    const w = await h.db('ip_bans').where({ id: a.ban.id }).first();
    assert.equal(w.is_active, false);
    assert.ok(w.lifted_at);
  });
});
