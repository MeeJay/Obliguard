/**
 * 31 — C17-1 agent update control on the harness: gated latestVersion (HTTP
 * push and WS hub), policy precedence and tenant isolation of the group
 * chain, explicit update requests (TTL, pinning, throttle, 3-offer cap,
 * cancel, race), strict tenant writes, the global policy (Default only), the
 * command allow-list, the anonymous /version neutralisation, fail-closed
 * policy resolution and the migration.
 *
 * Every test starts from: global policy UNSET (built-in 'manual'), no group
 * or device policy, no request, served version '2.0.0', a frozen clock.
 * Foreign-tenant writes from Default answer 403 (A5 deviceAccessVerdict),
 * 404 from any other tenant.
 */
import { describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, FakeWs } from '../harness';
import type { Harness, Res } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup, litIp } from '../seed';
import { D, G } from '../fixtures';
import { obliguardHub } from '../../src/services/obliguardHub.service';
import {
  agentService,
  clearUpdateRequestIfUnchanged,
  invalidateAgentUpdatePolicyCache,
  __resetAgentUpdateStateForTest,
  __setServedAgentVersionForTest,
  __setAgentUpdateClockForTest,
  __setGroupUpdatePolicyChainsLoaderForTest,
} from '../../src/services/agent.service';

const SERVED = '2.0.0';
const MIN = 60_000;

