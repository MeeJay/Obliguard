/**
 * 46 — W2-1 agent update lifecycle and presence: offers persisted in
 * agent_update_attempts and counted only once their frame was written (10-min
 * spacing, 3-offer cap under every policy), update_status frames, outcome
 * tracking on heartbeats (succeeded / reverted), the Retry endpoint, the
 * build manifest gate, download integrity headers, ?groupId&recursive, the
 * TENANT level of the update policy, presence columns and the
 * {deviceId, patch} socket payload.
 *
 * Every test starts from: global policy 'auto', no tenant / group / device
 * policy, no request, no attempt, served version '2.0.0', no build manifest,
 * a frozen update clock.
 */
import { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { startHarness, FakeWs, waitFor } from '../harness';
import type { Harness, RecordedEvent } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';
import {
  agentService,
  invalidateAgentUpdatePolicyCache,
  __resetAgentUpdateStateForTest,
  __setServedAgentVersionForTest,
  __setAgentUpdateClockForTest,
  __setAgentManifestForTest,
} from '../../src/services/agent.service';
import { resolveAgentUpdatePolicy } from '../../src/utils/agentUpdate';
import { SOCKET_EVENTS } from '@obliview/shared';

const SERVED = '2.0.0';
const MIN = 60_000;

/** A socket whose writes fail: the frame is never written. */
class BrokenWs extends FakeWs {
  tries = 0;
  send(): void { this.tries++; throw new Error('write failed'); }
}

describe('46 agent update lifecycle and presence', () => {
  let h: Harness;
  let t = Date.now();
  const sockets: FakeWs[] = [];

  before(async () => { h = await startHarness(); });
  after(async () => {
    __resetAgentUpdateStateForTest();
    await h.close();
  });

  const setGlobalDb = async (p: string | null) => {
    const row = await h.db('app_config').where({ key: 'agent_global_config' }).first('value') as { value: string } | undefined;
    const cfg = row?.value ? JSON.parse(row.value) as Record<string, unknown> : {};
    cfg.updatePolicy = p;
    await h.db('app_config').insert({ key: 'agent_global_config', value: JSON.stringify(cfg) }).onConflict('key').merge({ value: JSON.stringify(cfg) });
  };
  const setGroupDb = async (groupId: number, p: string | null) => {
    await h.db('monitor_groups').where({ id: groupId })
      .update({ agent_group_config: JSON.stringify({ pushIntervalSeconds: null, maxMissedPushes: null, notificationTypes: null, updatePolicy: p }) });
    invalidateAgentUpdatePolicyCache();
  };
  const setTenantDb = async (tenantId: number, p: string | null) => {
    await h.db('tenants').where({ id: tenantId }).update({ agent_update_policy: p });
    invalidateAgentUpdatePolicyCache();
  };
  const nest = async (parentId: number, childId: number) => {
    await h.db('group_closure').insert({ ancestor_id: parentId, descendant_id: childId, depth: 1 });
    await h.db('monitor_groups').where({ id: childId }).update({ parent_id: parentId });
    invalidateAgentUpdatePolicyCache();
  };

  beforeEach(async () => {
    await setGlobalDb('auto');
    await h.db.raw("UPDATE monitor_groups SET agent_group_config = agent_group_config - 'updatePolicy' WHERE agent_group_config ->> 'updatePolicy' IS NOT NULL");
    await h.db('agent_devices').update({ update_policy: null, update_requested_at: null, update_requested_version: null, update_requested_by: null });
    await h.db('agent_update_attempts').del();
    await h.db('tenants').update({ agent_update_policy: null });
    __resetAgentUpdateStateForTest();
    __setServedAgentVersionForTest(SERVED);
    __setAgentManifestForTest(null);
    t = Date.now();
    __setAgentUpdateClockForTest(() => t);
  });
  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.close();
  });

  // ── helpers ────────────────────────────────────────────────────────────────
  const newB = (o: { groupId?: number | null; version?: string } = {}) =>
    createDevice(h.db, { tenantId: 2, keyId: 2, groupId: o.groupId ?? null, version: o.version });
  const lv = async (uuid: string, body?: Record<string, unknown>) =>
    (await h.push(2, uuid, body)).json?.latestVersion as string | undefined;
  const attempt = (deviceId: number, v = SERVED) =>
    h.db('agent_update_attempts').where({ device_id: deviceId, target_version: v }).first();
  const getDevice = async (id: number) => (await (await h.adminIn(2)).get(`/api/agent/devices/${id}`)).json?.data;
  const hb = (hostname: string, agentVersion = '1.0.0') =>
    ({ type: 'heartbeat', hostname, agentVersion, osInfo: { platform: 'linux', distro: 'v', release: '1', arch: 'amd64' }, services: [], firewallBanned: [], firewallName: 'verify', lanIPs: [] });
  const configFrames = (ws: FakeWs) => ws.sent.filter((f) => f?.type === 'config');
  const connect = async (uuid: string, ws: FakeWs = new FakeWs()) => {
    sockets.push(ws);
    assert.equal(await obliguardHub.register(uuid, 2, 2, '127.0.0.1', ws as any), true);
    return ws;
  };

  // ── offers ─────────────────────────────────────────────────────────────────

  lotIt('W2-1', '46.1 an offer is counted once per 10 min, and only when its frame was written', async () => {
    const d = await newB();
    assert.equal(await lv(d.uuid), SERVED);
    let a = await attempt(d.id);
    assert.equal(a.offered_count, 1);
    assert.equal(a.phase, 'offered');
    t += 5 * MIN;
    assert.equal(await lv(d.uuid), undefined, 'second offer within 10 min');
    assert.equal((await attempt(d.id)).offered_count, 1);
    t += 6 * MIN;
    assert.equal(await lv(d.uuid), SERVED);
    assert.equal((await attempt(d.id)).offered_count, 2);

    // WS: a config frame that could not be written is not counted.
    const w = await newB();
    const broken = new BrokenWs();
    await connect(w.uuid, broken);
    broken.receive(hb(w.hostname));
    await waitFor(() => broken.tries >= 1, 3000);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await attempt(w.id), undefined, 'nothing counted for an unwritten frame');
    // A written frame is counted, once.
    const ok = await connect(w.uuid);
    ok.receive(hb(w.hostname));
    await waitFor(() => configFrames(ok).length >= 1, 3000);
    assert.equal(configFrames(ok)[0].latestVersion, SERVED);
    a = await waitFor(async () => attempt(w.id), 3000);
    assert.equal(a.offered_count, 1);
    ok.receive(hb(w.hostname));
    await waitFor(() => configFrames(ok).length >= 2, 3000);
    assert.equal(configFrames(ok)[1].latestVersion, undefined);
    assert.equal((await attempt(w.id)).offered_count, 1);
  });

  lotIt('W2-1', '46.2 three offers under auto, then no latestVersion and phase failed (no_progress)', async () => {
    const d = await newB();
    const t0 = t;
    for (let i = 0; i < 3; i++) {
      t = t0 + i * 11 * MIN;
      assert.equal(await lv(d.uuid), SERVED, `offer ${i + 1}`);
    }
    t = t0 + 33 * MIN;
    const r = await h.push(2, d.uuid);
    assert.equal(r.status, 200);
    assert.equal('latestVersion' in (r.json ?? {}), false, '4th heartbeat: nothing advertised');
    const a = await attempt(d.id);
    assert.equal(a.phase, 'failed');
    assert.equal(a.last_error, 'no_progress');
    assert.equal(a.offered_count, 3);
    assert.ok(a.finished_at);
    t = t0 + 60 * MIN;
    assert.equal(await lv(d.uuid), undefined, 'still stopped until a retry');
    const dev = await getDevice(d.id);
    assert.equal(dev.update.phase, 'failed');
    assert.equal(dev.update.attempts, 3);
    assert.equal(dev.update.lastError, 'no_progress');
    assert.equal(dev.update.targetVersion, SERVED);
  });

  lotIt('W2-1', '46.3 update_status frames: progress, unknown phases ignored, failed with the error', async () => {
    const d = await newB();
    const ws = await connect(d.uuid);
    ws.receive(hb(d.hostname));
    await waitFor(() => configFrames(ws).length >= 1, 3000);
    await waitFor(async () => (await attempt(d.id))?.offered_count === 1, 3000);
    ws.receive({ type: 'update_status', targetVersion: SERVED, phase: 'downloading' });
    await waitFor(async () => (await attempt(d.id))?.phase === 'downloading', 3000);
    ws.receive({ type: 'update_status', targetVersion: SERVED, phase: 'bogus' });
    ws.receive({ type: 'update_status', targetVersion: 'not-a-version', phase: 'failed' });
    ws.receive({ type: 'update_status', targetVersion: SERVED, phase: 'verifying' });
    await waitFor(async () => (await attempt(d.id))?.phase === 'verifying', 3000);
    assert.equal(await h.db('agent_update_attempts').where({ device_id: d.id }).count<{ count: string }[]>({ count: '*' }).then((r) => Number(r[0].count)), 1);
    await h.db('agent_devices').where({ id: d.id }).update({ updating_since: new Date() });
    ws.receive({ type: 'update_status', targetVersion: SERVED, phase: 'failed', error: 'sha256 mismatch' });
    const a = await waitFor(async () => {
      const r = await attempt(d.id);
      return r?.phase === 'failed' ? r : null;
    }, 3000);
    assert.equal(a.last_error, 'sha256 mismatch');
    assert.ok(a.finished_at);
    assert.equal((await h.db('agent_devices').where({ id: d.id }).first()).updating_since, null);
    // A device of another tenant cannot write through this channel's identity.
    const foreign = await createDevice(h.db, { tenantId: 3, keyId: 3 });
    assert.equal(await agentService.applyUpdateStatus(foreign.id, 2, { targetVersion: SERVED, phase: 'installing', error: null }), false);
    assert.equal(await attempt(foreign.id), undefined);
  });

  lotIt('W2-1', '46.4 outcome on heartbeat: target reported = succeeded; back on the old version after installing = failed', async () => {
    const d = await newB();
    assert.equal(await lv(d.uuid), SERVED);
    t += MIN;
    const r = await h.push(2, d.uuid, { agentVersion: SERVED });
    assert.equal(r.json?.latestVersion, undefined);
    const ok = await attempt(d.id);
    assert.equal(ok.phase, 'succeeded');
    assert.ok(ok.finished_at);
    assert.equal((await getDevice(d.id)).update.phase, 'succeeded');

    // Reverted: 'installing' reported on one channel, then a NEW channel
    // heartbeats with the old version. Real clock: the channel registration
    // time is compared with the phase change.
    __setAgentUpdateClockForTest(null);
    const e = await newB();
    const ws1 = await connect(e.uuid);
    ws1.receive(hb(e.hostname));
    await waitFor(async () => (await attempt(e.id))?.offered_count === 1, 3000);
    ws1.receive({ type: 'update_status', targetVersion: SERVED, phase: 'installing' });
    await waitFor(async () => (await attempt(e.id))?.phase === 'installing', 3000);
    // A heartbeat on the same channel (install still running) changes nothing.
    ws1.receive(hb(e.hostname));
    await waitFor(() => configFrames(ws1).length >= 2, 3000);
    assert.equal((await attempt(e.id)).phase, 'installing');
    ws1.close();
    await new Promise((res) => setTimeout(res, 5));
    const ws2 = await connect(e.uuid);
    ws2.receive(hb(e.hostname));
    await waitFor(() => configFrames(ws2).length >= 1, 3000);
    const failed = await waitFor(async () => {
      const a = await attempt(e.id);
      return a?.phase === 'failed' ? a : null;
    }, 3000);
    assert.equal(failed.last_error, 'reverted_or_failed');
  });

  lotIt('W2-1', '46.5 retry endpoint resets the attempt; same permission and refusals as update now', async () => {
    const d = await newB();
    const t0 = t;
    for (let i = 0; i < 3; i++) { t = t0 + i * 11 * MIN; assert.equal(await lv(d.uuid), SERVED); }
    t = t0 + 33 * MIN;
    assert.equal(await lv(d.uuid), undefined);
    assert.equal((await attempt(d.id)).phase, 'failed');

    assert.equal((await (await h.as('member_c')).post(`/api/agent/devices/${d.id}/update/retry`)).status, 404, 'other tenant');
    assert.equal((await (await h.adminIn(1)).post(`/api/agent/devices/${d.id}/update/retry`)).status, 403, 'god view is read-only');
    assert.equal((await attempt(d.id)).phase, 'failed');

    const r = await (await h.as('member_b')).post(`/api/agent/devices/${d.id}/update/retry`);
    assert.equal(r.status, 200, r.text);
    const a = await attempt(d.id);
    assert.equal(a.phase, 'offered');
    assert.equal(a.offered_count, 0);
    assert.equal(a.last_error, null);
    assert.equal(r.json.data.update.phase, 'offered');
    assert.equal(r.json.data.update.attempts, 0);
    t = t0 + 44 * MIN;
    assert.equal(await lv(d.uuid), SERVED, 'offered again after the retry');
    assert.equal((await attempt(d.id)).offered_count, 1);

    const cur = await newB({ version: SERVED });
    const rc = await (await h.as('member_b')).post(`/api/agent/devices/${cur.id}/update/retry`);
    assert.equal(rc.status, 409);
    assert.equal(rc.json?.code, 'alreadyCurrent');
    const off = await newB();
    await h.db('agent_devices').where({ id: off.id }).update({ update_policy: 'off' });
    const ro = await (await h.as('member_b')).post(`/api/agent/devices/${off.id}/update/retry`);
    assert.equal(ro.status, 409);
    assert.equal(ro.json?.code, 'updatePolicyOff');
  });

  // ── build manifest and download integrity ──────────────────────────────────

  lotIt('W2-1', '46.6 manifest mismatch: no advertisement for that platform, missingBuilds exposed', async () => {
    __setAgentManifestForTest({
      version: SERVED,
      artifacts: {
        'obliguard-agent-linux-amd64': { version: SERVED, sha256: '', size: 1 },
        'obliguard-agent.msi': { version: '1.9.9', sha256: '', size: 1 },
      },
    });
    const linux = await newB();
    assert.equal(await lv(linux.uuid), SERVED, 'linux/x64 = linux-amd64 build matches');
    const win = await newB();
    const rw = await h.push(2, win.uuid, { osInfo: { platform: 'windows', distro: null, release: '10', arch: 'amd64' } });
    assert.equal(rw.status, 200);
    assert.equal(rw.json?.latestVersion, undefined, 'stale MSI: nothing advertised');
    assert.equal(await attempt(win.id), undefined);
    const arm = await newB();
    const ra = await h.push(2, arm.uuid, { osInfo: { platform: 'linux', distro: null, release: '1', arch: 'arm64' } });
    assert.equal(ra.json?.latestVersion, undefined, 'missing build');

    const v = await (await h.as('member_b')).get('/api/agent/version');
    assert.equal(v.status, 200);
    assert.equal(v.json.version, SERVED);
    assert.ok(v.json.missingBuilds.includes('obliguard-agent.msi'));
    assert.ok(v.json.missingBuilds.includes('obliguard-agent-linux-arm64'));
    assert.ok(!v.json.missingBuilds.includes('obliguard-agent-linux-amd64'));
    const dist = await (await h.as('member_b')).get('/api/agent/devices/versions');
    assert.deepEqual(dist.json.data.missingBuilds, v.json.missingBuilds);
    const anon = await h.anon().get('/api/agent/version');
    assert.deepEqual(anon.json, { version: '' });
  });

  lotIt('W2-1', '46.7 downloads carry X-Content-SHA256 of the served file', async (tc) => {
    const file = path.resolve(__dirname, '..', '..', '..', 'agent', 'dist', 'obliguard-agent-linux-amd64');
    if (!fs.existsSync(file)) { tc.skip('no linux-amd64 build in agent/dist'); return; }
    const expected = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const r = await h.anon().get('/api/agent/download/obliguard-agent-linux-amd64');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-content-sha256'], expected);
    const again = await h.anon().get('/api/agent/download/obliguard-agent-linux-amd64');
    assert.equal(again.headers['x-content-sha256'], expected, 'cached per mtime + size');
    assert.equal((await h.anon().get('/api/agent/download/constructor')).status, 404);
    assert.equal((await h.anon().get('/api/agent/download/..%2Fpackage.json')).status, 404);
  });

  // ── reads ──────────────────────────────────────────────────────────────────

  lotIt('W2-1', '46.8 GET /agent/devices?groupId&recursive returns sub-group agents', async () => {
    const parent = await createGroup(h.db, { tenantId: 2 });
    const child = await createGroup(h.db, { tenantId: 2 });
    await nest(parent, child);
    const inParent = await newB({ groupId: parent });
    const inChild = await newB({ groupId: child });
    const ids = (r: { json: any }) => (r.json.data as Array<{ id: number }>).map((x) => x.id).sort((a, b) => a - b);
    const mb = await h.as('member_b');
    const rec = await mb.get(`/api/agent/devices?groupId=${parent}&recursive=1`);
    assert.equal(rec.status, 200);
    assert.deepEqual(ids(rec), [inParent.id, inChild.id].sort((a, b) => a - b));
    const direct = await mb.get(`/api/agent/devices?groupId=${parent}`);
    assert.deepEqual(ids(direct), [inParent.id]);
    const withStatus = await mb.get(`/api/agent/devices?groupId=${parent}&recursive=1&status=pending`);
    assert.deepEqual(ids(withStatus), []);
    const other = await (await h.as('member_c')).get(`/api/agent/devices?groupId=${parent}&recursive=1`);
    assert.deepEqual(ids(other), [], 'another tenant sees nothing');
    assert.equal((await mb.get('/api/agent/devices?groupId=abc')).status, 400);
  });

  // ── tenant level of the update policy ──────────────────────────────────────

  lotIt('W2-1', '46.9 tenant policy level: off absolute, nearest explicit wins, source reported', async () => {
    const g = await createGroup(h.db, { tenantId: 2 });
    const d = await newB({ groupId: g });
    const loose = await newB();

    // tenant off beats group auto (and global auto)
    await setTenantDb(2, 'off');
    await setGroupDb(g, 'auto');
    assert.equal(await lv(d.uuid), undefined);
    let dev = await getDevice(d.id);
    assert.equal(dev.resolvedUpdatePolicy, 'off');
    assert.equal(dev.updatePolicySource, 'tenant');

    // tenant auto applies when group / agent are unset (global manual)
    await setGlobalDb('manual');
    await setTenantDb(2, 'auto');
    await setGroupDb(g, null);
    assert.equal(await lv(loose.uuid), SERVED);
    dev = await getDevice(loose.id);
    assert.equal(dev.resolvedUpdatePolicy, 'auto');
    assert.equal(dev.updatePolicySource, 'tenant');

    // group manual beats tenant auto
    await setGroupDb(g, 'manual');
    assert.equal(await lv(d.uuid), undefined);
    dev = await getDevice(d.id);
    assert.equal(dev.resolvedUpdatePolicy, 'manual');
    assert.equal(dev.updatePolicySource, 'group');

    // global off beats everything
    await setGlobalDb('off');
    await setGroupDb(g, 'auto');
    await h.db('agent_devices').where({ id: d.id }).update({ update_policy: 'auto' });
    assert.equal(await lv(d.uuid), undefined);
    dev = await getDevice(d.id);
    assert.equal(dev.resolvedUpdatePolicy, 'off');
    assert.equal(dev.updatePolicySource, 'global');

    // another tenant is untouched by tenant 2's policy
    await setGlobalDb(null);
    await setTenantDb(2, null);
    await setTenantDb(3, 'auto');
    const c = await createDevice(h.db, { tenantId: 3, keyId: 3 });
    assert.equal((await h.push(3, c.uuid)).json?.latestVersion, SERVED);
    const b2 = await newB();
    assert.equal(await lv(b2.uuid), undefined, "tenant 3 'auto' does not reach tenant 2");
  });

  lotIt('W2-1', '46.10 tenant policy routes: platform admin writes the operating tenant; off drops requests', async () => {
    await setGlobalDb(null);
    const d = await newB();
    const mb = await h.as('member_b');
    assert.equal((await mb.post(`/api/agent/devices/${d.id}/agent-update`)).status, 200);
    assert.ok((await h.db('agent_devices').where({ id: d.id }).first()).update_requested_at);

    const g = await mb.get('/api/agent/update-policy/tenant');
    assert.equal(g.status, 200);
    assert.deepEqual(g.json.data, { tenantId: 2, updatePolicy: null, globalPolicy: 'manual', globalPolicyIsDefault: true });
    assert.equal((await mb.patch('/api/agent/update-policy/tenant', { updatePolicy: 'auto' })).status, 403);
    const admin = await h.adminIn(2);
    assert.equal((await admin.patch('/api/agent/update-policy/tenant', { updatePolicy: 'bogus' })).status, 400);
    assert.equal((await admin.patch('/api/agent/update-policy/tenant', {})).status, 400);
    const stale = await admin.patch('/api/agent/update-policy/tenant', { updatePolicy: 'off' }, { headers: { 'X-Obliguard-Tenant': '3' } });
    assert.equal(stale.status, 409);
    assert.equal((await h.db('tenants').where({ id: 2 }).first()).agent_update_policy, null);

    const off = await admin.patch('/api/agent/update-policy/tenant', { updatePolicy: 'off' });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.data.updatePolicy, 'off');
    assert.equal((await h.db('tenants').where({ id: 2 }).first()).agent_update_policy, 'off');
    assert.equal((await h.db('tenants').where({ id: 3 }).first()).agent_update_policy, null);
    assert.equal((await h.db('agent_devices').where({ id: d.id }).first()).update_requested_at, null, 'tenant off drops the pending request');
    assert.equal(await lv(d.uuid), undefined);
    const dist = await mb.get('/api/agent/devices/versions');
    assert.equal(dist.json.data.tenantPolicy, 'off');
    const r409 = await mb.post(`/api/agent/devices/${d.id}/agent-update`);
    assert.equal(r409.status, 409);
    assert.equal(r409.json?.code, 'updatePolicyOff');

    assert.equal((await admin.patch('/api/agent/update-policy/tenant', { updatePolicy: null })).status, 200);
    assert.equal((await h.db('tenants').where({ id: 2 }).first()).agent_update_policy, null);
    await assert.rejects(async () => { await h.db('tenants').where({ id: 2 }).update({ agent_update_policy: 'bogus' }); });
  });

  // ── presence and capabilities ──────────────────────────────────────────────

  lotIt('W2-1', '46.11 presence: last_seen_at on heartbeat (not on admin edits), last_online_at, capabilities', async () => {
    const d = await newB();
    assert.equal((await h.db('agent_devices').where({ id: d.id }).first()).last_seen_at, null);
    const caps = ['tls_unverified', 'tls_unverified', 'x'.repeat(33), 42, ...Array.from({ length: 40 }, (_, i) => `cap${i}`)];
    assert.equal((await h.push(2, d.uuid, { capabilities: caps })).status, 200);
    const row = await h.db('agent_devices').where({ id: d.id }).first();
    assert.ok(row.last_seen_at, 'last_seen_at written by the heartbeat');
    assert.equal(row.capabilities.length, 32);
    assert.equal(row.capabilities[0], 'tls_unverified');
    assert.ok(!row.capabilities.includes('x'.repeat(33)));
    const seen = new Date(row.last_seen_at).getTime();

    const admin = await h.adminIn(2);
    const renamed = await admin.patch(`/api/agent/devices/${d.id}`, { name: 'renamed' });
    assert.equal(renamed.status, 200);
    const after = await h.db('agent_devices').where({ id: d.id }).first();
    assert.equal(new Date(after.last_seen_at).getTime(), seen, 'an admin edit is not a sign of life');
    assert.equal(renamed.json.data.lastSeenAt, new Date(seen).toISOString());
    assert.deepEqual(renamed.json.data.capabilities, row.capabilities);
    // An older agent that sends no capabilities keeps the stored ones.
    await h.push(2, d.uuid);
    assert.equal((await h.db('agent_devices').where({ id: d.id }).first()).capabilities.length, 32);

    await connect(d.uuid);
    const online = await h.db('agent_devices').where({ id: d.id }).first();
    assert.ok(online.last_online_at);
    await agentService.markChannelOffline(d.id, 2);
    assert.ok((await h.db('agent_devices').where({ id: d.id }).first()).last_offline_at);
  });

  lotIt('W2-1', '46.12 AGENT_DEVICE_UPDATED carries {deviceId, patch}; a pending enrolment emits agent:deviceCreated to tenant admins', async () => {
    const s = await h.socket(await h.adminIn(2));
    if (!s.ok) throw new Error(s.error);
    const find = (ev: string, pred: (p: any) => boolean) => s.events.find((e: RecordedEvent) => e.event === ev && pred(e.args[0]));
    const d = await newB();
    const admin = await h.adminIn(2);
    assert.equal((await admin.patch(`/api/agent/devices/${d.id}`, { name: 'patched' })).status, 200);
    const one = await waitFor(() => find(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, (p) => p?.deviceId === d.id), 3000);
    assert.equal(one.args[0].patch.name, 'patched');
    assert.equal(one.args[0].patch.status, 'approved');
    assert.equal('name' in one.args[0], false, 'no legacy flat payload');

    const g = await createGroup(h.db, { tenantId: 2 });
    assert.equal((await admin.patch('/api/agent/devices/bulk', { deviceIds: [d.id], groupId: g })).status, 200);
    const bulk = await waitFor(() => find(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, (p) => p?.deviceId === d.id && p?.patch?.groupId === g), 3000);
    assert.equal('status' in bulk.args[0].patch, false, 'a bulk patch carries the written fields only');

    const uuid = `t-${crypto.randomUUID()}`;
    const p = await h.push(2, uuid);
    assert.equal(p.json?.status, 'pending');
    const created = await waitFor(() => find('agent:deviceCreated', (q) => q?.device?.uuid === uuid), 3000);
    assert.equal(created.args[0].device.status, 'pending');
    assert.equal(typeof created.args[0].deviceId, 'number');
  });

  lotIt('W2-1', '46.13 stuck updates time out without touching updated_at; legacy notifying-update = installing', async () => {
    const d = await newB();
    assert.equal(await lv(d.uuid), SERVED);
    const before = await h.db('agent_devices').where({ id: d.id }).first();
    await agentService.setDeviceUpdating(d.id, 2);
    const mid = await h.db('agent_devices').where({ id: d.id }).first();
    assert.ok(mid.updating_since);
    assert.equal(new Date(mid.updated_at).getTime(), new Date(before.updated_at).getTime(), 'setDeviceUpdating leaves updated_at');
    assert.equal((await attempt(d.id)).phase, 'installing');
    t += 11 * MIN;
    await h.db('agent_devices').where({ id: d.id }).update({ updating_since: new Date(t - 11 * MIN) });
    await agentService.cleanupStuckUpdating();
    const a = await attempt(d.id);
    assert.equal(a.phase, 'failed');
    assert.equal(a.last_error, 'timeout');
    const after = await h.db('agent_devices').where({ id: d.id }).first();
    assert.equal(after.updating_since, null);
    assert.equal(new Date(after.updated_at).getTime(), new Date(before.updated_at).getTime(), 'cleanup leaves updated_at');
    // A failed attempt with offers left is offered again after the spacing.
    assert.equal(await lv(d.uuid), SERVED);
    assert.equal((await attempt(d.id)).offered_count, 2);
  });

  lotIt('W2-1', '46.15 resolveAgentUpdatePolicy with the tenant level (pure)', () => {
    const g = (groupId: number, policy: 'auto' | 'manual' | 'off') => ({ groupId, tenantId: 2, policy });
    assert.deepEqual(resolveAgentUpdatePolicy(null, [g(1, 'auto')], 'off', 'auto'), { policy: 'off', source: 'tenant', sourceGroupId: null });
    assert.deepEqual(resolveAgentUpdatePolicy('auto', [g(1, 'off')], 'off', null), { policy: 'off', source: 'tenant', sourceGroupId: null }, 'tenant is reported above a group');
    assert.deepEqual(resolveAgentUpdatePolicy(null, [], 'off', 'off'), { policy: 'off', source: 'global', sourceGroupId: null });
    assert.deepEqual(resolveAgentUpdatePolicy(null, [], 'auto', 'manual'), { policy: 'auto', source: 'tenant', sourceGroupId: null });
    assert.deepEqual(resolveAgentUpdatePolicy(null, [g(1, 'manual')], 'auto', null), { policy: 'manual', source: 'group', sourceGroupId: 1 });
    assert.deepEqual(resolveAgentUpdatePolicy('auto', [], 'manual', null), { policy: 'auto', source: 'agent', sourceGroupId: null });
    assert.deepEqual(resolveAgentUpdatePolicy(null, [], null, null), { policy: 'manual', source: 'default', sourceGroupId: null });
    assert.deepEqual(resolveAgentUpdatePolicy(null, [], null, 'auto'), { policy: 'auto', source: 'global', sourceGroupId: null });
  });

  lotIt('W2-1', '46.16 WS heartbeat capabilities, update_status before the first heartbeat, no re-offer while in flight', async () => {
    // Capabilities travel in the WS heartbeat too (the Go agent's channel).
    const d = await newB();
    const ws = await connect(d.uuid);
    ws.receive({ ...hb(d.hostname), capabilities: ['tls_unverified', 'update_status'] });
    await waitFor(() => configFrames(ws).length >= 1, 3000);
    assert.deepEqual((await h.db('agent_devices').where({ id: d.id }).first()).capabilities, ['tls_unverified', 'update_status']);

    // A restarted agent reporting a failure before its first heartbeat on the new channel.
    ws.close();
    const ws2 = await connect(d.uuid);
    ws2.receive({ type: 'update_status', targetVersion: SERVED, phase: 'failed', error: 'msiexec 1603' });
    const failed = await waitFor(async () => {
      const a = await attempt(d.id);
      return a?.phase === 'failed' ? a : null;
    }, 3000);
    assert.equal(failed.last_error, 'msiexec 1603');

    // In flight: a progress phase younger than the timeout is not re-offered nor abandoned.
    // Same WS channel throughout, so the heartbeats are not a reconnection.
    const e = await newB();
    const we = await connect(e.uuid);
    we.receive(hb(e.hostname));
    await waitFor(async () => (await attempt(e.id))?.offered_count === 1, 3000);
    t += MIN;
    we.receive({ type: 'update_status', targetVersion: SERVED, phase: 'installing' });
    await waitFor(async () => (await attempt(e.id))?.phase === 'installing', 3000);
    t += 9.5 * MIN; // 10.5 min after the offer (spacing passed), 9.5 after the phase change
    we.receive(hb(e.hostname));
    await waitFor(() => configFrames(we).length >= 2, 3000);
    assert.equal(configFrames(we)[1].latestVersion, undefined, 'not re-offered while installing');
    const mid = await attempt(e.id);
    assert.equal(mid.phase, 'installing');
    assert.equal(mid.offered_count, 1);
    t += 2 * MIN; // the phase is now older than the timeout
    we.receive(hb(e.hostname));
    await waitFor(() => configFrames(we).length >= 3, 3000);
    assert.equal(configFrames(we)[2].latestVersion, SERVED);
    await waitFor(async () => (await attempt(e.id))?.offered_count === 2, 3000);
  });

  lotIt('W2-7', '46.17 a group or global policy set to off cancels the open attempts it freezes', async () => {
    const parent = await createGroup(h.db, { tenantId: 2 });
    const child = await createGroup(h.db, { tenantId: 2 });
    await nest(parent, child);
    const inTree = await newB({ groupId: child });
    const outside = await newB();
    assert.equal(await lv(inTree.uuid), SERVED);
    assert.equal(await lv(outside.uuid), SERVED);
    const admin = await h.adminIn(2);
    const r = await admin.patch(`/api/groups/${parent}/agent-config`, { agentGroupConfig: { updatePolicy: 'off' } });
    assert.equal(r.status, 200, r.text);
    const a1 = await attempt(inTree.id);
    assert.equal(a1.phase, 'cancelled');
    assert.ok(a1.finished_at);
    assert.equal((await attempt(outside.id)).phase, 'offered', 'outside the frozen sub-tree');
    const g = await (await h.adminIn(1)).patch('/api/admin/config/agent-global', { updatePolicy: 'off' });
    assert.equal(g.status, 200, g.text);
    assert.equal((await attempt(outside.id)).phase, 'cancelled');
  });

  // Destructive: runs last.
  lotIt('W2-1', '46.14 migration 031 down then up (idempotent)', async () => {
    const mig = await import('../../src/db/migrations/031_agent_presence_update_attempts');
    await mig.down(h.db);
    assert.equal(await h.db.schema.hasTable('agent_update_attempts'), false);
    for (const col of ['last_seen_at', 'last_online_at', 'last_offline_at', 'capabilities']) {
      assert.equal(await h.db.schema.hasColumn('agent_devices', col), false, col);
    }
    assert.equal(await h.db.schema.hasColumn('tenants', 'agent_update_policy'), false);
    await mig.up(h.db);
    await mig.up(h.db);
    assert.equal(await h.db.schema.hasTable('agent_update_attempts'), true);
    for (const col of ['last_seen_at', 'last_online_at', 'last_offline_at', 'capabilities']) {
      assert.equal(await h.db.schema.hasColumn('agent_devices', col), true, col);
    }
    const approvedSeen = await h.db('agent_devices').where({ status: 'approved' }).whereNull('last_seen_at').count<{ count: string }[]>({ count: '*' });
    assert.equal(Number(approvedSeen[0].count), 0, 'approved devices backfilled from updated_at');
    const c = await h.db.raw("SELECT conname FROM pg_constraint WHERE conname IN ('agent_update_attempts_phase_check', 'tenants_agent_update_policy_check')");
    assert.equal(c.rows.length, 2);
  });
});
