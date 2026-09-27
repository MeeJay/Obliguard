/**
 * 08 — agent ↔ API-key binding, device writes, god-view read-only writes.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import WebSocket from 'ws';
import { startHarness, waitFor, drain, FakeWs } from '../harness';
import type { Harness } from '../harness';
import { lotIt, adapterIt } from '../lots';
import { adapters } from '../adapters';
import { KEYS } from '../fixtures';
import { createDevice, createGroup, createKey, nextIp } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';

describe('08 device binding', () => {
  let h: Harness;
  before(async () => { h = await startHarness({ obligate: true }); });
  after(async () => { await h.close(); });

  const dev = (id: number) => h.db('agent_devices').where({ id }).first();

  it('08.1 push answers ok for an approved device, pending for a new one [BASELINE]', async () => {
    const c = await h.push(3, 'dev-c-0001');
    assert.equal(c.status, 200);
    assert.equal(c.json.status, 'ok');
    const uuid = `dev-new-${crypto.randomBytes(4).toString('hex')}`;
    const n = await h.push(2, uuid);
    assert.equal(n.status, 202);
    assert.equal(n.json.status, 'pending');
    const row = await h.db('agent_devices').where({ uuid }).first();
    assert.equal(row.tenant_id, 2);
    assert.equal(row.api_key_id, 2);
    assert.equal(row.status, 'pending');
  });

  it('08.2 a tenant cannot touch another tenant device; Default reads it [BASELINE]', async () => {
    const t = await createDevice(h.db, { tenantId: 3, keyId: 3, hostname: 'orig-name' });
    const r = await (await h.as('member_b')).patch(`/api/agent/devices/${t.id}`, { name: 'x' });
    assert.equal(r.status, 404);
    assert.equal((await dev(t.id)).name, null);
    assert.equal((await (await h.as('default_member')).get('/api/agent/devices/2')).status, 200);
  });

  lotIt('A5', '08.3 a push with another tenant key cannot hijack a device', async () => {
    const t = await createDevice(h.db, { tenantId: 3, keyId: 3, version: '0.9.0', hostname: 'host-t' });
    const n0 = h.obligate!.requests.length;
    const r = await h.push(2, t.uuid, { hostname: 'hijack', agentVersion: '6.6.6', events: [h.event(nextIp(), { service: 'custom:verify' })] });
    assert.equal(r.status, 401);
    assert.equal(r.json?.status, 'refused');
    const row = await dev(t.id);
    assert.equal(row.hostname, 'host-t');
    assert.equal(row.api_key_id, 3);
    assert.equal(row.tenant_id, 3);
    assert.equal(row.agent_version, '0.9.0');
    assert.equal((await h.db('ip_events').where({ device_id: t.id })).length, 0);
    // Sentinel: a legitimate push of another device must reach Obligate.
    const u = await createDevice(h.db, { tenantId: 3, keyId: 3 });
    await h.push(3, u.uuid);
    await drain(() => h.obligate!.requests.slice(n0).some((q) => q.path === '/api/devices/register' && q.body?.uuid === u.uuid), 2000);
    assert.ok(!h.obligate!.requests.slice(n0).some((q) => q.path === '/api/devices/register' && q.body?.uuid === t.uuid));
  });

  lotIt('A5', '08.4 the hub refuses a WS registration from another tenant key', async () => {
    const t = await createDevice(h.db, { tenantId: 3, keyId: 3 });
    const wsA = new FakeWs();
    const wsB = new FakeWs();
    try {
      await obliguardHub.register(t.uuid, 3, 3, '127.0.0.1', wsA as any);
      await obliguardHub.register(t.uuid, 2, 2, '127.0.0.1', wsB as any);
      assert.equal(wsB.closed?.code, 4003);
      assert.equal(wsA.closed, null);
      assert.equal(obliguardHub.isConnected(t.uuid), true);
    } finally {
      wsA.close(); wsB.close();
    }
  });

  adapterIt('A5', adapters.agentWs, '08.5 the agent WS gate refuses a foreign key before the upgrade', async () => {
    const t = await createDevice(h.db, { tenantId: 3, keyId: 3 });
    const url = `ws://127.0.0.1:${h.port}/api/agent/ws?uuid=${encodeURIComponent(t.uuid)}`;
    const clients: WebSocket[] = [];
    try {
      const foreign = new WebSocket(url, { headers: { 'x-api-key': KEYS[2] } });
      clients.push(foreign);
      const refused = await new Promise<{ kind: string; code?: number }>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: 'timeout' }), 3000);
        foreign.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve({ kind: 'unexpected-response', code: res.statusCode }); });
        foreign.on('close', (code) => { clearTimeout(timer); resolve({ kind: 'close', code }); });
        foreign.on('error', () => { /* reported through unexpected-response / close */ });
      });
      assert.equal(refused.kind, 'unexpected-response');
      assert.equal(refused.code, 403);
      const own = new WebSocket(url, { headers: { 'x-api-key': KEYS[3] } });
      clients.push(own);
      const opened = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        own.on('open', () => { clearTimeout(timer); resolve(true); });
        own.on('error', () => { clearTimeout(timer); resolve(false); });
      });
      assert.equal(opened, true);
    } finally {
      for (const c of clients) { try { c.terminate(); } catch { /* ignore */ } }
    }
  });

  lotIt('A5', '08.6 revoking a key closes its agents channels', async () => {
    const k = await createKey(h.db, 2);
    const uuid = `dev-b-rev-${crypto.randomBytes(3).toString('hex')}`;
    await createDevice(h.db, { uuid, tenantId: 2, keyId: k.id, groupId: 2 });
    const ws = new FakeWs();
    try {
      await obliguardHub.register(uuid, 2, k.id, '127.0.0.1', ws as any);
      const r = await (await h.adminIn(2)).del(`/api/agent/keys/${k.id}`);
      assert.equal(r.status, 200);
      assert.equal(await h.db('agent_api_keys').where({ id: k.id }).first(), undefined);
      await waitFor(() => ws.closed?.code === 4003, 1000);
    } finally {
      ws.close();
    }
  });

  it('08.7 tenant members manage their own devices [BASELINE]', async () => {
    const mb = await h.as('member_b');
    const t = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const x2 = await createGroup(h.db, { tenantId: 2 });
    assert.equal((await mb.patch(`/api/agent/devices/${t.id}`, { groupId: x2 })).status, 200);
    assert.equal((await dev(t.id)).group_id, x2);
    const p = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'pending' });
    assert.equal((await mb.patch(`/api/agent/devices/${p.id}`, { status: 'approved', groupId: 2 })).status, 200);
    const row = await dev(p.id);
    assert.equal(row.status, 'approved');
    assert.equal(row.group_id, 2);
  });

  lotIt('A5', '08.8 a device cannot be moved into another tenant group', async () => {
    const x3 = await createGroup(h.db, { tenantId: 3 });
    const t1 = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: 2 });
    const t2 = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: 2 });
    const t3 = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: 2 });
    const p = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'pending' });
    const mb = await h.as('member_b');
    const r1 = await mb.patch(`/api/agent/devices/${t1.id}`, { groupId: x3 });
    assert.ok([400, 403].includes(r1.status), `got ${r1.status}`);
    assert.equal((await dev(t1.id)).group_id, 2);
    const r2 = await mb.patch('/api/agent/devices/bulk', { deviceIds: [t2.id], groupId: x3 });
    assert.ok([400, 403].includes(r2.status), `got ${r2.status}`);
    assert.equal((await dev(t2.id)).group_id, 2);
    const r3 = await mb.patch(`/api/agent/devices/${p.id}`, { status: 'approved', groupId: x3 });
    assert.ok([400, 403].includes(r3.status), `got ${r3.status}`);
    assert.equal((await dev(p.id)).status, 'pending');
    const r4 = await (await h.adminIn(1)).patch(`/api/agent/devices/${t3.id}`, { groupId: 1 });
    assert.ok([400, 403].includes(r4.status), `got ${r4.status}`);
    assert.equal((await dev(t3.id)).group_id, 2);
  });

  lotIt('A5', '08.9 god-view is read-only for device writes (member and platform admin)', async () => {
    for (const actor of ['default_member', 'admin@default'] as const) {
      const c = actor === 'admin@default' ? await h.adminIn(1) : await h.as('default_member');
      const ok = actor === 'admin@default' ? [403] : [403, 404];
      const t = await createDevice(h.db, { tenantId: 2, keyId: 2, hostname: 'gv-orig' });
      const r1 = await c.patch(`/api/agent/devices/${t.id}`, { name: 'godview' });
      assert.ok(ok.includes(r1.status), `${actor} PATCH ${r1.status}`);
      assert.equal((await dev(t.id)).name, null);
      const r2 = await c.post(`/api/agent/devices/${t.id}/command`, { command: 'uninstall' });
      assert.ok(ok.includes(r2.status), `${actor} command ${r2.status}`);
      assert.equal((await dev(t.id)).pending_command, null);
      const r3 = await c.del(`/api/agent/devices/${t.id}`);
      assert.ok(ok.includes(r3.status), `${actor} DELETE ${r3.status}`);
      assert.ok(await dev(t.id));
      await c.del('/api/agent/devices/bulk', { deviceIds: [t.id] });
      assert.ok(await dev(t.id));
      await c.post('/api/agent/devices/bulk-command', { deviceIds: [t.id], command: 'uninstall' });
      assert.equal((await dev(t.id)).pending_command, null);
      const r6 = await c.post(`/api/agent/devices/${t.id}/firewall/rules`, {});
      assert.ok(ok.includes(r6.status), `${actor} firewall ${r6.status}`);
    }
  });
});
