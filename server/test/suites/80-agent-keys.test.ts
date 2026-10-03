/**
 * 80 — W10-2 agent API key lifecycle (FLEET-AGENT-13, SECURITY-PARITY-19,
 * UI-PAGES-FLEET-14; owner decision 19: is_active flag, keys not hashed).
 *
 *   80.1 the list never returns full keys (masked prefix + last 4); create
 *        returns the full key once, with its default group
 *   80.2 a disabled key: push 401 (same body as an unknown key), live WS
 *        closed 4003, new upgrades 401; devices stay bound; re-enable works
 *   80.3 registration lands in the key's default group; approval without a
 *        group choice keeps it
 *   80.4 default group of another tenant → 400 (create and PUT); foreign key
 *        → 404; no agents.keys → 403; validation (empty name, empty patch)
 *   80.5 reveal: active key of the tenant only (disabled / foreign → 404);
 *        the offline wizard never bakes a disabled key
 *   80.6 hub: a key disabled while an upgrade is in flight cannot register
 *        until it is re-enabled
 */
import { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import WebSocket from 'ws';
import { startHarness, waitFor, FakeWs } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup, createKey } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';
import { agentService } from '../../src/services/agent.service';

type UpgradeResult =
  | { kind: 'open'; ws: WebSocket }
  | { kind: 'refused'; code: number }
  | { kind: 'close'; code: number }
  | { kind: 'timeout' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uniqUuid = (p: string) => `${p}-${crypto.randomBytes(6).toString('hex')}`;

describe('80 agent API key lifecycle (W10-2)', () => {
  let h: Harness;
  const clients: WebSocket[] = [];
  const fakes: FakeWs[] = [];

  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });
  afterEach(() => {
    for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* ignore */ } }
    for (const f of fakes.splice(0)) { try { f.close(); } catch { /* ignore */ } }
  });

  function upgrade(key: string, uuid: string): Promise<UpgradeResult> {
    const url = `ws://127.0.0.1:${h.port}/api/agent/ws?uuid=${encodeURIComponent(uuid)}`;
    const ws = new WebSocket(url, { headers: { 'x-api-key': key } });
    clients.push(ws);
    return new Promise<UpgradeResult>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'timeout' }), 3000);
      ws.on('open', () => { clearTimeout(timer); resolve({ kind: 'open', ws }); });
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        res.on('end', () => { clearTimeout(timer); resolve({ kind: 'refused', code: res.statusCode ?? 0 }); });
      });
      ws.on('close', (code) => { clearTimeout(timer); resolve({ kind: 'close', code }); });
      ws.on('error', () => { /* reported through unexpected-response / close */ });
    });
  }

  function closeOf(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string } | null> {
    return new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) { resolve(null); return; }
      const timer = setTimeout(() => resolve(null), timeoutMs);
      ws.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
    });
  }

  lotIt('W10-2', '80.1 the list is masked; create returns the full key once', async () => {
    const admin = await h.adminIn(2);
    const g = await createGroup(h.db, { tenantId: 2, name: 'keys-default-group' });
    const created = await admin.post('/api/agent/keys', { name: '  fleet key  ', defaultGroupId: g });
    assert.equal(created.status, 201, created.text);
    const data = created.json.data as Record<string, unknown>;
    assert.match(String(data.key), UUID_RE);
    assert.equal(data.name, 'fleet key');
    assert.equal(data.isActive, true);
    assert.equal(data.defaultGroupId, g);
    assert.equal(data.defaultGroupName, 'keys-default-group');
    const row = await h.db('agent_api_keys').where({ id: data.id }).first();
    assert.equal(row.key, data.key);
    assert.equal(row.default_group_id, g);

    const list = await admin.get('/api/agent/keys');
    assert.equal(list.status, 200, list.text);
    const rows = list.json.data as Array<Record<string, unknown>>;
    assert.ok(rows.length > 0);
    // No full key of the tenant anywhere in the response.
    const tenantKeys = (await h.db('agent_api_keys').where({ tenant_id: 2 }).select('key')) as Array<{ key: string }>;
    for (const k of tenantKeys) assert.ok(!list.text.includes(k.key), 'a full key leaked in the list');
    for (const r of rows) {
      assert.equal(r.key, undefined);
      assert.equal(r.tenantId, 2);
      assert.match(String(r.keyMasked), /^[0-9a-f-]{8}…[0-9a-f]{4}$/i);
    }
    const mine = rows.find((r) => r.id === data.id)!;
    assert.equal(mine.keyMasked, `${String(data.key).slice(0, 8)}…${String(data.key).slice(-4)}`);
    assert.equal(mine.defaultGroupName, 'keys-default-group');
    assert.equal(mine.deviceCount, 0);
  });

  lotIt('W10-2', '80.2 a disabled key is refused like an unknown one; re-enable works', async () => {
    const admin = await h.adminIn(2);
    const k = await createKey(h.db, 2);
    const d = await createDevice(h.db, { tenantId: 2, keyId: k.id });

    const ok = await h.push({ key: k.key }, d.uuid);
    assert.equal(ok.status, 200, ok.text);
    const r = await upgrade(k.key, uniqUuid('w102'));
    assert.equal(r.kind, 'open');
    const ws = (r as { ws: WebSocket }).ws;
    const closed = closeOf(ws);

    const off = await admin.put(`/api/agent/keys/${k.id}`, { isActive: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.data.isActive, false);
    assert.equal(off.json.data.closedSessions, 1);
    assert.ok(off.json.data.revokedAt);
    const c = await closed;
    assert.equal(c?.code, 4003);
    const row = await h.db('agent_api_keys').where({ id: k.id }).first();
    assert.equal(row.is_active, false);
    assert.ok(row.revoked_at);
    assert.equal(row.revoked_by, 1);

    // Same answer as an unknown key, on both channels.
    const refused = await h.push({ key: k.key }, d.uuid);
    const unknown = await h.push({ key: crypto.randomUUID() }, d.uuid);
    assert.equal(refused.status, 401);
    assert.equal(refused.text, unknown.text);
    const again = await upgrade(k.key, d.uuid);
    assert.equal((again as { code: number }).code, 401);
    // The device keeps its binding and history (no orphaning).
    assert.equal((await h.db('agent_devices').where({ id: d.id }).first()).api_key_id, k.id);

    const on = await admin.put(`/api/agent/keys/${k.id}`, { isActive: true });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.data.isActive, true);
    assert.equal(on.json.data.revokedAt, null);
    assert.equal((await h.push({ key: k.key }, d.uuid)).status, 200);
    const back = await upgrade(k.key, d.uuid);
    assert.equal(back.kind, 'open');
  });

  lotIt('W10-2', '80.3 registration lands in the default group; approval keeps it', async () => {
    const admin = await h.adminIn(2);
    const g = await createGroup(h.db, { tenantId: 2 });
    const created = await admin.post('/api/agent/keys', { name: 'with-group', defaultGroupId: g });
    assert.equal(created.status, 201, created.text);
    const key = String(created.json.data.key);

    const uuid = uniqUuid('w102-reg');
    const p = await h.push({ key }, uuid);
    assert.equal(p.status, 202, p.text); // pending enrolment
    const dev = await h.db('agent_devices').where({ uuid }).first();
    assert.equal(dev.status, 'pending');
    assert.equal(dev.group_id, g);
    const listed = (await admin.get('/api/agent/keys')).json.data as Array<Record<string, unknown>>;
    const view = listed.find((r) => r.id === created.json.data.id)!;
    assert.equal(view.deviceCount, 1);
    assert.equal(view.pendingCount, 1);

    // Approval with no group choice keeps the registration group.
    const approved = await agentService.approveDevice(dev.id, 1, undefined);
    assert.equal(approved?.groupId, g);
    // A pending device registered before the key had a group gets it at approval.
    const g2 = await createGroup(h.db, { tenantId: 2 });
    const k2 = await createKey(h.db, 2);
    const d2 = await createDevice(h.db, { tenantId: 2, keyId: k2.id, status: 'pending' });
    assert.equal((await admin.put(`/api/agent/keys/${k2.id}`, { defaultGroupId: g2 })).status, 200);
    assert.equal((await agentService.approveDevice(d2.id, 1, undefined))?.groupId, g2);
    // An explicit "no group" is honoured.
    const d3 = await createDevice(h.db, { tenantId: 2, keyId: k2.id, status: 'pending', groupId: g2 });
    assert.equal((await agentService.approveDevice(d3.id, 1, null))?.groupId, null);

    // Without a default group the device stays ungrouped.
    const k3 = await createKey(h.db, 2);
    const uuid3 = uniqUuid('w102-nogroup');
    assert.equal((await h.push({ key: k3.key }, uuid3)).status, 202);
    assert.equal((await h.db('agent_devices').where({ uuid: uuid3 }).first()).group_id, null);
  });

  lotIt('W10-2', '80.4 foreign default group 400, foreign key 404, capability and validation', async () => {
    const admin = await h.adminIn(2);
    const foreignGroup = await createGroup(h.db, { tenantId: 3 });
    const bad = await admin.post('/api/agent/keys', { name: 'x', defaultGroupId: foreignGroup });
    assert.equal(bad.status, 400, bad.text);
    assert.equal(await h.db('agent_api_keys').where({ name: 'x', tenant_id: 2 }).first(), undefined);

    const k = await createKey(h.db, 2);
    const put = await admin.put(`/api/agent/keys/${k.id}`, { defaultGroupId: foreignGroup });
    assert.equal(put.status, 400, put.text);
    assert.equal((await h.db('agent_api_keys').where({ id: k.id }).first()).default_group_id, null);
    assert.equal((await admin.put(`/api/agent/keys/${k.id}`, { defaultGroupId: 'abc' })).status, 400);

    // A key of tenant 3 is not reachable from tenant 2 (no god view on credentials).
    const k3 = await createKey(h.db, 3);
    assert.equal((await admin.put(`/api/agent/keys/${k3.id}`, { isActive: false })).status, 404);
    assert.equal((await h.db('agent_api_keys').where({ id: k3.id }).first()).is_active, true);

    // Validation.
    assert.equal((await admin.put(`/api/agent/keys/${k.id}`, { name: '   ' })).status, 400);
    assert.equal((await admin.put(`/api/agent/keys/${k.id}`, {})).status, 400);
    assert.equal((await admin.put(`/api/agent/keys/${k.id}`, { isActive: 'no' })).status, 400);
    assert.equal((await admin.put('/api/agent/keys/abc', { name: 'n' })).status, 400);
    const renamed = await admin.put(`/api/agent/keys/${k.id}`, { name: 'renamed key' });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.json.data.name, 'renamed key');
    assert.equal(renamed.json.data.key, undefined);

    // agents.keys is required (the default 'user' set does not hold it).
    const member = await h.as('member_b');
    assert.equal((await member.put(`/api/agent/keys/${k.id}`, { isActive: false })).status, 403);
    assert.equal((await member.get(`/api/agent/keys/${k.id}/reveal`)).status, 403);
    assert.equal((await h.db('agent_api_keys').where({ id: k.id }).first()).is_active, true);
  });

  lotIt('W10-2', '80.5 reveal serves active keys of the tenant only; the wizard skips disabled keys', async () => {
    const admin = await h.adminIn(2);
    const k = await createKey(h.db, 2);
    const r = await admin.get(`/api/agent/keys/${k.id}/reveal`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.key, k.key);
    assert.match(String(r.headers['cache-control'] ?? ''), /no-store/);

    const k3 = await createKey(h.db, 3);
    assert.equal((await admin.get(`/api/agent/keys/${k3.id}/reveal`)).status, 404);

    assert.equal((await admin.put(`/api/agent/keys/${k.id}`, { isActive: false })).status, 200);
    assert.equal((await admin.get(`/api/agent/keys/${k.id}/reveal`)).status, 404);
    assert.equal(await agentService.getKeyById(k.id, 2), null);
    assert.equal((await admin.put(`/api/agent/keys/${k.id}`, { isActive: true })).status, 200);
    assert.equal(await agentService.getKeyById(k.id, 2), k.key);
  });

  lotIt('W10-2', '80.6 a disabled key cannot register an in-flight upgrade until re-enabled', async () => {
    const k = await createKey(h.db, 2);
    const live = new FakeWs();
    fakes.push(live);
    assert.equal(await obliguardHub.register(uniqUuid('w102-live'), 2, k.id, '127.0.0.1', live as never), true);
    assert.equal(obliguardHub.closeByApiKey(k.id), 1);
    await waitFor(() => live.closed !== null, 2000);
    assert.equal(live.closed?.code, 4003);

    // The gate verdict was obtained before the key was disabled.
    const late = new FakeWs();
    fakes.push(late);
    assert.equal(await obliguardHub.register(uniqUuid('w102-late'), 2, k.id, '127.0.0.1', late as never), false);
    assert.equal(late.closed?.code, 4003);

    obliguardHub.allowApiKey(k.id);
    const ok = new FakeWs();
    fakes.push(ok);
    assert.equal(await obliguardHub.register(uniqUuid('w102-ok'), 2, k.id, '127.0.0.1', ok as never), true);
  });
});
