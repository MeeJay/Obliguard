/**
 * 94 — W13-1 IPS settings cascade (ADMIN-FEATURES-11 / UI-PAGES-FLEET-4):
 * one tenant-scoped settings model resolved by the server over
 * global -> tenant -> group chain -> agent, with the source of each value
 * (Obliance settings.service pattern), replacing the dead Obliview monitor
 * keys and the bespoke agent-config cascade.
 *
 *   94.1 nearest level wins: tenant beats global, group beats tenant (nearest
 *        group of the chain), agent beats group; the source is reported;
 *   94.2 a tenant-level write of tenant 2 does not reach tenant 3;
 *   94.3 the hub's offline grace (and its persisted sweep) uses the resolved
 *        checkIntervalSeconds x maxMissedPushes;
 *   94.4 access: global = platform from Default, tenant = 'settings' on the
 *        own tenant, group / agent = groups.manage / agents.manage on own
 *        rows; validation (bounds, levels, unknown keys);
 *   94.5 compat endpoints (agent-global, group agent-config, device PATCH)
 *        write the cascade and keep the legacy storage in sync;
 *   94.6 evaluateOnly is absolute from any group; notification types resolve
 *        per field; updatePolicy is display-only (C17 resolver, owner
 *        directive);
 *   94.7 Windows agents get firewallBackend on the config frame (HTTP push
 *        and WS), other platforms never;
 *   94.8 migration 041: monitor keys gone, one global row per key, the
 *        settings routes no longer accept the /monitor scope.
 */
import { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, FakeWs, waitFor } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { D, G } from '../fixtures';
import { createUser, createGroup, createDevice, createKey } from '../seed';
import { agentConfigService } from '../../src/services/agentConfig.service';
import { obliguardHub } from '../../src/services/obliguardHub.service';
import { agentService } from '../../src/services/agent.service';

const CASCADE_KEYS = ['checkIntervalSeconds', 'maxMissedPushes', 'autoBanEnabled', 'windowsFirewallBackend', 'notificationTypes'];

