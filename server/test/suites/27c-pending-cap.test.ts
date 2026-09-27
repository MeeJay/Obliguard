// verify-env: AGENT_MAX_PENDING_PER_KEY=2
/**
 * 27c — A5 per-key pending cap (AGENT_MAX_PENDING_PER_KEY=2): the gate answers
 * 429 for a new uuid once the cap is reached, the HTTP push answers 202 with no
 * row, live row-less sockets count against the cap, and two sockets that
 * passed the gate concurrently end with one row and one closed 1013
 * 'Enrolment deferred'.
 */
import { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import WebSocket from 'ws';
import { startHarness, waitFor, FakeWs } from '../harness';
import { obliguardHub } from '../../src/services/obliguardHub.service';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createKey, createDevice } from '../seed';
import { AGENT_MAX_PENDING_PER_KEY } from '../../src/services/agent.service';

const uniqUuid = (p: string) => `${p}-${crypto.randomBytes(6).toString('hex')}`;

describe('27c pending cap (A5)', () => {
  let h: Harness;
  const clients: WebSocket[] = [];
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });
  afterEach(() => { for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* ignore */ } } });

  function upgrade(key: string, uuid: string): Promise<{ kind: string; code?: number; ws: WebSocket }> {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/agent/ws?uuid=${encodeURIComponent(uuid)}`, { headers: { 'x-api-key': key } });
    clients.push(ws);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'timeout', ws }), 3000);
      ws.on('open', () => { clearTimeout(timer); resolve({ kind: 'open', ws }); });
      ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve({ kind: 'refused', code: res.statusCode, ws }); });
      ws.on('error', () => { /* reported above */ });
    });
  }

  const hb = () => JSON.stringify({ type: 'heartbeat', hostname: 'cap', agentVersion: '1.0.0', services: [], firewallBanned: [], lanIPs: [] });
  const pendingOf = async (keyId: number) => (await h.db('agent_devices').where({ api_key_id: keyId, status: 'pending' })).length;

  lotIt('A5', '27c.1 the cap bounds WS and HTTP enrolment', async () => {
    assert.equal(AGENT_MAX_PENDING_PER_KEY, 2);
    const k = await createKey(h.db, 2);
    for (let i = 0; i < 2; i++) {
      const r = await upgrade(k.key, uniqUuid('cap'));
      assert.equal(r.kind, 'open');
      r.ws.send(hb());
    }
    await waitFor(async () => (await pendingOf(k.id)) === 2, 3000);
    const third = uniqUuid('cap3');
    const r3 = await upgrade(k.key, third);
    assert.equal(r3.code, 429);
    const p = await h.push({ key: k.key }, third);
    assert.equal(p.status, 202);
    assert.equal(await h.db('agent_devices').where({ uuid: third }).first(), undefined);
  });

  lotIt('A5', '27c.2 live row-less sockets count against the cap at the gate', async () => {
    const k = await createKey(h.db, 2);
    await createDevice(h.db, { tenantId: 2, keyId: k.id, status: 'pending' });
    const a = await upgrade(k.key, uniqUuid('rowless-a'));
    assert.equal(a.kind, 'open');
    // 1 pending row + 1 socket still waiting for its first heartbeat = cap.
    await waitFor(() => obliguardHub.countRowlessForKey(k.id) === 1, 2000);
    const b = await upgrade(k.key, uniqUuid('rowless-b'));
    assert.equal(b.code, 429);
    a.ws.send(hb());
    await waitFor(async () => (await pendingOf(k.id)) === 2, 3000);
    assert.equal(obliguardHub.countRowlessForKey(k.id), 0);
  });

  lotIt('A5', '27c.3 two sockets racing the last slot: one row, one deferred', async () => {
    // Both passed the gate concurrently (simulated by registering directly).
    const k = await createKey(h.db, 2);
    await createDevice(h.db, { tenantId: 2, keyId: k.id, status: 'pending' });
    const wa = new FakeWs(); const wb = new FakeWs();
    try {
      await obliguardHub.register(uniqUuid('race-a'), 2, k.id, '127.0.0.1', wa as any, { rowless: true });
      await obliguardHub.register(uniqUuid('race-b'), 2, k.id, '127.0.0.1', wb as any, { rowless: true });
      wa.receive(JSON.parse(hb()));
      await waitFor(async () => (await pendingOf(k.id)) === 2, 3000);
      wb.receive(JSON.parse(hb()));
      await waitFor(() => wb.closed !== null, 3000);
      assert.equal(wb.closed?.code, 1013);
      assert.equal(wb.closed?.reason, 'Enrolment deferred');
      assert.equal(wa.closed, null);
      assert.equal(await pendingOf(k.id), 2);
    } finally {
      try { wa.close(); } catch { /* ignore */ }
      try { wb.close(); } catch { /* ignore */ }
    }
  });
});
