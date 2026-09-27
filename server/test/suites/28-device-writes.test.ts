/**
 * 28 — A5 device writes follow the operating tenant: the Default god view is
 * read-only for every role (platform admin included) on device, bulk,
 * firewall and MikroTik writes; other tenants get 404; groups must belong to
 * the device's tenant; device-links honour the read rule.
 */
import { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startHarness, drain, FakeWs } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup, createMikrotikDevice } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';

const READ_ONLY = /read-only from the Default tenant/;

/** A FakeWs that answers firewall commands like an agent. */
class FirewallAgent extends FakeWs {
  send(d: unknown): void {
    super.send(d);
    const m = JSON.parse(String(d));
    if (typeof m?.type === 'string' && m.type.startsWith('firewall_')) {
      setImmediate(() => this.receive({ type: 'firewall_response', id: m.id, success: true, rules: [] }));
    }
  }
}

describe('28 device writes (A5)', () => {
  let h: Harness;
  const fakes: FakeWs[] = [];
  before(async () => { h = await startHarness({ obligate: true }); });
  after(async () => { await h.close(); });
  afterEach(() => { for (const f of fakes.splice(0)) { try { f.close(); } catch { /* ignore */ } } });

  const dev = (id: number) => h.db('agent_devices').where({ id }).first();

  lotIt('A5', '28.1 god view is read-only for single-device writes', async () => {
    for (const actor of ['default_member', 'admin'] as const) {
      const c = actor === 'admin' ? await h.adminIn(1) : await h.as('default_member');
      const t = await createDevice(h.db, { tenantId: 2, keyId: 2 });
      const r1 = await c.patch(`/api/agent/devices/${t.id}`, { name: 'godview' });
      assert.equal(r1.status, 403, `${actor} PATCH`);
      assert.match(r1.json?.error ?? '', READ_ONLY);
      assert.equal((await c.del(`/api/agent/devices/${t.id}`)).status, 403);
      assert.equal((await c.post(`/api/agent/devices/${t.id}/command`, { command: 'uninstall' })).status, 403);
      const row = await dev(t.id);
      assert.ok(row);
      assert.equal(row.name, null);
      assert.equal(row.pending_command, null);
      assert.equal((await c.get(`/api/agent/devices/${t.id}`)).status, 200);
    }
    const t = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    assert.equal((await (await h.adminIn(2)).patch(`/api/agent/devices/${t.id}`, { name: 'own' })).status, 200);
    assert.equal((await dev(t.id)).name, 'own');
    const mc = await h.as('member_c');
    assert.equal((await mc.get(`/api/agent/devices/${t.id}`)).status, 404);
    assert.equal((await mc.patch(`/api/agent/devices/${t.id}`, { name: 'c' })).status, 404);
    assert.equal((await dev(t.id)).name, 'own');
  });

  lotIt('A5', '28.2 god-view bulk writes only touch the operating tenant', async () => {
    const admin = await h.adminIn(1);
    const own = await createDevice(h.db, { tenantId: 1, keyId: 1 });
    const foreign = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const ids = [own.id, foreign.id];
    const u = await admin.patch('/api/agent/devices/bulk', { deviceIds: ids, heartbeatMonitoring: false });
    assert.equal(u.status, 200);
    assert.equal(u.json?.data?.affected, 1);
    assert.equal(u.json?.data?.skipped, 1);
    assert.equal((await dev(foreign.id)).heartbeat_monitoring, true);
    const c = await admin.post('/api/agent/devices/bulk-command', { deviceIds: ids, command: 'uninstall' });
    assert.equal(c.json?.data?.affected, 1);
    assert.equal((await dev(foreign.id)).pending_command, null);
    const d = await admin.del('/api/agent/devices/bulk', { deviceIds: ids });
    assert.equal(d.json?.data?.affected, 1);
    assert.ok(await dev(foreign.id));
    assert.equal(await dev(own.id), undefined);
    assert.equal((await admin.del('/api/agent/devices/bulk', { deviceIds: [] })).status, 400);
    assert.equal((await admin.del('/api/agent/devices/bulk', { deviceIds: ['x'] })).status, 400);
  });

  lotIt('A5', '28.3 firewall: god-view list only, approved devices only', async () => {
    const t = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const agent = new FirewallAgent();
    fakes.push(agent);
    await obliguardHub.register(t.uuid, 2, 2, '127.0.0.1', agent as any);
    const admin = await h.adminIn(1);
    const list = await admin.get(`/api/agent/devices/${t.id}/firewall/rules`);
    assert.equal(list.status, 200);
    const sentBefore = agent.sent.length;
    assert.equal((await admin.post(`/api/agent/devices/${t.id}/firewall/rules`, { name: 'x' })).status, 403);
    assert.equal((await admin.del(`/api/agent/devices/${t.id}/firewall/rules/r1`)).status, 403);
    assert.equal((await admin.patch(`/api/agent/devices/${t.id}/firewall/rules/r1`, { enabled: false })).status, 403);
    assert.equal(agent.sent.length, sentBefore);
    assert.equal((await (await h.adminIn(3)).get(`/api/agent/devices/${t.id}/firewall/rules`)).status, 404);
    const p = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'pending' });
    assert.equal((await (await h.adminIn(2)).get(`/api/agent/devices/${p.id}/firewall/rules`)).status, 409);
  });

  lotIt('A5', '28.4 MikroTik routes: never god-viewed, own tenant only', async () => {
    const mb = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: `mt-${crypto.randomBytes(3).toString('hex')}` });
    const admin1 = await h.adminIn(1);
    const creds = await admin1.get(`/api/mikrotik/${mb.id}/credentials`);
    assert.equal(creds.status, 403);
    assert.ok(!creds.text.includes('ingestToken'));
    assert.equal((await admin1.put(`/api/mikrotik/${mb.id}/credentials`, { apiHost: 'evil' })).status, 403);
    assert.equal((await admin1.post(`/api/mikrotik/${mb.id}/test`)).status, 403);
    assert.equal((await admin1.post(`/api/mikrotik/${mb.id}/sync-bans`)).status, 403);
    assert.equal((await admin1.post(`/api/mikrotik/${mb.id}/clear-log-cache`)).status, 403);
    assert.equal((await admin1.get(`/api/mikrotik/${mb.id}/debug-logs`)).status, 403);
    const row = await h.db('mikrotik_credentials').where({ device_id: mb.id }).first();
    assert.notEqual(row.api_host, 'evil');
    assert.equal((await (await h.adminIn(2)).get(`/api/mikrotik/${mb.id}/credentials`)).status, 200);
    assert.equal((await (await h.adminIn(3)).get(`/api/mikrotik/${mb.id}/credentials`)).status, 404);
    const plain = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    assert.equal((await (await h.adminIn(2)).get(`/api/mikrotik/${plain.id}/credentials`)).status, 404);
  });

  lotIt('A5', '28.5 groups must belong to the device tenant', async () => {
    const mb = await h.as('member_b');
    const own = await createGroup(h.db, { tenantId: 2 });
    const x3 = await createGroup(h.db, { tenantId: 3 });
    const t = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: 2 });
    assert.equal((await mb.patch(`/api/agent/devices/${t.id}`, { groupId: x3 })).status, 400);
    assert.equal((await dev(t.id)).group_id, 2);
    assert.equal((await mb.patch(`/api/agent/devices/${t.id}`, { groupId: null })).status, 200);
    assert.equal((await dev(t.id)).group_id, null);
    assert.equal((await mb.patch(`/api/agent/devices/${t.id}`, { groupId: own })).status, 200);
    assert.equal((await dev(t.id)).group_id, own);
    const b = await mb.patch('/api/agent/devices/bulk', { deviceIds: [t.id], groupId: x3 });
    assert.equal(b.status, 400);
    assert.equal((await dev(t.id)).group_id, own);
    assert.equal((await mb.patch(`/api/agent/devices/${t.id}`, { status: 'bogus' })).status, 400);

    const host = `mt-${crypto.randomBytes(3).toString('hex')}`;
    const r = await (await h.adminIn(2)).post('/api/mikrotik', {
      name: host, hostname: host, groupId: x3, apiHost: host, apiUsername: 'u', apiPassword: 'p', syslogIdentifier: host,
    });
    assert.equal(r.status, 400);
    assert.equal(await h.db('agent_devices').where({ hostname: host }).first(), undefined);
  });

  lotIt('A5', '28.6 device-links honour the tenant read rule', async () => {
    const t = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const n0 = h.obligate!.requests.length;
    const links = () => h.obligate!.requests.slice(n0).filter((q) => q.path === '/api/devices/links');
    const r = await (await h.as('member_c')).get(`/api/auth/device-links?uuid=${encodeURIComponent(t.uuid)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json?.data, []);
    assert.equal(links().length, 0);
    await (await h.as('default_member')).get(`/api/auth/device-links?uuid=${encodeURIComponent(t.uuid)}`);
    assert.ok(await drain(() => links().length > 0, 2000));
    const nt = await h.as('no_tenant');
    const r2 = await nt.get(`/api/auth/device-links?uuid=${encodeURIComponent(t.uuid)}`);
    assert.notEqual(r2.status, 200);
  });

  lotIt('A5', '28.7 groups expose their owning tenant', async () => {
    const r = await (await h.adminIn(2)).get('/api/groups');
    assert.equal(r.status, 200);
    const list: Array<{ id: number; tenantId?: number }> = Array.isArray(r.json?.data) ? r.json.data : [];
    const g = list.find((x) => x.id === 2);
    assert.ok(g, 'group 2 listed');
    assert.equal(g!.tenantId, 2);
  });
});
