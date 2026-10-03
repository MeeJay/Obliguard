/**
 * 27 — A5 agent channel: device ↔ API-key binding on the HTTP push, the
 * pre-upgrade WS gate (HTTP refusals, never a 101), live connections never
 * displaced, key revocation, suspend/refuse teardown, approval-gated drain and
 * ingestion, device-bound firewall responses, first-heartbeat deadline,
 * enrolment race, notifying-update binding and the Obligate link gating.
 *
 * Every FakeWs / ws client is closed in finally or afterEach (the hub is a
 * per-process singleton).
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import crypto from 'crypto';
import WebSocket from 'ws';
import { startHarness, waitFor, drain, FakeWs } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { KEYS } from '../fixtures';
import { createDevice, createGroup, createKey, createMikrotikDevice, nextIp } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';
import { agentService } from '../../src/services/agent.service';
import { obligateService } from '../../src/services/obligate.service';

type UpgradeResult =
  | { kind: 'open'; ws: WebSocket }
  | { kind: 'refused'; code: number; body: string }
  | { kind: 'close'; code: number }
  | { kind: 'timeout' };

const uniqUuid = (p: string) => `${p}-${crypto.randomBytes(6).toString('hex')}`;

describe('27 agent channel (A5)', () => {
  let h: Harness;
  const clients: WebSocket[] = [];
  const fakes: FakeWs[] = [];

  before(async () => { h = await startHarness({ obligate: true }); });
  after(async () => { await h.close(); });
  afterEach(() => {
    for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* ignore */ } }
    for (const f of fakes.splice(0)) { try { f.close(); } catch { /* ignore */ } }
  });

  const dev = (id: number) => h.db('agent_devices').where({ id }).first();
  const fake = () => { const f = new FakeWs(); fakes.push(f); return f; };

  function upgrade(key: string | null, uuid: string): Promise<UpgradeResult> {
    const url = `ws://127.0.0.1:${h.port}/api/agent/ws?uuid=${encodeURIComponent(uuid)}`;
    const ws = new WebSocket(url, { headers: key === null ? {} : { 'x-api-key': key } });
    clients.push(ws);
    return new Promise<UpgradeResult>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'timeout' }), 3000);
      ws.on('open', () => { clearTimeout(timer); resolve({ kind: 'open', ws }); });
      ws.on('unexpected-response', (_req, res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => { clearTimeout(timer); resolve({ kind: 'refused', code: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); });
      });
      ws.on('close', (code) => { clearTimeout(timer); resolve({ kind: 'close', code }); });
      ws.on('error', () => { /* reported through unexpected-response / close */ });
    });
  }

  /** Raw TCP handshake: returns the HTTP status line (the Go agent checks for 101). */
  function rawStatusLine(headers: Record<string, string>, uuid: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(h.port, '127.0.0.1');
      let buf = '';
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('raw handshake timeout')); }, 3000);
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        const i = buf.indexOf('\r\n');
        if (i >= 0) { clearTimeout(timer); sock.destroy(); resolve(buf.slice(0, i)); }
      });
      sock.on('error', () => { /* destroyed */ });
      sock.on('close', () => { clearTimeout(timer); resolve(buf.split('\r\n')[0] ?? ''); });
      const lines = [
        `GET /api/agent/ws?uuid=${encodeURIComponent(uuid)} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '', '',
      ];
      sock.write(lines.join('\r\n'));
    });
  }

  function heartbeat(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'heartbeat', hostname: 'hb-host', agentVersion: '1.0.0',
      osInfo: { platform: 'linux', distro: 'verify', release: '1', arch: 'x64' },
      services: [], firewallBanned: [], firewallName: 'verify', lanIPs: [], ...extra,
    };
  }

  function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<any | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { ws.off('message', on); resolve(null); }, timeoutMs);
      const on = (d: Buffer) => { clearTimeout(timer); ws.off('message', on); try { resolve(JSON.parse(d.toString())); } catch { resolve(null); } };
      ws.on('message', on);
    });
  }

  function closeOf(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string } | null> {
    return new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) { resolve(null); return; }
      const timer = setTimeout(() => resolve(null), timeoutMs);
      ws.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
    });
  }

  // ── HTTP push ──────────────────────────────────────────────────────────────

  lotIt('A5', '27.1 HTTP push with another tenant key leaves the device untouched', async () => {
    const d = await createDevice(h.db, { tenantId: 2, keyId: 2, hostname: 'a-host' });
    await h.db('agent_devices').where({ id: d.id }).update({ pending_command: 'uninstall' });
    const before = await dev(d.id);
    const ip = nextIp();
    const r = await h.push(3, d.uuid, {
      hostname: 'evil', events: [h.event(ip, { service: 'custom:verify' })], lanIPs: ['10.0.0.9'], services: [{ type: 'ssh', port: 22, active: true }],
    });
    assert.equal(r.status, 401);
    const after = await dev(d.id);
    for (const k of ['hostname', 'ip', 'os_info', 'agent_version', 'api_key_id', 'pending_command', 'tenant_id']) {
      assert.deepEqual(after[k], before[k], k);
    }
    assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
    assert.equal((await h.db('agent_ips').where({ agent_id: d.id })).length, 0);
    assert.equal((await h.db('agent_services').where({ device_id: d.id })).length, 0);
    assert.equal((await h.db('ip_events').where({ device_id: d.id })).length, 0);
    assert.equal(await h.db('ip_reputation').where({ ip }).first(), undefined);
  });

  lotIt('A5', '27.2 malformed credentials are refused cleanly (push and WS)', async () => {
    const t0 = Date.now();
    const r1 = await h.push({ key: 'not-a-uuid' }, 'dev-b-0001');
    assert.equal(r1.status, 401);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal((await h.push(2, '../etc')).status, 400);
    assert.equal((await h.push(2, 'a'.repeat(70))).status, 400);

    const d = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const cases: Array<[Record<string, string>, string, string]> = [
      [{}, d.uuid, '401'],
      [{ 'X-Api-Key': 'x' }, d.uuid, '400'],
      [{ 'X-Api-Key': KEYS[2] }, 'a', '400'],
      [{ 'X-Api-Key': crypto.randomUUID() }, d.uuid, '401'],
    ];
    for (const [hdr, uuid, code] of cases) {
      const line = await rawStatusLine(hdr, uuid);
      assert.ok(!line.includes('101'), `got ${line}`);
      assert.ok(line.includes(code), `expected ${code}, got ${line}`);
    }
    assert.equal(h.unhandled.length, 0, h.unhandled.join('\n'));
  });

  lotIt('A5', '27.3 an early client reset during the gate does not crash the server', async () => {
    const d = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    await new Promise<void>((resolve) => {
      const sock = net.connect(h.port, '127.0.0.1', () => {
        sock.write([
          `GET /api/agent/ws?uuid=${d.uuid} HTTP/1.1`, 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13',
          `X-Api-Key: ${KEYS[2]}`, '', '',
        ].join('\r\n'));
        sock.resetAndDestroy();
        resolve();
      });
      sock.on('error', () => { /* ignore */ });
    });
    const ok = await upgrade(KEYS[2], d.uuid);
    assert.equal(ok.kind, 'open');
    assert.equal(h.unhandled.length, 0, h.unhandled.join('\n'));
  });

  lotIt('A5', '27.4 MikroTik rows are never claimable by an agent key', async () => {
    const m = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: `mt-${crypto.randomBytes(3).toString('hex')}` });
    await h.db('agent_devices').where({ id: m.id }).update({ api_key_id: null });
    const before = await dev(m.id);
    assert.equal((await h.push(2, m.uuid, { hostname: 'claim' })).status, 401);
    const r = await upgrade(KEYS[2], m.uuid);
    assert.equal(r.kind, 'refused');
    assert.equal((r as { code: number }).code, 403);
    const after = await dev(m.id);
    assert.equal(after.api_key_id, null);
    assert.equal(after.hostname, before.hostname);
  });

  lotIt('A5', '27.5 concurrent first pushes create exactly one row', async () => {
    const uuid = uniqUuid('race');
    const [a, b] = await Promise.all([h.push(2, uuid), h.push(2, uuid)]);
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.equal((await h.db('agent_devices').where({ uuid })).length, 1);
  });

  lotIt('A5', '27.6 notifying-update is bound to the device key and approval', async () => {
    const d = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const p = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'pending' });
    const notify = (key: string, uuid: string) => h.anon().post('/api/agent/notifying-update', {}, { headers: { 'x-api-key': key, 'x-device-uuid': uuid } });
    assert.equal((await notify(KEYS[3], d.uuid)).status, 404);
    assert.equal((await dev(d.id)).updating_since, null);
    assert.equal((await notify(KEYS[2], p.uuid)).status, 404);
    assert.equal((await dev(p.id)).updating_since, null);
    assert.equal((await notify(KEYS[2], d.uuid)).status, 200);
    assert.ok((await dev(d.id)).updating_since);
  });

  lotIt('A5', '27.7 Obligate links are registered for approved devices only', async () => {
    const n0 = h.obligate!.requests.length;
    const reg = (uuid: string) => h.obligate!.requests.slice(n0).filter((q) => q.path === '/api/devices/register' && q.body?.uuid === uuid);
    const pendingUuid = uniqUuid('link-p');
    assert.equal((await h.push(2, pendingUuid)).status, 202);
    const refused = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'refused' });
    assert.equal((await h.push(2, refused.uuid)).status, 401);
    const ok = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    assert.equal((await h.push(2, ok.uuid)).status, 200);
    await drain(() => reg(ok.uuid).length > 0, 2000);
    assert.equal(reg(ok.uuid).length, 1);
    assert.equal(reg(ok.uuid)[0].body?.path, `/agents/${ok.id}`);
    assert.equal(reg(pendingUuid).length, 0);
    assert.equal(reg(refused.uuid).length, 0);
    // throttled: a second push does not register again
    await h.push(2, ok.uuid);
    assert.equal(reg(ok.uuid).length, 1);
  });

  lotIt('A5', '27.8 the Obligate link throttle map is bounded', () => {
    const saved = new Map(obligateService._linkThrottle);
    try {
      for (let i = 0; i < 10_050; i++) obligateService._recordLink(`bound-${i}`, Date.now());
      assert.ok(obligateService._linkThrottle.size <= 10_000);
    } finally {
      obligateService._linkThrottle.clear();
      for (const [k, v] of saved) obligateService._linkThrottle.set(k, v);
    }
  });

  // ── WS gate ────────────────────────────────────────────────────────────────

  lotIt('A5', '27.9 a foreign key never displaces a live connection', async () => {
    const d = await createDevice(h.db, { tenantId: 3, keyId: 3 });
    const own = await upgrade(KEYS[3], d.uuid);
    assert.equal(own.kind, 'open');
    const ownWs = (own as { ws: WebSocket }).ws;
    const foreign = await upgrade(KEYS[2], d.uuid);
    assert.equal(foreign.kind, 'refused');
    assert.equal((foreign as { code: number }).code, 403);
    assert.equal(ownWs.readyState, WebSocket.OPEN);
    const got = nextMessage(ownWs);
    assert.equal(obliguardHub.push(d.uuid, { type: 'ping-test', id: 'x1', payload: {} }), true);
    assert.equal((await got)?.type, 'ping-test');
  });

  lotIt('A5', '27.10 live conflict on a fresh uuid; same key replaces', async () => {
    const uuid = uniqUuid('fresh');
    const k2 = await createKey(h.db, 2);
    const first = await upgrade(KEYS[2], uuid);
    assert.equal(first.kind, 'open');
    const firstWs = (first as { ws: WebSocket }).ws;
    const second = await upgrade(k2.key, uuid);
    assert.equal(second.kind, 'refused');
    assert.equal((second as { code: number }).code, 403);
    assert.match((second as { body: string }).body, /already connected with another API key/);
    assert.equal(firstWs.readyState, WebSocket.OPEN);
    const closed = closeOf(firstWs);
    const again = await upgrade(KEYS[2], uuid);
    assert.equal(again.kind, 'open');
    const c = await closed;
    assert.equal(c?.code, 1000);
    assert.equal(c?.reason, 'replaced');
  });

  lotIt('A5', '27.11 suspended / refused at the door; pending gets no config', async () => {
    const s = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'suspended' });
    const rs = await upgrade(KEYS[2], s.uuid);
    assert.equal(rs.kind, 'refused');
    assert.equal((rs as { code: number }).code, 403);
    assert.match((rs as { body: string }).body, /Device suspended/);
    const f = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'refused' });
    const rf = await upgrade(KEYS[2], f.uuid);
    assert.equal((rf as { code: number }).code, 403);
    assert.match((rf as { body: string }).body, /Device refused/);
    const p = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'pending' });
    const rp = await upgrade(KEYS[2], p.uuid);
    assert.equal(rp.kind, 'open');
    const ws = (rp as { ws: WebSocket }).ws;
    const msg = nextMessage(ws, 800);
    ws.send(JSON.stringify(heartbeat()));
    assert.equal(await msg, null);
  });

  lotIt('A5', '27.12 same-tenant re-key: refused until the binding is released', async () => {
    const ka1 = await createKey(h.db, 2);
    const ka2 = await createKey(h.db, 2);
    const g = await createGroup(h.db, { tenantId: 2, evaluateOnly: true });
    const d = await createDevice(h.db, { tenantId: 2, keyId: ka1.id, groupId: g });
    await h.db('agent_devices').where({ id: d.id }).update({ evaluate_only: true });
    const r1 = await upgrade(ka2.key, d.uuid);
    assert.equal((r1 as { code: number }).code, 403);
    const mb = await h.as('member_b');
    assert.equal((await mb.patch(`/api/agent/devices/${d.id}`, { apiKeyId: 5 })).status, 400);
    assert.equal((await dev(d.id)).api_key_id, ka1.id);
    assert.equal((await mb.patch(`/api/agent/devices/${d.id}`, { apiKeyId: null })).status, 200);
    assert.equal((await dev(d.id)).api_key_id, null);
    const r2 = await upgrade(ka2.key, d.uuid);
    assert.equal(r2.kind, 'open');
    const ws = (r2 as { ws: WebSocket }).ws;
    const cfg = nextMessage(ws);
    ws.send(JSON.stringify(heartbeat()));
    assert.equal((await cfg)?.type, 'config');
    const row = await dev(d.id);
    assert.equal(row.api_key_id, ka2.id);
    assert.equal(row.group_id, g);
    assert.equal(row.evaluate_only, true);
    ws.terminate();
    await waitFor(() => !obliguardHub.hasLiveConflict(d.uuid, 2, ka1.id), 2000);
    const r3 = await upgrade(ka1.key, d.uuid);
    assert.equal((r3 as { code: number }).code, 403);
    // Deleting the bound key releases it (FK SET NULL); the other key re-binds.
    assert.equal((await (await h.adminIn(2)).del(`/api/agent/keys/${ka2.id}`)).status, 200);
    assert.equal((await dev(d.id)).api_key_id, null);
    const r4 = await upgrade(ka1.key, d.uuid);
    assert.equal(r4.kind, 'open');
    assert.equal((await dev(d.id)).api_key_id, ka1.id);
  });

  lotIt('A5', '27.13 key revocation: last-used, tenant-scoped delete, sessions closed', async () => {
    const k = await createKey(h.db, 2);
    const d = await createDevice(h.db, { tenantId: 2, keyId: k.id });
    const r = await upgrade(k.key, d.uuid);
    assert.equal(r.kind, 'open');
    const ws = (r as { ws: WebSocket }).ws;
    await waitFor(async () => (await h.db('agent_api_keys').where({ id: k.id }).first())?.last_used_at, 2000);
    const foreign = await (await h.adminIn(3)).del(`/api/agent/keys/${k.id}`);
    assert.equal(foreign.status, 404);
    assert.equal(ws.readyState, WebSocket.OPEN);
    const closed = closeOf(ws, 1000);
    const del = await (await h.adminIn(2)).del(`/api/agent/keys/${k.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.json?.data?.closedSessions, 1);
    const c = await closed;
    assert.equal(c?.code, 4003);
    assert.equal(c?.reason, 'API key revoked');
    const again = await upgrade(k.key, d.uuid);
    assert.equal((again as { code: number }).code, 401);
  });

  lotIt('A5', '27.14 suspend, bulk suspend and delete close the channel', async () => {
    const mb = await h.as('member_b');
    const d = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const r = await upgrade(KEYS[2], d.uuid);
    assert.equal(r.kind, 'open');
    const closed = closeOf((r as { ws: WebSocket }).ws, 1000);
    assert.equal((await mb.patch(`/api/agent/devices/${d.id}`, { status: 'suspended' })).status, 200);
    assert.equal((await closed)?.code, 4003);
    const again = await upgrade(KEYS[2], d.uuid);
    assert.equal((again as { code: number }).code, 403);

    const b1 = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const b2 = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const w1 = fake(); const w2 = fake();
    await obliguardHub.register(b1.uuid, 2, 2, '127.0.0.1', w1 as any);
    await obliguardHub.register(b2.uuid, 2, 2, '127.0.0.1', w2 as any);
    const bulk = await mb.patch('/api/agent/devices/bulk', { deviceIds: [b1.id, b2.id], status: 'suspended' });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.json?.data?.affected, 2);
    assert.equal(w1.closed?.code, 4003);
    assert.equal(w2.closed?.code, 4003);

    const x = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const wx = fake();
    await obliguardHub.register(x.uuid, 2, 2, '127.0.0.1', wx as any);
    // Owner decision 12 (_defaults.txt): the 'user' set (member_b) lacks
    // agents.delete since the W7-2 re-gating; a tenant-2 admin deletes.
    assert.equal((await mb.del(`/api/agent/devices/${x.id}`)).status, 403);
    assert.equal(wx.closed?.code, undefined, 'a refused delete keeps the channel open');
    assert.equal((await (await h.adminIn(2)).del(`/api/agent/devices/${x.id}`)).status, 200);
    assert.equal(wx.closed?.code, 4003);
    assert.equal(wx.closed?.reason, 'Device deleted');
  });

  // ── Hub internals (FakeWs) ─────────────────────────────────────────────────

  lotIt('A5', '27.15 first-heartbeat deadline closes a silent socket', async () => {
    const saved = obliguardHub.firstHeartbeatDeadlineMs;
    obliguardHub.firstHeartbeatDeadlineMs = 300;
    try {
      const uuid = uniqUuid('silent');
      const w = fake();
      assert.equal(await obliguardHub.register(uuid, 2, 2, '127.0.0.1', w as any), true);
      await waitFor(() => w.closed?.code === 4008, 2000);
      assert.equal(w.closed?.reason, 'No heartbeat');
      assert.equal(obliguardHub.isConnected(uuid), false);
    } finally {
      obliguardHub.firstHeartbeatDeadlineMs = saved;
    }
  });

  lotIt('A5', '27.16 drain on connect: approved only, uninstall only', async () => {
    const p = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'pending' });
    await h.db('agent_devices').where({ id: p.id }).update({ pending_command: 'uninstall' });
    const wp = fake();
    await obliguardHub.register(p.uuid, 2, 2, '127.0.0.1', wp as any);
    assert.equal(wp.sent.length, 0);
    assert.equal((await dev(p.id)).pending_command, 'uninstall');
    wp.close();

    await h.db('agent_devices').where({ id: p.id }).update({ status: 'approved' });
    const wa = fake();
    await obliguardHub.register(p.uuid, 2, 2, '127.0.0.1', wa as any);
    assert.deepEqual(wa.sent, [{ type: 'config', command: 'uninstall' }]);
    const row = await dev(p.id);
    assert.equal(row.pending_command, null);
    assert.ok(row.uninstall_commanded_at);
    wa.close();

    const u = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    await h.db('agent_devices').where({ id: u.id }).update({ pending_command: 'update' });
    const wu = fake();
    await obliguardHub.register(u.uuid, 2, 2, '127.0.0.1', wu as any);
    assert.equal(wu.sent.length, 0);
    assert.equal((await dev(u.id)).pending_command, 'update');
    wu.receive(heartbeat());
    await waitFor(() => wu.sent.some((m) => m.type === 'config' && m.command === 'update'), 3000);
    assert.equal((await dev(u.id)).pending_command, null);
  });

  lotIt('A5', '27.17 unapproved devices never ingest events', async () => {
    const p = await createDevice(h.db, { tenantId: 2, keyId: 2, status: 'pending' });
    const w = fake();
    await obliguardHub.register(p.uuid, 2, 2, '127.0.0.1', w as any);
    const ip1 = nextIp();
    w.receive({ type: 'events', events: [h.event(ip1, { service: 'custom:verify' })] });
    assert.equal(await drain(async () => (await h.db('ip_events').where({ device_id: p.id })).length > 0, 500), null);
    assert.equal(await h.db('ip_reputation').where({ ip: ip1 }).first(), undefined);

    assert.equal((await (await h.as('member_b')).patch(`/api/agent/devices/${p.id}`, { status: 'approved' })).status, 200);
    const ip2 = nextIp();
    w.receive({ type: 'events', events: [h.event(ip2, { service: 'custom:verify' })] });
    const rows = await waitFor(async () => {
      const r = await h.db('ip_events').where({ device_id: p.id });
      return r.length > 0 ? r : null;
    }, 3000);
    assert.ok(rows.every((r: any) => r.tenant_id === 2));

    const before = (await h.db('ip_events').where({ device_id: p.id })).length;
    await agentService.processEventsFlush(p.id, 3, [h.event(nextIp(), { service: 'custom:verify' }) as any]);
    assert.equal((await h.db('ip_events').where({ device_id: p.id })).length, before);
  });

  lotIt('A5', '27.18 firewall responses are bound to the target device', async () => {
    const a = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const b = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const wa = fake(); const wb = fake();
    await obliguardHub.register(a.uuid, 2, 2, '127.0.0.1', wa as any);
    await obliguardHub.register(b.uuid, 2, 2, '127.0.0.1', wb as any);
    const id = `fw-${crypto.randomBytes(4).toString('hex')}`;
    let settled = false;
    const p = obliguardHub.pushAndWait(a.uuid, { type: 'firewall_list', id, payload: {} }, 5000)
      .finally(() => { settled = true; });
    assert.equal(wa.sent.at(-1)?.id, id);
    wb.receive({ type: 'firewall_response', id, rules: ['fake'] });
    assert.equal(await drain(() => settled, 300), null);
    wa.receive({ type: 'firewall_response', id, rules: ['real'] });
    const res = await p as { rules: string[] };
    assert.deepEqual(res.rules, ['real']);

    const id2 = `fw-${crypto.randomBytes(4).toString('hex')}`;
    const p2 = obliguardHub.pushAndWait(a.uuid, { type: 'firewall_list', id: id2, payload: {} }, 5000);
    wa.close();
    await assert.rejects(p2, /not connected/);
  });

  lotIt('A5', '27.20 releasing the binding closes the live channel of the old key', async () => {
    const k1 = await createKey(h.db, 2);
    const d = await createDevice(h.db, { tenantId: 2, keyId: k1.id });
    const r = await upgrade(k1.key, d.uuid);
    assert.equal(r.kind, 'open');
    const ws = (r as { ws: WebSocket }).ws;
    const closed = closeOf(ws, 1500);
    const mb = await h.as('member_b');
    const res = await mb.patch(`/api/agent/devices/${d.id}`, { apiKeyId: null });
    assert.equal(res.status, 200);
    assert.equal(res.json?.data?.apiKeyId, null);
    const c = await closed;
    assert.equal(c?.code, 4003);
    assert.equal(c?.reason, 'Key binding released');
    // No heartbeat of the old socket re-claimed the binding.
    assert.equal((await dev(d.id)).api_key_id, null);
  });

  lotIt('A5', '27.21 a refused request never claims the binding of a suspended/refused row', async () => {
    for (const status of ['suspended', 'refused'] as const) {
      const d = await createDevice(h.db, { tenantId: 2, keyId: 2, status });
      await h.db('agent_devices').where({ id: d.id }).update({ api_key_id: null });
      const r = await upgrade(KEYS[2], d.uuid);
      assert.equal((r as { code: number }).code, 403);
      assert.equal((await dev(d.id)).api_key_id, null, `ws ${status}`);
      assert.equal((await h.push(2, d.uuid)).status, 401);
      assert.equal((await dev(d.id)).api_key_id, null, `push ${status}`);
    }
  });

  lotIt('A5', '27.22 row-less sockets are counted per key until their first heartbeat', async () => {
    const k = await createKey(h.db, 2);
    const base = obliguardHub.countRowlessForKey(k.id);
    const w1 = fake(); const w2 = fake();
    const u1 = uniqUuid('rowless'); const u2 = uniqUuid('rowless');
    await obliguardHub.register(u1, 2, k.id, '127.0.0.1', w1 as any, { rowless: true });
    await obliguardHub.register(u2, 2, k.id, '127.0.0.1', w2 as any, { rowless: true });
    assert.equal(obliguardHub.countRowlessForKey(k.id), base + 2);
    w1.receive(heartbeat());
    await waitFor(async () => (await h.db('agent_devices').where({ uuid: u1 }).first()) ?? null, 3000);
    await waitFor(() => obliguardHub.countRowlessForKey(k.id) === base + 1, 2000);
    w2.close();
    await waitFor(() => obliguardHub.countRowlessForKey(k.id) === base, 2000);
  });

  it('27.19 harness sanity: no unhandled rejection recorded', () => {
    assert.equal(h.unhandled.length, 0, h.unhandled.join('\n'));
  });
});