describe('31 agent update control', () => {
  let h: Harness;
  let t = Date.now();
  const sockets: FakeWs[] = [];

  before(async () => { h = await startHarness(); });
  after(async () => {
    __resetAgentUpdateStateForTest();
    await h.close();
  });

  beforeEach(async () => {
    const row = await h.db('app_config').where({ key: 'agent_global_config' }).first('value') as { value: string } | undefined;
    if (row?.value) {
      const cfg = JSON.parse(row.value) as Record<string, unknown>;
      delete cfg.updatePolicy;
      await h.db('app_config').where({ key: 'agent_global_config' }).update({ value: JSON.stringify(cfg) });
    }
    await h.db.raw("UPDATE monitor_groups SET agent_group_config = agent_group_config - 'updatePolicy' WHERE agent_group_config ->> 'updatePolicy' IS NOT NULL");
    await h.db('agent_devices').update({ update_policy: null, update_requested_at: null, update_requested_version: null, update_requested_by: null });
    __resetAgentUpdateStateForTest();
    __setServedAgentVersionForTest(SERVED);
    t = Date.now();
    __setAgentUpdateClockForTest(() => t);
  });
  afterEach(() => {
    for (const ws of sockets.splice(0)) ws.close();
  });

  // ── helpers ────────────────────────────────────────────────────────────────
  const lv = async (key: 1 | 2 | 3, uuid: string, body?: Record<string, unknown>) => (await h.push(key, uuid, body)).json?.latestVersion as string | undefined;
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
  const nest = async (parentId: number, childId: number) => {
    await h.db('group_closure').insert({ ancestor_id: parentId, descendant_id: childId, depth: 1 });
    await h.db('monitor_groups').where({ id: childId }).update({ parent_id: parentId });
    invalidateAgentUpdatePolicyCache();
  };
  const row = (id: number) => h.db('agent_devices').where({ id }).first();
  const getDevice = async (id: number) => (await (await h.adminIn(1)).get(`/api/agent/devices/${id}`)).json?.data;
  const liveRequestDb = async (id: number, version = SERVED) => {
    await h.db('agent_devices').where({ id }).update({ update_requested_at: new Date(t - MIN), update_requested_version: version });
  };
  const b = () => h.adminIn(2);
  const newB = (o: { groupId?: number | null; version?: string; status?: 'approved' | 'pending' | 'refused' | 'suspended' } = {}) =>
    createDevice(h.db, { tenantId: 2, keyId: 2, groupId: o.groupId ?? null, version: o.version, status: o.status });
  const code = (r: Res) => r.json?.code as string | undefined;

  // ── advertisement ──────────────────────────────────────────────────────────

  lotIt('C17', '31.1 gating: default manual, global auto, 10-min throttle', async () => {
    const d = await newB();
    const pushRes = await h.push(2, d.uuid);
    assert.equal(pushRes.status, 200);
    assert.equal('latestVersion' in (pushRes.json ?? {}), false, 'no latestVersion key under the default policy');
    const r = await (await h.adminIn(1)).patch('/api/admin/config/agent-global', { updatePolicy: 'auto' });
    assert.equal(r.status, 200, r.text);
    assert.equal(await lv(2, d.uuid), SERVED);
    t += 5 * MIN;
    assert.equal(await lv(2, d.uuid), undefined, 'second offer within 10 min');
    t += 6 * MIN;
    assert.equal(await lv(2, d.uuid), SERVED);
  });

  lotIt('C17', '31.2 overrides: device off, global off, group chain', async () => {
    const d = await newB();
    await setGlobalDb('auto');
    await h.db('agent_devices').where({ id: d.id }).update({ update_policy: 'off' });
    assert.equal(await lv(2, d.uuid), undefined, "global auto + device off");
    await setGlobalDb('off');
    await h.db('agent_devices').where({ id: d.id }).update({ update_policy: 'auto' });
    assert.equal(await lv(2, d.uuid), undefined, "global off + device auto");

    await setGlobalDb(null);
    await h.db('agent_devices').where({ id: d.id }).update({ update_policy: null });
    const parent = await createGroup(h.db, { tenantId: 2 });
    const child = await createGroup(h.db, { tenantId: 2 });
    await nest(parent, child);
    const c = await newB({ groupId: child });
    await setGroupDb(parent, 'auto');
    assert.equal(await lv(2, c.uuid), SERVED, 'parent auto reaches the child group');
    __resetAgentUpdateStateForTest(); __setServedAgentVersionForTest(SERVED); __setAgentUpdateClockForTest(() => t);
    await setGroupDb(parent, 'off');
    await setGroupDb(child, 'auto');
    assert.equal(await lv(2, c.uuid), undefined, 'parent off freezes the child');
    const dev = await getDevice(c.id);
    assert.equal(dev.resolvedUpdatePolicy, 'off');
    assert.equal(dev.updatePolicySource, 'group');
    assert.equal(dev.updatePolicySourceGroupId, parent);
  });

  lotIt('C17', '31.3 a group of another tenant in the ancestor chain is ignored', async () => {
    const parent = await createGroup(h.db, { tenantId: 1 });
    const child = await createGroup(h.db, { tenantId: 2 });
    await nest(parent, child);
    const d = await newB({ groupId: child });
    await setGroupDb(parent, 'auto');
    assert.equal(await lv(2, d.uuid), undefined);
    const dev = await getDevice(d.id);
    assert.equal(dev.resolvedUpdatePolicy, 'manual');
    assert.equal(dev.updatePolicySource, 'default');
    await setGlobalDb('auto');
    await setGroupDb(parent, 'off');
    assert.equal(await lv(2, d.uuid), SERVED, 'a foreign off does not freeze the device');
  });

  lotIt('C17', '31.4 regressions: evaluate-only, pending, MikroTik', async () => {
    await setGlobalDb('auto');
    const banned = litIp('2001:db8', 0x310a, 1);
    const r = await h.push(2, D.B_EVAL.uuid, { firewallBanned: [banned] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.banList.add, []);
    assert.deepEqual(r.json.banList.remove, [banned]);
    assert.equal(r.json.latestVersion, SERVED);

    const p = await h.push(2, D.B_PENDING.uuid);
    assert.equal(p.json?.status, 'pending');
    assert.equal(p.json?.latestVersion, undefined);

    const mt = await createDevice(h.db, { tenantId: 2, keyId: 2, deviceType: 'mikrotik' });
    const m = await h.push(2, mt.uuid);
    assert.equal(m.json?.latestVersion, undefined);
    const dev = await getDevice(mt.id);
    assert.equal(dev.updateAvailable, false);
  });

  lotIt('C17', '31.5 WS hub parity', async () => {
    const d = await newB();
    const ws = new FakeWs();
    sockets.push(ws);
    await obliguardHub.register(d.uuid, 2, 2, '127.0.0.1', ws as any);
    const hb = { type: 'heartbeat', hostname: d.hostname, agentVersion: '1.0.0', services: [], firewallBanned: [], firewallName: 'verify', lanIPs: [] };
    const frames = () => ws.sent.filter((f) => f?.type === 'config');
    const waitN = async (n: number) => {
      const deadline = Date.now() + 3000;
      while (frames().length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    };
    ws.receive(hb);
    await waitN(1);
    assert.ok(frames().length >= 1);
    assert.equal('latestVersion' in frames()[0], false);
    await setGlobalDb('auto');
    const n = frames().length;
    ws.receive(hb);
    await waitN(n + 1);
    assert.equal(frames().at(-1)?.latestVersion, SERVED);
  });

  lotIt('C17', '31.6 fail-safe: group chain lookup failure fails closed, never blocks the config', async () => {
    const grouped = await newB({ groupId: G.B });
    const loose = await newB();
    await setGlobalDb('auto');
    await liveRequestDb(grouped.id);
    const before = await row(grouped.id);
    __setGroupUpdatePolicyChainsLoaderForTest(async () => { throw new Error('boom'); });
    try {
      const r = await h.push(2, grouped.uuid);
      assert.equal(r.status, 200);
      assert.equal(r.json.status, 'ok');
      assert.ok(r.json.banList && Array.isArray(r.json.whitelist) && typeof r.json.services === 'object');
      assert.equal(r.json.latestVersion, undefined);
      const after = await row(grouped.id);
      assert.equal(after.update_requested_version, SERVED);
      assert.equal(new Date(after.update_requested_at).getTime(), new Date(before.update_requested_at).getTime());
      assert.equal((await getDevice(grouped.id)).updatePolicySource, 'unresolved');
      assert.equal(await lv(2, loose.uuid), SERVED, 'a device without group is not frozen');
    } finally {
      __setGroupUpdatePolicyChainsLoaderForTest(null);
    }
  });

  lotIt('C17', '31.7 served version unavailable: nothing advertised, requests kept, 503', async () => {
    const d = await newB();
    await setGlobalDb('auto');
    await liveRequestDb(d.id);
    __setServedAgentVersionForTest(null);
    assert.equal(await lv(2, d.uuid), undefined);
    const r0 = await row(d.id);
    assert.equal(r0.update_requested_version, SERVED);
    const r = await (await b()).post(`/api/agent/devices/${d.id}/agent-update`);
    assert.equal(r.status, 503);
    assert.equal(code(r), 'versionUnavailable');
  });

  // ── explicit requests ──────────────────────────────────────────────────────

  lotIt('C17', '31.8 update request flow (tenant member with monitor_rw)', async () => {
    const d = await newB();
    const mb = await h.as('member_b');
    const before = await row(d.id);
    const r = await mb.post(`/api/agent/devices/${d.id}/agent-update`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.updatePending, true);
    const after = await row(d.id);
    assert.equal(after.update_requested_version, SERVED);
    assert.ok(after.update_requested_at);
    assert.equal(after.update_requested_by, 4);
    assert.equal(new Date(after.updated_at).getTime(), new Date(before.updated_at).getTime(), 'updated_at untouched');
    assert.equal(await lv(2, d.uuid), SERVED);
    t += 11 * MIN;
    assert.equal(await lv(2, d.uuid, { agentVersion: SERVED }), undefined);
    const done = await row(d.id);
    assert.equal(done.update_requested_at, null);
    assert.equal(done.update_requested_version, null);
    assert.equal(done.update_requested_by, null);
  });

  lotIt('C17', '31.9 request invalidation: superseded, expired, abandoned, cancelled', async () => {
    const admin = await b();
    // superseded
    const d1 = await newB();
    assert.equal((await admin.post(`/api/agent/devices/${d1.id}/agent-update`)).status, 200);
    __setServedAgentVersionForTest('2.0.1');
    assert.equal(await lv(2, d1.uuid), undefined);
    assert.equal((await row(d1.id)).update_requested_at, null);
    __setServedAgentVersionForTest(SERVED);
    // expired
    const d2 = await newB();
    assert.equal((await admin.post(`/api/agent/devices/${d2.id}/agent-update`)).status, 200);
    await h.db.raw("UPDATE agent_devices SET update_requested_at = now() - interval '25 hours' WHERE id = ?", [d2.id]);
    assert.equal(await lv(2, d2.uuid), undefined);
    assert.equal((await row(d2.id)).update_requested_at, null);
    // abandoned after 3 offers
    const d3 = await newB();
    assert.equal((await admin.post(`/api/agent/devices/${d3.id}/agent-update`)).status, 200);
    const t0 = t;
    assert.equal(await lv(2, d3.uuid), SERVED);
    t = t0 + 11 * MIN;
    assert.equal(await lv(2, d3.uuid), SERVED);
    t = t0 + 22 * MIN;
    assert.equal(await lv(2, d3.uuid), SERVED);
    t = t0 + 33 * MIN;
    assert.equal(await lv(2, d3.uuid), undefined);
    assert.equal((await row(d3.id)).update_requested_at, null);
    // cancelled
    const d4 = await newB();
    assert.equal((await admin.post(`/api/agent/devices/${d4.id}/agent-update`)).status, 200);
    const c = await admin.del(`/api/agent/devices/${d4.id}/agent-update`);
    assert.equal(c.status, 200);
    assert.equal(c.json.data.updatePending, false);
    assert.equal((await row(d4.id)).update_requested_at, null);
  });

  lotIt('C17', '31.10 race: a newer click survives the conditional clear', async () => {
    const d = await newB();
    const admin = await b();
    assert.equal((await admin.post(`/api/agent/devices/${d.id}/agent-update`)).status, 200);
    const firstMs = new Date((await row(d.id)).update_requested_at).getTime();
    t += 1000;
    assert.equal((await admin.post(`/api/agent/devices/${d.id}/agent-update`)).status, 200);
    assert.equal(await clearUpdateRequestIfUnchanged(d.id, firstMs), false);
    const r = await row(d.id);
    assert.equal(new Date(r.update_requested_at).getTime(), firstMs + 1000);
    assert.equal(await clearUpdateRequestIfUnchanged(d.id, firstMs + 1000), true);
  });

  lotIt('C17', '31.11 the throttle survives re-clicks; the offer budget restarts', async () => {
    const d = await newB();
    const admin = await b();
    const t0 = t;
    assert.equal((await admin.post(`/api/agent/devices/${d.id}/agent-update`)).status, 200);
    assert.equal(await lv(2, d.uuid), SERVED);
    t = t0 + MIN;
    assert.equal((await admin.post(`/api/agent/devices/${d.id}/agent-update`)).status, 200);
    t = t0 + 2 * MIN;
    assert.equal(await lv(2, d.uuid), undefined, 'the re-click keeps the 10-min throttle');
    t = t0 + 11 * MIN;
    assert.equal(await lv(2, d.uuid), SERVED);
    t = t0 + 22 * MIN;
    assert.equal(await lv(2, d.uuid), SERVED);
    t = t0 + 33 * MIN;
    assert.equal(await lv(2, d.uuid), SERVED, 'three further offers after the re-click');
    t = t0 + 44 * MIN;
    assert.equal(await lv(2, d.uuid), undefined);
    assert.equal((await row(d.id)).update_requested_at, null);
  });

  lotIt('C17', '31.12 suspension and refusal drop the request', async () => {
    const admin = await b();
    for (const status of ['suspended', 'refused'] as const) {
      const d = await newB();
      assert.equal((await admin.post(`/api/agent/devices/${d.id}/agent-update`)).status, 200);
      assert.equal((await admin.patch(`/api/agent/devices/${d.id}`, { status })).status, 200);
      assert.equal((await row(d.id)).update_requested_at, null, status);
    }
    const d = await newB();
    assert.equal((await admin.post(`/api/agent/devices/${d.id}/agent-update`)).status, 200);
    const r = await admin.patch('/api/agent/devices/bulk', { deviceIds: [d.id], status: 'suspended' });
    assert.equal(r.status, 200);
    assert.equal((await row(d.id)).update_requested_at, null);
    assert.equal((await admin.patch(`/api/agent/devices/${d.id}`, { status: 'approved' })).status, 200);
    assert.equal((await row(d.id)).update_requested_at, null, 'reinstating does not bring the request back');
  });

  lotIt('C17', '31.13 request refusals', async () => {
    const admin = await b();
    const off = await newB();
    await h.db('agent_devices').where({ id: off.id }).update({ update_policy: 'off' });
    const r1 = await admin.post(`/api/agent/devices/${off.id}/agent-update`);
    assert.equal(r1.status, 409);
    assert.equal(code(r1), 'updatePolicyOff');
    const cur = await newB({ version: SERVED });
    const r2 = await admin.post(`/api/agent/devices/${cur.id}/agent-update`);
    assert.equal(r2.status, 409);
    assert.equal(code(r2), 'alreadyCurrent');
    const pend = await newB({ status: 'pending' });
    const r3 = await admin.post(`/api/agent/devices/${pend.id}/agent-update`);
    assert.equal(r3.status, 409);
    assert.equal(code(r3), 'notUpdatable');
    for (const id of [off.id, cur.id, pend.id]) assert.equal((await row(id)).update_requested_at, null);
    const outsider = await (await h.as('member_c')).post(`/api/agent/devices/${off.id}/agent-update`);
    assert.equal(outsider.status, 404);
  });

  // ── tenant isolation of writes ─────────────────────────────────────────────

  lotIt('C17', '31.14 update requests are strict on the operating tenant', async () => {
    const dB = await newB();
    const dDef = await createDevice(h.db, { tenantId: 1, keyId: 1 });
    const godAdmin = await h.adminIn(1);
    const r1 = await godAdmin.post(`/api/agent/devices/${dB.id}/agent-update`);
    assert.equal(r1.status, 403);
    assert.equal((await row(dB.id)).update_requested_at, null);
    assert.equal((await godAdmin.del(`/api/agent/devices/${dB.id}/agent-update`)).status, 403);

    const dm = await h.as('default_member');
    const r2 = await dm.post('/api/agent/devices/bulk-request-update', { deviceIds: [dDef.id, dB.id] });
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r2.json.data.requested, 1);
    assert.equal(r2.json.data.skipped.notFound, 1);
    assert.equal((await row(dB.id)).update_requested_at, null);
    const r3 = await dm.post('/api/agent/devices/bulk-command', { deviceIds: [dDef.id, dB.id], command: 'update' });
    assert.equal(r3.status, 200);
    assert.equal(r3.json.data.requested, 1);
    assert.equal(r3.json.data.skipped.notFound, 1);
    assert.equal((await row(dB.id)).pending_command, null);

    const root = await createGroup(h.db, { tenantId: 2 });
    const sub = await createGroup(h.db, { tenantId: 2 });
    await nest(root, sub);
    await newB({ groupId: root });
    await newB({ groupId: sub });
    await newB({ groupId: root, version: SERVED });
    const foreign = await createDevice(h.db, { tenantId: 3, keyId: 3, groupId: sub });
    assert.equal((await godAdmin.post(`/api/agent/groups/${root}/agent-update`)).status, 403);
    assert.equal((await (await h.as('member_c')).post(`/api/agent/groups/${root}/agent-update`)).status, 404);
    const r4 = await (await h.as('member_b')).post(`/api/agent/groups/${root}/agent-update`);
    assert.equal(r4.status, 200, r4.text);
    assert.equal(r4.json.data.requested, 2, 'the sub-group device is included');
    assert.equal(r4.json.data.skipped.current, 1);
    assert.equal((await row(foreign.id)).update_requested_at, null, 'a nested device of another tenant is excluded');
  });

  lotIt('C17', '31.15 policy writes are strict on the operating tenant', async () => {
    const dB = await newB();
    const dDef = await createDevice(h.db, { tenantId: 1, keyId: 1 });
    const godAdmin = await h.adminIn(1);
    const r1 = await godAdmin.patch(`/api/agent/devices/${dB.id}`, { updatePolicy: 'auto', name: 'hijack' });
    assert.equal(r1.status, 403);
    const rb = await row(dB.id);
    assert.equal(rb.update_policy, null);
    assert.equal(rb.name, null);

    const r2 = await godAdmin.patch('/api/agent/devices/bulk', { deviceIds: [dDef.id, dB.id], updatePolicy: 'off', heartbeatMonitoring: false });
    assert.equal(r2.status, 200, r2.text);
    assert.deepEqual(r2.json.data, { affected: 1, skipped: 1 });
    assert.equal((await row(dDef.id)).update_policy, 'off');
    assert.equal((await row(dB.id)).update_policy, null);

    const g = await createGroup(h.db, { tenantId: 2 });
    const inG = await newB({ groupId: g });
    assert.equal((await godAdmin.patch(`/api/groups/${g}/agent-config`, { agentGroupConfig: { updatePolicy: 'auto' } })).status, 403);
    assert.equal((await godAdmin.patch(`/api/groups/${g}/agent-config`, { agentGroupConfig: { pushIntervalSeconds: 30 } })).status, 403);
    assert.equal((await h.db('monitor_groups').where({ id: g }).first()).agent_group_config, null);
    assert.equal(await lv(2, inG.uuid), undefined);
    const r3 = await (await b()).patch(`/api/groups/${g}/agent-config`, { agentGroupConfig: { updatePolicy: 'auto' } });
    assert.equal(r3.status, 200, r3.text);
    assert.equal(await lv(2, inG.uuid), SERVED, 'effective at the next push (cache invalidated)');
    // Group policy stays platform-admin only.
    assert.equal((await (await h.as('member_b')).patch(`/api/groups/${g}/agent-config`, { agentGroupConfig: { updatePolicy: 'off' } })).status, 403);
  });

  lotIt('C17', '31.16 global policy: platform admin, from Default only', async () => {
    const readGlobal = async () => {
      const r = await h.db('app_config').where({ key: 'agent_global_config' }).first('value') as { value: string } | undefined;
      return r?.value ? (JSON.parse(r.value) as Record<string, unknown>).updatePolicy : undefined;
    };
    const godAdmin = await h.adminIn(1);
    assert.equal((await godAdmin.patch('/api/admin/config/agent-global', { updatePolicy: 'off' })).status, 200);
    assert.equal(await readGlobal(), 'off');
    const inB = await b();
    assert.equal((await inB.patch('/api/admin/config/agent-global', { updatePolicy: 'auto' })).status, 403);
    assert.equal(await readGlobal(), 'off');
    assert.equal((await (await h.as('default_member')).patch('/api/admin/config/agent-global', { updatePolicy: 'auto' })).status, 403);
    assert.equal((await godAdmin.patch('/api/admin/config/agent-global', { updatePolicy: 'bogus' })).status, 400);
    const stale = await godAdmin.patch('/api/admin/config/agent-global', { updatePolicy: 'auto' }, { headers: { 'X-Obliguard-Tenant': '2' } });
    assert.equal(stale.status, 409);
    assert.equal(await readGlobal(), 'off');
    const other = await inB.patch('/api/admin/config/agent-global', { checkIntervalSeconds: 30 });
    assert.equal(other.status, 200, 'the other global agent defaults keep no tenant condition');
    assert.equal((await godAdmin.patch('/api/admin/config/agent-global', { updatePolicy: null })).status, 200);
    assert.equal(await readGlobal(), null);
  });

  // ── reads ──────────────────────────────────────────────────────────────────

  lotIt('C17', '31.17 version distribution: tenant-scoped, god view from Default, MikroTik excluded', async () => {
    await createDevice(h.db, { tenantId: 2, keyId: 2, deviceType: 'mikrotik', version: '7.0.0' });
    const expected = async (tenantId: number | null) => {
      const q = h.db('agent_devices').where({ status: 'approved', device_type: 'agent' });
      if (tenantId !== null) q.where({ tenant_id: tenantId });
      return q.select('agent_version', 'update_policy') as Promise<Array<{ agent_version: string | null }>>;
    };
    const rb = await (await h.as('member_b')).get('/api/agent/devices/versions');
    assert.equal(rb.status, 200);
    const eb = await expected(2);
    assert.equal(rb.json.data.total, eb.length);
    assert.equal(rb.json.data.latestVersion, SERVED);
    assert.equal(rb.json.data.globalPolicy, 'manual');
    assert.equal(rb.json.data.globalPolicyIsDefault, true);
    assert.ok(!rb.json.data.versions.some((v: { version: string }) => v.version === '7.0.0'));
    const d = rb.json.data;
    assert.equal(d.upToDate + d.outdated + d.unknown, d.total);
    assert.equal(d.policies.auto + d.policies.manual + d.policies.off, d.total);
    const counts = d.versions.map((v: { count: number }) => v.count);
    assert.deepEqual(counts, [...counts].sort((x: number, y: number) => y - x));
    assert.ok(d.versions.length <= 10);

    const rd = await (await h.as('default_member')).get('/api/agent/devices/versions');
    assert.equal(rd.status, 200);
    assert.equal(rd.json.data.total, (await expected(null)).length);
    assert.ok(rd.json.data.versions.some((v: { version: string }) => v.version === '0.9.0'));
  });

  // ── validation, allow-list, public version ────────────────────────────────

  lotIt('C17', '31.18 validation', async () => {
    const admin = await b();
    const d = await newB({ groupId: G.B });
    assert.equal((await admin.patch(`/api/agent/devices/${d.id}`, { updatePolicy: 'yes' })).status, 400);
    assert.equal((await row(d.id)).update_policy, null);
    assert.equal((await admin.patch(`/api/agent/devices/${d.id}`, { updatePolicy: 'off' })).status, 200);
    assert.equal((await row(d.id)).update_policy, 'off');
    await setGroupDb(G.B, 'auto');
    const r = await admin.patch(`/api/agent/devices/${d.id}`, { updatePolicy: null });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.resolvedUpdatePolicy, 'auto');
    assert.equal(r.json.data.updatePolicySource, 'group');

    const g = await createGroup(h.db, { tenantId: 2 });
    assert.equal((await admin.patch(`/api/groups/${g}/agent-config`, { agentGroupConfig: 'x' })).status, 400);
    assert.equal((await admin.patch(`/api/groups/${g}/agent-config`, { agentGroupConfig: { updatePolicy: 'bogus' } })).status, 400);
    assert.equal((await admin.patch(`/api/groups/${g}/agent-config`, { agentGroupConfig: { evil: 1, maxMissedPushes: 3 } })).status, 200);
    const cfg = (await h.db('monitor_groups').where({ id: g }).first()).agent_group_config as Record<string, unknown>;
    assert.equal(cfg.maxMissedPushes, 3);
    assert.equal('evil' in cfg, false);

    assert.equal((await admin.post('/api/agent/devices/bulk-request-update', { deviceIds: '1' })).status, 400);
    await assert.rejects(async () => { await h.db.raw("UPDATE agent_devices SET update_policy = 'bogus' WHERE id = ?", [d.id]); });
  });

  lotIt('C17', '31.19 command allow-list', async () => {
    const admin = await b();
    const d = await newB();
    const r1 = await admin.post(`/api/agent/devices/${d.id}/command`, { command: 'reboot' });
    assert.equal(r1.status, 400);
    assert.equal((await row(d.id)).pending_command, null);
    const r2 = await admin.post(`/api/agent/devices/${d.id}/command`, { command: 'update' });
    assert.equal(r2.status, 200, r2.text);
    const rr = await row(d.id);
    assert.equal(rr.update_requested_version, SERVED);
    assert.equal(rr.pending_command, null);
    const r3 = await admin.post('/api/agent/devices/bulk-command', { deviceIds: [d.id], command: 'update' });
    assert.equal(r3.status, 200);
    assert.equal(typeof r3.json.data.requested, 'number');
    assert.ok(r3.json.data.skipped && typeof r3.json.data.skipped.notFound === 'number');
    assert.equal((await admin.post('/api/agent/devices/bulk-command', { deviceIds: [d.id], command: 'reboot' })).status, 400);
    const u = await newB();
    assert.equal((await admin.post(`/api/agent/devices/${u.id}/command`, { command: 'uninstall' })).status, 200);
    assert.equal((await row(u.id)).pending_command, 'uninstall');

    const unhandledBefore = h.unhandled.length;
    const original = agentService.requestUpdate;
    agentService.requestUpdate = async () => { throw new Error('stub failure'); };
    try {
      const r = await admin.post('/api/agent/devices/bulk-request-update', { deviceIds: [d.id] });
      assert.equal(r.status, 500);
      assert.equal(r.json?.success, false);
      const r4 = await admin.post(`/api/agent/devices/${d.id}/command`, { command: 'update' });
      assert.equal(r4.status, 500);
    } finally {
      agentService.requestUpdate = original;
    }
    assert.equal(h.unhandled.length, unhandledBefore);
  });

  lotIt('C17', '31.20 startup check neutralised: anonymous /api/agent/version is empty', async () => {
    const anon = await h.anon().get('/api/agent/version');
    assert.equal(anon.status, 200);
    assert.deepEqual(anon.json, { version: '' });
    assert.match(String(anon.headers['cache-control']), /no-store/);
    const logged = await (await h.as('member_b')).get('/api/agent/version');
    assert.equal(logged.json?.version, SERVED);
  });

  // Destructive: runs last.
  lotIt('C17', '31.21 migration 027 down then up', async () => {
    const mig = await import('../../src/db/migrations/027_agent_update_policy');
    await mig.down(h.db);
    for (const col of ['update_policy', 'update_requested_at', 'update_requested_version', 'update_requested_by']) {
      assert.equal(await h.db.schema.hasColumn('agent_devices', col), false, col);
    }
    await mig.up(h.db);
    await mig.up(h.db); // idempotent
    for (const col of ['update_policy', 'update_requested_at', 'update_requested_version', 'update_requested_by']) {
      assert.equal(await h.db.schema.hasColumn('agent_devices', col), true, col);
    }
    const c = await h.db.raw("SELECT 1 FROM pg_constraint WHERE conname = 'agent_devices_update_policy_check'");
    assert.equal(c.rows.length, 1);
  });
});