describe('94 IPS settings cascade (W13-1)', () => {
  let h: Harness;
  const sockets: FakeWs[] = [];
  before(async () => { h = await startHarness(); });
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close(1000);
    await h.db('settings').whereIn('key', CASCADE_KEYS).del();
    await h.db('monitor_groups').whereIn('id', [G.B]).update({ evaluate_only: false, agent_group_config: null });
    await h.db('agent_devices').whereIn('id', [D.B.id]).update({
      evaluate_only: false, agent_max_missed_pushes: null, override_group_settings: false, notification_types: null, check_interval_seconds: 60,
    });
    await h.db('app_config').where({ key: 'agent_global_config' }).del();
    agentConfigService.invalidate();
  });
  after(async () => { await h.close(); });

  const tenantAdmin = async (tenant: number) => h.login((await createUser(h.db, { tenants: [tenant], tenantRole: 'admin' })).username);

  lotIt('W13-1', '94.1 tenant beats global, group beats tenant, agent beats group; source reported', async () => {
    const platform = await h.adminIn(1);
    const b = await tenantAdmin(2);
    // A sub-group of G.B: the nearest group of the chain wins.
    const sub = await h.db('monitor_groups').insert({ name: 'g94-sub', slug: `g94-sub-${Date.now()}`, kind: 'agent', tenant_id: 2, parent_id: G.B })
      .returning('id').then((r: Array<{ id: number }>) => r[0].id);
    await h.db('group_closure').insert([
      { ancestor_id: sub, descendant_id: sub, depth: 0 },
      { ancestor_id: G.B, descendant_id: sub, depth: 1 },
    ]);
    const key = await createKey(h.db, 2);
    const dev = await createDevice(h.db, { tenantId: 2, keyId: key.id, groupId: sub });
    agentConfigService.invalidate();

    const resolved = async () => (await agentConfigService.resolveForDeviceId(dev.id))!;
    let r = await resolved();
    assert.equal(r.maxMissedPushes, 2);
    assert.equal(r.sources.maxMissedPushes?.source, 'default');

    assert.equal((await platform.put('/api/settings/global/0', { key: 'maxMissedPushes', value: 5 })).status, 200);
    r = await resolved();
    assert.equal(r.maxMissedPushes, 5);
    assert.equal(r.sources.maxMissedPushes?.source, 'global');

    const t = await b.put('/api/settings/tenant/2', { key: 'maxMissedPushes', value: 6 });
    assert.equal(t.status, 200, t.text);
    assert.equal(t.json.data.effective.maxMissedPushes.value, 6);
    assert.equal(t.json.data.resolved.maxMissedPushes.source, 'global', 'the tenant inherits from global');
    r = await resolved();
    assert.equal(r.maxMissedPushes, 6);
    assert.deepEqual([r.sources.maxMissedPushes?.source, r.sources.maxMissedPushes?.sourceId], ['tenant', 2]);

    assert.equal((await b.put(`/api/settings/group/${G.B}`, { key: 'maxMissedPushes', value: 7 })).status, 200);
    r = await resolved();
    assert.deepEqual([r.maxMissedPushes, r.sources.maxMissedPushes?.source, r.sources.maxMissedPushes?.sourceId], [7, 'group', G.B]);
    assert.equal((await b.put(`/api/settings/group/${sub}`, { key: 'maxMissedPushes', value: 8 })).status, 200);
    r = await resolved();
    assert.deepEqual([r.maxMissedPushes, r.sources.maxMissedPushes?.sourceId, r.sources.maxMissedPushes?.sourceName], [8, sub, 'g94-sub']);

    const a = await b.put(`/api/settings/agent/${dev.id}`, { key: 'maxMissedPushes', value: 9 });
    assert.equal(a.status, 200, a.text);
    assert.deepEqual([a.json.data.resolved.maxMissedPushes.value, a.json.data.resolved.maxMissedPushes.source], [8, 'group']);
    assert.deepEqual([a.json.data.effective.maxMissedPushes.value, a.json.data.effective.maxMissedPushes.source], [9, 'agent']);
    assert.equal(a.json.data.overrides.maxMissedPushes, 9);

    // The device payload follows the cascade; a reset falls back to the next level.
    const devRead = await b.get(`/api/agent/devices/${dev.id}`);
    assert.equal(devRead.status, 200, devRead.text);
    assert.equal(devRead.json.data.resolvedSettings.maxMissedPushes, 9);
    assert.equal((await b.del(`/api/settings/agent/${dev.id}/maxMissedPushes`)).status, 200);
    assert.equal((await resolved()).maxMissedPushes, 8);

    // Group view: what the sub-group inherits comes from its parent.
    const gv = await b.get(`/api/settings/group/${sub}/resolved`);
    assert.equal(gv.status, 200, gv.text);
    assert.deepEqual([gv.json.data.resolved.maxMissedPushes.value, gv.json.data.resolved.maxMissedPushes.sourceId], [7, G.B]);
    assert.equal(gv.json.data.overrides.maxMissedPushes, 8);
    assert.equal(gv.json.data.tenantId, 2);
  });

  lotIt('W13-1', '94.2 a tenant-level write of tenant 2 does not reach tenant 3', async () => {
    const b = await tenantAdmin(2);
    assert.equal((await b.put('/api/settings/tenant/2', { key: 'checkIntervalSeconds', value: 30 })).status, 200);
    const row = await h.db('settings').where({ scope: 'tenant', scope_id: 2, key: 'checkIntervalSeconds' }).first();
    assert.equal(row.tenant_id, 2, 'the row is owned by its tenant (not Default)');
    assert.equal((await agentConfigService.resolveForDeviceId(D.B.id))!.checkIntervalSeconds, 30);
    const c = (await agentConfigService.resolveForDeviceId(D.C.id))!;
    assert.equal(c.checkIntervalSeconds, 60);
    assert.equal(c.sources.checkIntervalSeconds?.source, 'default');
    // Tenant 3 reads its own (empty) level, not tenant 2's.
    const c3 = await (await tenantAdmin(3)).get('/api/settings/tenant/resolved');
    assert.equal(c3.status, 200, c3.text);
    assert.equal(c3.json.data.scopeId, 3);
    assert.equal(c3.json.data.overrides.checkIntervalSeconds, undefined);
    assert.equal(c3.json.data.effective.checkIntervalSeconds.value, 60);
    // Tenant 2 cannot write tenant 3's level (invisible) nor a tenant-3 group.
    assert.equal((await b.put('/api/settings/tenant/3', { key: 'checkIntervalSeconds', value: 20 })).status, 404);
    assert.equal((await b.put(`/api/settings/group/${G.C}`, { key: 'checkIntervalSeconds', value: 20 })).status, 404);
    assert.equal((await b.put(`/api/settings/agent/${D.C.id}`, { key: 'checkIntervalSeconds', value: 20 })).status, 404);
    assert.equal(await h.db('settings').whereIn('scope_id', [3, G.C, D.C.id]).whereNot({ scope: 'global' }).where({ key: 'checkIntervalSeconds' }).first(), undefined);
  });

  lotIt('W13-1', '94.3 the hub offline grace uses the resolved value', async () => {
    const hub = obliguardHub as unknown as { _offlineGraceMs(id: number): Promise<number> };
    assert.equal(await hub._offlineGraceMs(D.B.id), 60 * 2 * 1000, 'defaults');
    const b = await tenantAdmin(2);
    assert.equal((await b.put('/api/settings/tenant/2/bulk', {
      overrides: [{ key: 'checkIntervalSeconds', value: 30 }, { key: 'maxMissedPushes', value: 3 }],
    })).status, 200);
    assert.equal(await hub._offlineGraceMs(D.B.id), 30 * 3 * 1000, 'tenant level');
    assert.equal((await b.put(`/api/settings/agent/${D.B.id}`, { key: 'maxMissedPushes', value: 5 })).status, 200);
    assert.equal(await hub._offlineGraceMs(D.B.id), 30 * 5 * 1000, 'agent level');
    assert.equal(await hub._offlineGraceMs(D.C.id), 60 * 2 * 1000, 'other tenant untouched');
    // Unknown device: the hub default (2 min).
    assert.equal(await hub._offlineGraceMs(999999), 120_000);
  });

  lotIt('W13-1', '94.4 access per level and validation', async () => {
    const platformB = await h.adminIn(2);
    const platform = await h.adminIn(1);
    const b = await tenantAdmin(2);
    const member = await h.as('member_b');
    // Global: platform admin from the Default tenant.
    assert.equal((await b.put('/api/settings/global/0', { key: 'checkIntervalSeconds', value: 30 })).status, 403);
    assert.equal((await platformB.put('/api/settings/global/0', { key: 'checkIntervalSeconds', value: 30 })).status, 403);
    assert.equal((await b.get('/api/settings/global/resolved')).status, 403);
    const g = await platform.put('/api/settings/global/0', { key: 'checkIntervalSeconds', value: 30 });
    assert.equal(g.status, 200, g.text);
    const grow = await h.db('settings').where({ scope: 'global', key: 'checkIntervalSeconds' });
    assert.equal(grow.length, 1);
    assert.equal(grow[0].tenant_id, 1);
    assert.equal((await platform.put('/api/settings/global/0', { key: 'checkIntervalSeconds', value: 40 })).status, 200);
    assert.equal((await h.db('settings').where({ scope: 'global', key: 'checkIntervalSeconds' })).length, 1, 'one global row per key (upsert)');
    // Tenant level: the 'settings' capability (a 'user' member lacks it).
    assert.equal((await member.put('/api/settings/tenant/2', { key: 'maxMissedPushes', value: 3 })).status, 403);
    assert.equal((await member.get('/api/settings/tenant/resolved')).status, 200, 'members read the effective settings');
    // Platform admin on Default reads another tenant's group (god view) but writes nothing there.
    assert.equal((await platform.get(`/api/settings/group/${G.B}/resolved`)).status, 200);
    assert.equal((await platform.put(`/api/settings/group/${G.B}`, { key: 'maxMissedPushes', value: 3 })).status, 403);
    // Agent level: agents.manage (held by 'user') on an own agent.
    const ok = await member.put(`/api/settings/agent/${D.B.id}`, { key: 'maxMissedPushes', value: 4 });
    assert.equal(ok.status, 200, ok.text);
    const viewer = await createUser(h.db, { tenants: [2], tenantRole: 'viewer' });
    const vc = await h.login(viewer.username);
    assert.equal((await vc.put(`/api/settings/agent/${D.B.id}`, { key: 'maxMissedPushes', value: 4 })).status, 403);
    assert.equal((await vc.get(`/api/settings/agent/${D.B.id}/resolved`)).status, 200);
    // Group reads follow the team scope (as GET /groups/:id): no grant, no view.
    const loner = await h.login((await createUser(h.db, { tenants: [2], tenantRole: 'user' })).username);
    assert.equal((await loner.get(`/api/groups/${G.B}`)).status, 403, 'precondition: no team grant on the group');
    assert.equal((await loner.get(`/api/settings/group/${G.B}/resolved`)).status, 403);
    // Validation.
    const bad = async (path: string, body: unknown) => (await b.put(path, body)).status;
    assert.equal(await bad('/api/settings/tenant/2', { key: 'checkIntervalSeconds', value: 5 }), 400, 'below min');
    assert.equal(await bad('/api/settings/tenant/2', { key: 'maxMissedPushes', value: 21 }), 400, 'above max');
    assert.equal(await bad('/api/settings/tenant/2', { key: 'maxMissedPushes', value: '3' }), 400, 'not a number');
    assert.equal(await bad('/api/settings/tenant/2', { key: 'check_interval', value: 30 }), 400, 'monitor key gone');
    assert.equal(await bad('/api/settings/tenant/2', { key: 'evaluateOnly', value: true }), 400, 'evaluateOnly: group / agent only');
    assert.equal(await bad('/api/settings/tenant/2', { key: 'updatePolicy', value: 'auto' }), 400, 'updatePolicy: own controls');
    assert.equal(await bad('/api/settings/tenant/2', { key: 'windowsFirewallBackend', value: 'iptables' }), 400);
    assert.equal(await bad('/api/settings/tenant/2', { key: 'notificationTypes', value: { down: 'yes' } }), 400);
    assert.equal(await bad('/api/settings/tenant/2/bulk', { overrides: [{ key: 'maxMissedPushes', value: 3 }, { key: 'maxMissedPushes', value: 99 }] }), 400);
    assert.equal(await h.db('settings').where({ scope: 'tenant', scope_id: 2, key: 'maxMissedPushes' }).first(), undefined, 'a refused bulk writes nothing');
    // The Obliview scopes are gone.
    assert.equal((await platform.put('/api/settings/monitor/1', { key: 'checkIntervalSeconds', value: 30 })).status, 404);
    assert.equal((await platform.get('/api/settings/monitor/1/resolved')).status, 404);
  });

  lotIt('W13-1', '94.5 compat endpoints write the cascade and keep the legacy storage in sync', async () => {
    const platform = await h.adminIn(1);
    const b = await tenantAdmin(2);
    // Global defaults (agent-global).
    const glob = await platform.patch('/api/admin/config/agent-global', { maxMissedPushes: 4, checkIntervalSeconds: 45 });
    assert.equal(glob.status, 200, glob.text);
    assert.equal((await h.db('settings').where({ scope: 'global', key: 'maxMissedPushes' }).first()).value, 4);
    assert.equal((await platform.patch('/api/admin/config/agent-global', { maxMissedPushes: 0 })).status, 400);
    // Group agent-config (pushIntervalSeconds = checkIntervalSeconds).
    const grp = await b.patch(`/api/groups/${G.B}/agent-config`, { agentGroupConfig: { pushIntervalSeconds: 90 } });
    assert.equal(grp.status, 200, grp.text);
    assert.equal((await h.db('settings').where({ scope: 'group', scope_id: G.B, key: 'checkIntervalSeconds' }).first()).value, 90);
    const cfg = (await h.db('monitor_groups').where({ id: G.B }).first()).agent_group_config;
    assert.equal((typeof cfg === 'string' ? JSON.parse(cfg) : cfg).pushIntervalSeconds, 90, 'legacy column mirrored');
    let r = (await agentConfigService.resolveForDeviceId(D.B.id))!;
    assert.deepEqual([r.checkIntervalSeconds, r.maxMissedPushes], [90, 4]);
    // The new API mirrors into the legacy column too.
    assert.equal((await b.put(`/api/settings/group/${G.B}`, { key: 'maxMissedPushes', value: 3 })).status, 200);
    const cfg2 = (await h.db('monitor_groups').where({ id: G.B }).first()).agent_group_config;
    assert.equal((typeof cfg2 === 'string' ? JSON.parse(cfg2) : cfg2).maxMissedPushes, 3);
    // Device PATCH: override switch + interval, missed pushes, notification types.
    const dev = await b.patch(`/api/agent/devices/${D.B.id}`, { overrideGroupSettings: true, checkIntervalSeconds: 20, maxMissedPushes: 6 });
    assert.equal(dev.status, 200, dev.text);
    assert.deepEqual([dev.json.data.resolvedSettings.checkIntervalSeconds, dev.json.data.resolvedSettings.maxMissedPushes], [20, 6]);
    assert.equal((await h.db('settings').where({ scope: 'agent', scope_id: D.B.id, key: 'checkIntervalSeconds' }).first()).value, 20);
    assert.equal((await b.patch(`/api/agent/devices/${D.B.id}`, { maxMissedPushes: 50 })).status, 400);
    const nt = await b.patch(`/api/agent/devices/${D.B.id}`, { notificationTypes: { global: null, down: false, up: null, threat: null, attack: null } });
    assert.equal(nt.status, 200, nt.text);
    assert.deepEqual((await h.db('settings').where({ scope: 'agent', scope_id: D.B.id, key: 'notificationTypes' }).first()).value, { down: false });
    const off = await b.patch(`/api/agent/devices/${D.B.id}`, { overrideGroupSettings: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.data.resolvedSettings.checkIntervalSeconds, 90, 'back to the group value');
    assert.equal(await h.db('settings').where({ scope: 'agent', scope_id: D.B.id, key: 'checkIntervalSeconds' }).first(), undefined);
    // Agent deletion drops its rows.
    const key = await createKey(h.db, 2);
    const tmp = await createDevice(h.db, { tenantId: 2, keyId: key.id });
    assert.equal((await b.put(`/api/settings/agent/${tmp.id}`, { key: 'maxMissedPushes', value: 3 })).status, 200);
    assert.equal(await agentService.deleteDevice(tmp.id, 2), true);
    assert.equal(await h.db('settings').where({ scope: 'agent', scope_id: tmp.id }).first(), undefined);
    r = (await agentConfigService.resolveForDeviceId(D.B.id))!;
    assert.equal(r.notificationTypes.down, false);
  });

  lotIt('W13-1', '94.6 evaluateOnly absolute, notification types per field, updatePolicy display-only', async () => {
    const b = await tenantAdmin(2);
    // evaluateOnly at the group: every agent of the chain, whatever its own value.
    assert.equal((await b.put(`/api/settings/group/${G.B}`, { key: 'evaluateOnly', value: true })).status, 200);
    assert.equal((await h.db('monitor_groups').where({ id: G.B }).first()).evaluate_only, true, 'column-backed (ban engine)');
    const r = (await agentConfigService.resolveForDeviceId(D.B.id))!;
    assert.deepEqual([r.evaluateOnly, r.sources.evaluateOnly?.source, r.sources.evaluateOnly?.sourceId], [true, 'group', G.B]);
    const dv = await b.get(`/api/agent/devices/${D.B.id}`);
    assert.equal(dv.json.data.evaluateOnly, true);
    assert.equal((await b.del(`/api/settings/group/${G.B}/evaluateOnly`)).status, 200);
    assert.equal((await agentConfigService.resolveForDeviceId(D.B.id))!.evaluateOnly, false);

    // Notification types: each field from its nearest level.
    assert.equal((await b.put('/api/settings/tenant/2', { key: 'notificationTypes', value: { down: false, up: false } })).status, 200);
    assert.equal((await b.put(`/api/settings/agent/${D.B.id}`, { key: 'notificationTypes', value: { up: true } })).status, 200);
    const nt = (await agentConfigService.resolveForDeviceId(D.B.id))!;
    assert.deepEqual(nt.notificationTypes, { global: true, down: false, up: true, threat: true, attack: true });
    assert.equal(nt.sources.notificationTypes?.fields?.down?.source, 'tenant');
    assert.equal(nt.sources.notificationTypes?.fields?.up?.source, 'agent');
    assert.equal(nt.sources.notificationTypes?.fields?.threat?.source, 'default');
    assert.deepEqual(await agentConfigService.resolveNotificationTypesForDevice(D.B.id), nt.notificationTypes);

    // updatePolicy: shown with the C17 source, never written here.
    await h.db('agent_devices').where({ id: D.B.id }).update({ update_policy: 'manual' });
    const view = await b.get(`/api/settings/agent/${D.B.id}/resolved`);
    assert.equal(view.status, 200, view.text);
    assert.deepEqual([view.json.data.effective.updatePolicy.value, view.json.data.effective.updatePolicy.source], ['manual', 'agent']);
    assert.equal((await b.put(`/api/settings/agent/${D.B.id}`, { key: 'updatePolicy', value: 'off' })).status, 400);
    assert.equal((await h.db('agent_devices').where({ id: D.B.id }).first()).update_policy, 'manual');
    assert.equal(await h.db('settings').where({ key: 'updatePolicy' }).first(), undefined);
    await h.db('agent_devices').where({ id: D.B.id }).update({ update_policy: null });
  });

  lotIt('W13-1', '94.7 firewallBackend on the config frame of Windows agents only', async () => {
    const b = await tenantAdmin(2);
    const win = { osInfo: { platform: 'windows', distro: 'Windows Server', release: '2025', arch: 'amd64' } };
    let res = await h.push(2, D.B.uuid, win);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.firewallBackend, 'auto', 'default, sent so a switch back applies');
    assert.equal((await h.push(2, D.B.uuid)).json.firewallBackend, undefined, 'never to Linux agents');
    assert.equal((await b.put(`/api/settings/group/${G.B}`, { key: 'windowsFirewallBackend', value: 'netsh' })).status, 200);
    res = await h.push(2, D.B.uuid, win);
    assert.equal(res.json.firewallBackend, 'netsh');

    // WS channel: the config frame carries it.
    const ws = new FakeWs();
    sockets.push(ws);
    await obliguardHub.register(D.B.uuid, 2, 2, '127.0.0.1', ws as any);
    ws.receive({
      type: 'heartbeat', hostname: D.B.hostname, agentVersion: '1.0.0', services: [], firewallBanned: [],
      firewallName: 'verify', lanIPs: [], ...win,
    });
    const frame = await waitFor(() => ws.sent.find((m) => m.type === 'config'));
    assert.equal(frame.firewallBackend, 'netsh');
    await h.push(2, D.B.uuid); // back to linux os_info for the other suites' fixtures
  });

  lotIt('W13-1', '94.8 migration 041: monitor keys gone, one indexed global row per key', async () => {
    const idx = await h.db.raw("SELECT indexdef FROM pg_indexes WHERE tablename = 'settings' AND indexname = 'settings_global_key_uq'") as { rows: Array<{ indexdef: string }> };
    assert.equal(idx.rows.length, 1);
    assert.match(idx.rows[0].indexdef, /WHERE \(scope_id IS NULL\)/);
    const legacy = await h.db('settings').whereIn('key', ['check_interval', 'retry_interval', 'max_retries', 'timeout', 'heartbeat_retention_days']).first();
    assert.equal(legacy, undefined);
    await h.db('settings').insert({ scope: 'global', scope_id: null, key: 'maxMissedPushes', value: JSON.stringify(3), tenant_id: 1 });
    await assert.rejects(async () => { await h.db('settings').insert({ scope: 'global', scope_id: null, key: 'maxMissedPushes', value: JSON.stringify(4), tenant_id: 1 }); });
    // A new group appears in the resolver chain at once (cache dropped on create).
    const g = await createGroup(h.db, { tenantId: 2 });
    agentConfigService.invalidate();
    const view = await agentConfigService.getScopeView('group', g, 2);
    assert.equal(view.effective.maxMissedPushes?.value, 3);
    assert.equal(view.effective.maxMissedPushes?.source, 'global');
  });

  lotIt('W13-1', '94.9 migration 041 copies the legacy storage into clamped, tenant-owned rows (re-run safe)', async () => {
    const mig = await import('../../src/db/migrations/041_settings_ips_keys');
    // Legacy values, some out of range (one beyond int4: must not abort the migration).
    await h.db('app_config').insert({ key: 'agent_global_config', value: JSON.stringify({ checkIntervalSeconds: 1e12, maxMissedPushes: 3, notificationTypes: { down: false, up: 'x' } }) })
      .onConflict('key').merge();
    await h.db('monitor_groups').where({ id: G.B }).update({
      agent_group_config: JSON.stringify({ pushIntervalSeconds: 5, maxMissedPushes: 99, notificationTypes: null, updatePolicy: 'auto' }),
    });
    await h.db('agent_devices').where({ id: D.B.id }).update({
      override_group_settings: true, check_interval_seconds: 30, agent_max_missed_pushes: 4,
      notification_types: JSON.stringify({ global: null, down: null, up: true, threat: null, attack: null }),
    });
    // A group row stamped with the wrong tenant (the old default) and a monitor-scope leftover.
    await h.db('settings').insert({ scope: 'group', scope_id: G.B, key: 'autoBanEnabled', value: JSON.stringify(false), tenant_id: 1 });
    await h.db('settings').insert({ scope: 'monitor', scope_id: 1, key: 'autoBanEnabled', value: JSON.stringify(true), tenant_id: 1 });
    try {
      await mig.up(h.db);
      await mig.up(h.db); // idempotent
      const val = async (scope: string, scopeId: number | null, key: string) => {
        const rows = await h.db('settings').where({ scope, key }).andWhere((q) => {
          if (scopeId === null) q.whereNull('scope_id'); else q.where({ scope_id: scopeId });
        });
        assert.ok(rows.length <= 1, `one ${scope} row for ${key}`);
        return rows[0] as { value: unknown; tenant_id: number } | undefined;
      };
      assert.equal((await val('global', null, 'checkIntervalSeconds'))?.value, 86400, 'clamped to the max');
      assert.equal((await val('global', null, 'maxMissedPushes'))?.value, 3);
      assert.deepEqual((await val('global', null, 'notificationTypes'))?.value, { down: false }, 'boolean fields only');
      assert.equal((await val('group', G.B, 'checkIntervalSeconds'))?.value, 10, 'pushIntervalSeconds clamped to the min');
      assert.equal((await val('group', G.B, 'maxMissedPushes'))?.value, 20);
      assert.equal((await val('group', G.B, 'checkIntervalSeconds'))?.tenant_id, 2);
      assert.equal(await val('group', G.B, 'notificationTypes'), undefined);
      assert.equal((await val('group', G.B, 'autoBanEnabled'))?.tenant_id, 2, 're-stamped to the group tenant');
      const agentCis = await val('agent', D.B.id, 'checkIntervalSeconds');
      assert.deepEqual([agentCis?.value, agentCis?.tenant_id], [30, 2]);
      assert.equal((await val('agent', D.B.id, 'maxMissedPushes'))?.value, 4);
      assert.deepEqual((await val('agent', D.B.id, 'notificationTypes'))?.value, { up: true });
      assert.equal(await h.db('settings').where({ scope: 'monitor' }).first(), undefined, 'monitor scope dropped');
      assert.equal(await h.db('settings').where({ key: 'updatePolicy' }).first(), undefined, 'updatePolicy not migrated (C17)');
      agentConfigService.invalidate();
      const r = (await agentConfigService.resolveForDeviceId(D.B.id))!;
      assert.deepEqual([r.checkIntervalSeconds, r.maxMissedPushes, r.autoBanEnabled], [30, 4, false]);
    } finally {
      await h.db('settings').whereIn('scope', ['monitor']).del();
    }
  });
});
