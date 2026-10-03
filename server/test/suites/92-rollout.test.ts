/**
 * 92 — W12-4 paced fleet rollout (FLEET-AGENT-10), ported from Obliance
 * agentUpdateRollout: a DB-counted window cap on update offers (25 per 60 s,
 * fleet-wide), the "update all outdated" preview, update all and cancel all.
 * The 4-level update policy stays authoritative (owner directive C17): an
 * agent frozen at any level is never offered, update-all included, and the
 * preview lists it separately with the level that froze it.
 *
 * Every test starts from: global policy 'manual', no tenant / group / device
 * policy, no request, no attempt, served version '2.0.0', no build manifest,
 * a frozen update clock, and every pre-existing agent already up to date.
 */
import { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup } from '../seed';
import {
  invalidateAgentUpdatePolicyCache,
  __resetAgentUpdateStateForTest,
  __setServedAgentVersionForTest,
  __setAgentUpdateClockForTest,
  __setAgentManifestForTest,
} from '../../src/services/agent.service';
import { UPDATE_ROLLOUT_MAX_PER_WINDOW, rolloutEstimatedMinutes, rolloutPlatformOf, rolloutWindowHasRoom } from '../../src/utils/agentUpdate';

const SERVED = '2.0.0';

describe('92 paced fleet rollout', () => {
  let h: Harness;
  let t = Date.now();

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

  beforeEach(async () => {
    await setGlobalDb('manual');
    await h.db.raw("UPDATE monitor_groups SET agent_group_config = agent_group_config - 'updatePolicy' WHERE agent_group_config ->> 'updatePolicy' IS NOT NULL");
    // Agents of the fixtures and of earlier tests: up to date, nothing pending.
    await h.db('agent_devices').update({
      agent_version: SERVED, update_policy: null, update_requested_at: null, update_requested_version: null, update_requested_by: null,
    });
    await h.db('agent_update_attempts').del();
    await h.db('tenants').update({ agent_update_policy: null });
    __resetAgentUpdateStateForTest();
    __setServedAgentVersionForTest(SERVED);
    __setAgentManifestForTest(null);
    t = Date.now();
    __setAgentUpdateClockForTest(() => t);
  });

  const newAgent = (tenantId: 2 | 3, o: { groupId?: number | null; platform?: string; arch?: string; policy?: string } = {}) =>
    createDevice(h.db, { tenantId, keyId: tenantId, groupId: o.groupId ?? null, version: '1.0.0' }).then(async (d) => {
      await h.db('agent_devices').where({ id: d.id }).update({
        os_info: JSON.stringify({ platform: o.platform ?? 'linux', distro: 'v', release: '1', arch: o.arch ?? 'amd64' }),
        ...(o.policy ? { update_policy: o.policy } : {}),
      });
      return d;
    });
  const preview = async (tenantId: number) => {
    const r = await (await h.adminIn(tenantId)).get('/api/agent/updates/preview');
    assert.equal(r.status, 200, r.text);
    return r.json.data;
  };
  const updateAll = async (tenantId: number, body: Record<string, unknown> = {}) =>
    (await h.adminIn(tenantId)).post('/api/agent/updates/all', body);
  const cancelAll = async (tenantId: number) =>
    (await h.adminIn(tenantId)).post('/api/agent/updates/cancel-all', {});
  const lv = async (tenantId: 2 | 3, uuid: string) =>
    (await h.push(tenantId, uuid)).json?.latestVersion as string | undefined;
  const offeredIds = async () =>
    (await h.db('agent_update_attempts').whereNotNull('last_offered_at').pluck('device_id') as number[]).map(Number);

  lotIt('W12-4', '92.1 helpers: window room, estimate, platform label', () => {
    assert.equal(UPDATE_ROLLOUT_MAX_PER_WINDOW, 25);
    assert.equal(rolloutWindowHasRoom(24, 0), true);
    assert.equal(rolloutWindowHasRoom(24, 1), false);
    assert.equal(rolloutWindowHasRoom(25, 0), false);
    assert.equal(rolloutEstimatedMinutes(0), 0);
    assert.equal(rolloutEstimatedMinutes(25), 1);
    assert.equal(rolloutEstimatedMinutes(26), 2);
    assert.equal(rolloutPlatformOf({ platform: 'linux', arch: 'x86_64' }), 'linux-amd64');
    assert.equal(rolloutPlatformOf({ platform: 'win32', arch: 'x64' }), 'windows-amd64');
    assert.equal(rolloutPlatformOf(null), 'unknown');
  });

  lotIt('W12-4', '92.2 30 eligible agents: only 25 offered within the window (concurrent heartbeats), the rest in the next one', async () => {
    await setTenantDb(2, 'auto');
    const agents = await Promise.all(Array.from({ length: 30 }, () => newAgent(2)));
    const first = await Promise.all(agents.map((a) => lv(2, a.uuid)));
    assert.equal(first.filter((v) => v === SERVED).length, 25, 'exactly the cap is offered');
    assert.equal((await offeredIds()).length, 25, '25 offers counted');
    // Still the same window: nothing more.
    t += 30_000;
    const again = await Promise.all(agents.map((a) => lv(2, a.uuid)));
    assert.equal(again.filter(Boolean).length, 0, 'window full: no offer');
    // Next window: the 5 that waited are offered; the 25 others keep their 10-min spacing.
    t += 31_000;
    const waited = agents.filter((a, i) => first[i] !== SERVED);
    const next = await Promise.all(agents.map((a) => lv(2, a.uuid)));
    assert.equal(next.filter((v) => v === SERVED).length, 5);
    assert.deepEqual(new Set(await offeredIds()), new Set(agents.map((a) => a.id)), 'every agent offered once');
    for (const a of waited) assert.ok((await offeredIds()).includes(a.id));
  });

  lotIt('W12-4', '92.3 an explicit request is paced too; a frozen agent is never offered, even after update-all', async () => {
    const free = await Promise.all(Array.from({ length: 27 }, () => newAgent(2)));
    const frozen = await newAgent(2, { policy: 'off' });
    const r = await updateAll(2);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.requested, 27, 'every non-frozen outdated agent requested');
    assert.equal((await h.db('agent_devices').where({ id: frozen.id }).first()).update_requested_at, null, 'frozen agent not requested');
    const offers = await Promise.all([...free, frozen].map((a) => lv(2, a.uuid)));
    assert.equal(offers.filter(Boolean).length, 25);
    assert.equal(offers[offers.length - 1], undefined, 'frozen agent not offered');
    t += 61_000;
    assert.equal(await lv(2, frozen.uuid), undefined, 'frozen agent still not offered with room in the window');
    const rest = await Promise.all(free.map((a) => lv(2, a.uuid)));
    assert.equal(rest.filter(Boolean).length, 2);
  });

  lotIt('W12-4', '92.4 preview: counts per tenant / group / platform, frozen agents by level, Default covers every tenant', async () => {
    const g1 = await createGroup(h.db, { tenantId: 2, name: `g1-${t}` });
    const g2 = await createGroup(h.db, { tenantId: 2, name: `g2-${t}` });
    await setGroupDb(g2, 'off');
    const ok1 = await newAgent(2, { groupId: g1 });
    await newAgent(2, { groupId: g1 });
    await newAgent(2, { groupId: g1, platform: 'windows', arch: 'amd64' });
    const fz1 = await newAgent(2, { groupId: g2 });
    await newAgent(2, { groupId: g2 });
    const fz3 = await newAgent(2, { policy: 'off' });
    await newAgent(3);
    await newAgent(3, { platform: 'freebsd' });
    // One of tenant 2 already requested.
    await (await h.adminIn(2)).post(`/api/agent/devices/${ok1.id}/agent-update`);

    let p = await preview(2);
    assert.equal(p.allTenants, false);
    assert.equal(p.scopeTenantId, 2);
    assert.equal(p.latestVersion, SERVED);
    assert.equal(p.outdated, 6);
    assert.equal(p.targets, 3);
    assert.equal(p.alreadyRequested, 1);
    assert.equal(p.toRequest, 2);
    assert.equal(p.pending, 1);
    assert.equal(p.offline, 3);
    assert.deepEqual(p.byGroup.map((g: { groupId: number; targets: number }) => [g.groupId, g.targets]), [[g1, 3]]);
    const pf = Object.fromEntries(p.byPlatform.map((x: { platform: string; targets: number }) => [x.platform, x.targets]));
    assert.deepEqual(pf, { 'linux-amd64': 2, 'windows-amd64': 1 });
    assert.equal(p.frozen.total, 3);
    assert.equal(p.frozen.byLevel.group, 2);
    assert.equal(p.frozen.byLevel.agent, 1);
    assert.equal(p.frozen.truncated, false);
    const fa = p.frozen.agents.find((a: { id: number }) => a.id === fz1.id);
    assert.equal(fa.level, 'group');
    assert.equal(fa.sourceGroupId, g2);
    assert.equal(fa.sourceGroupName, `g2-${t}`);
    assert.equal(p.frozen.agents.find((a: { id: number }) => a.id === fz3.id).level, 'agent');
    assert.deepEqual(p.byTenant.map((x: { tenantId: number }) => x.tenantId), [2]);
    assert.equal(p.rollout.maxPerWindow, 25);
    assert.equal(p.rollout.windowSeconds, 60);
    assert.equal(p.rollout.estimatedMinutes, 1);
    assert.equal(p.progress.waiting, 1);

    // Default: every tenant.
    p = await preview(1);
    assert.equal(p.allTenants, true);
    assert.equal(p.targets, 5);
    const byT = Object.fromEntries(p.byTenant.map((x: { tenantId: number; targets: number; frozen: number }) => [x.tenantId, [x.targets, x.frozen]]));
    assert.deepEqual(byT[2], [3, 3]);
    assert.deepEqual(byT[3], [2, 0]);
    assert.ok(p.byTenant.find((x: { tenantId: number }) => x.tenantId === 3).tenantName);

    // Tenant freeze: listed with level 'tenant' (the highest level that froze it).
    await setTenantDb(3, 'off');
    p = await preview(1);
    assert.equal(p.targets, 3);
    assert.equal(p.frozen.byLevel.tenant, 2);
    // Global kill-switch: everything frozen at 'global', update-all requests nothing.
    await setGlobalDb('off');
    p = await preview(1);
    assert.equal(p.targets, 0);
    assert.equal(p.frozen.total, 8);
    assert.equal(p.frozen.byLevel.global, 8);
    const r = await updateAll(1);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.requested, 0);
  });

  lotIt('W12-4', '92.5 update-all: tenant scope, Default = every tenant except frozen ones; stale scope refused', async () => {
    const b1 = await newAgent(2);
    const b2 = await newAgent(2);
    const c1 = await newAgent(3);
    const c2 = await newAgent(3);
    await h.db('agent_devices').where({ id: c2.id }).update({ update_policy: 'off' });
    invalidateAgentUpdatePolicyCache();

    const stale = await updateAll(2, { scopeTenantId: 3 });
    assert.equal(stale.status, 409);

    let r = await updateAll(2, { scopeTenantId: 2 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.requested, 2);
    assert.deepEqual(r.json.data.byTenant, [{ tenantId: 2, requested: 2 }]);
    assert.equal(r.json.data.preview.alreadyRequested, 2);
    assert.equal(r.json.data.preview.toRequest, 0);
    assert.equal((await h.db('agent_devices').where({ id: c1.id }).first()).update_requested_at, null, 'tenant 3 untouched from tenant 2');
    const audit = await h.db('audit_logs').where({ action: 'agent.update_all_requested' }).orderBy('id', 'desc').first();
    assert.ok(audit, 'update-all is audited');

    r = await updateAll(1);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.requested, 1, 'Default: the tenant 3 agent; tenant 2 ones already requested; the frozen one left out');
    assert.equal((await h.db('agent_devices').where({ id: c2.id }).first()).update_requested_at, null);
    for (const d of [b1, b2, c1]) {
      assert.notEqual((await h.db('agent_devices').where({ id: d.id }).first()).update_requested_at, null);
    }
    // The requests are honoured under 'manual' (paced by the window).
    assert.equal(await lv(2, b1.uuid), SERVED);
    assert.equal(await lv(3, c2.uuid), undefined);
  });

  lotIt('W12-4', '92.6 cancel-all clears the pending requests of the scope; nothing more is offered under manual', async () => {
    const b1 = await newAgent(2);
    const b2 = await newAgent(2);
    const c1 = await newAgent(3);
    assert.equal((await updateAll(1)).json.data.requested, 3);
    // b1 got its offer: its open attempt is closed by the cancel.
    assert.equal(await lv(2, b1.uuid), SERVED);

    let r = await cancelAll(2);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.cancelled, 2);
    assert.equal(r.json.data.autoContinuing, 0);
    for (const d of [b1, b2]) assert.equal((await h.db('agent_devices').where({ id: d.id }).first()).update_requested_at, null);
    assert.notEqual((await h.db('agent_devices').where({ id: c1.id }).first()).update_requested_at, null, 'tenant 3 kept from tenant 2');
    assert.equal((await h.db('agent_update_attempts').where({ device_id: b1.id }).first()).phase, 'cancelled');
    assert.equal((await preview(2)).pending, 0);
    t += 11 * 60_000;
    assert.equal(await lv(2, b1.uuid), undefined, 'manual + no request: not offered');
    assert.equal(await lv(2, b2.uuid), undefined);
    assert.ok(await h.db('audit_logs').where({ action: 'agent.update_all_cancelled' }).first(), 'cancel-all is audited');

    // Default: every tenant. An 'auto' agent keeps being offered (reported).
    await setTenantDb(3, 'auto');
    r = await cancelAll(1);
    assert.equal(r.json.data.cancelled, 1);
    assert.equal(r.json.data.autoContinuing, 1);
    assert.equal((await preview(1)).pending, 0);
  });

  lotIt('W12-4', '92.8 a failed update keeps its per-device budget: update-all does not request it again', async () => {
    const ok = await newAgent(2);
    const bad = await newAgent(2);
    const past = new Date(t - 60 * 60_000);
    await h.db('agent_update_attempts').insert({
      device_id: bad.id, target_version: SERVED, offered_count: 3, last_offered_at: past,
      phase: 'failed', last_error: 'no_progress', finished_at: past, created_at: past, updated_at: past,
    });
    const p = await preview(2);
    assert.equal(p.failed, 1);
    assert.equal(p.targets, 1);
    assert.equal(p.toRequest, 1);
    const r = await updateAll(2);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.requested, 1);
    assert.notEqual((await h.db('agent_devices').where({ id: ok.id }).first()).update_requested_at, null);
    assert.equal((await h.db('agent_devices').where({ id: bad.id }).first()).update_requested_at, null, 'failed agent not requested');
    const a = await h.db('agent_update_attempts').where({ device_id: bad.id, target_version: SERVED }).first();
    assert.equal(a.phase, 'failed');
    assert.equal(Number(a.offered_count), 3, 'offer budget not reset by a bulk action');
    assert.equal(await lv(2, bad.uuid), undefined, 'not offered again');
    // Under 'auto' the failed agent is not counted as continuing either.
    await setTenantDb(2, 'auto');
    const c = await cancelAll(2);
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.data.autoContinuing, 1);
  });

  lotIt('W12-4', '92.7 the three routes need agents.update', async () => {
    const viewer = await h.as('viewer_b');
    assert.equal((await viewer.get('/api/agent/updates/preview')).status, 403);
    assert.equal((await viewer.post('/api/agent/updates/all', {})).status, 403);
    assert.equal((await viewer.post('/api/agent/updates/cancel-all', {})).status, 403);
    assert.equal((await h.anon().get('/api/agent/updates/preview')).status, 401);
  });
});
