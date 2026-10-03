/**
 * 52 — Obliview leftovers are gone (W3-4): the monitor / heartbeat stubs of
 * /groups and the Import/Export routes are not served, and the dead
 * heartbeatMonitoring and groupNotifications toggles are ignored when an old
 * client still sends them (accepted, never stored, never returned).
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness, Res } from '../harness';
import { lotIt } from '../lots';
import { G } from '../fixtures';
import { createDevice, createKey } from '../seed';

/**
 * No API route answered: a 2xx JSON body would be a handler. Under
 * NODE_ENV=test an unknown GET falls to the SPA fallback (HTML), any other
 * method to a plain 404.
 */
function assertNotServed(r: Res, what: string): void {
  const isJson = /application\/json/.test(String(r.headers['content-type'] ?? ''));
  assert.ok(!(r.status < 300 && isJson), `${what} is still served: ${r.status} ${r.text.slice(0, 120)}`);
}

describe('52 Obliview leftovers removed (W3-4)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  lotIt('W3-4', '52.1 group monitor / heartbeat stubs are not served', async () => {
    const admin = await h.adminIn(1);
    for (const p of ['monitors', 'heartbeats', 'detail-stats']) {
      assertNotServed(await admin.get(`/api/groups/${G.DEFAULT}/${p}`), `GET /groups/:id/${p}`);
    }
    const clear = await admin.del(`/api/groups/${G.DEFAULT}/heartbeats`);
    assert.equal(clear.status, 404, clear.text.slice(0, 120));
    // /groups/stats is no route of its own any more: it reaches GET /groups/:id.
    const stats = await admin.get('/api/groups/stats');
    assert.ok(stats.status >= 400 && stats.status < 500, `${stats.status} ${stats.text.slice(0, 120)}`);
    // The group itself is still readable.
    assert.equal((await admin.get(`/api/groups/${G.DEFAULT}`)).status, 200);
  });

  lotIt('W3-4', '52.2 Import/Export routes are not mounted', async () => {
    const admin = await h.adminIn(1);
    assertNotServed(await admin.get('/api/admin/export?sections=teams'), 'GET /admin/export');
    const imp = await admin.post('/api/admin/import', { data: { teams: [] }, sections: ['teams'], conflictResolution: 'skip' });
    assert.equal(imp.status, 404, imp.text.slice(0, 120));
  });

  lotIt('W3-4', '52.3 heartbeatMonitoring is ignored on device, bulk, global and group writes', async () => {
    const admin = await h.adminIn(1);
    const key = await createKey(h.db, 1);
    const d = await createDevice(h.db, { tenantId: 1, keyId: key.id });
    const before = await h.db('agent_devices').where({ id: d.id }).first();

    const one = await admin.patch(`/api/agent/devices/${d.id}`, { name: 'w34', heartbeatMonitoring: !before.heartbeat_monitoring });
    assert.equal(one.status, 200, one.text);
    assert.equal(one.json.data.name, 'w34');
    assert.ok(!('heartbeatMonitoring' in one.json.data), 'device payload still carries heartbeatMonitoring');
    assert.ok(!('heartbeatMonitoring' in one.json.data.resolvedSettings), 'resolvedSettings still carries heartbeatMonitoring');

    const bulk = await admin.patch('/api/agent/devices/bulk', { deviceIds: [d.id], heartbeatMonitoring: !before.heartbeat_monitoring });
    assert.equal(bulk.status, 200, bulk.text);
    assert.equal((await h.db('agent_devices').where({ id: d.id }).first()).heartbeat_monitoring, before.heartbeat_monitoring);

    const listed = await admin.get(`/api/agent/devices/${d.id}`);
    assert.equal(listed.status, 200);
    assert.ok(!('heartbeatMonitoring' in listed.json.data));

    // A global value stored by an older version is neither returned nor kept.
    await h.db('app_config')
      .insert({ key: 'agent_global_config', value: JSON.stringify({ checkIntervalSeconds: null, maxMissedPushes: 2, notificationTypes: null, heartbeatMonitoring: true }) })
      .onConflict('key').merge();
    const globRead = await admin.get('/api/admin/config/agent-global');
    assert.equal(globRead.status, 200, globRead.text);
    assert.equal(globRead.json.data.maxMissedPushes, 2);
    assert.ok(!('heartbeatMonitoring' in globRead.json.data), 'GET agent-global still returns a stored heartbeatMonitoring');

    const glob = await admin.patch('/api/admin/config/agent-global', { heartbeatMonitoring: false, maxMissedPushes: 4 });
    assert.equal(glob.status, 200, glob.text);
    assert.equal(glob.json.data.maxMissedPushes, 4);
    assert.ok(!('heartbeatMonitoring' in glob.json.data));
    const stored = await h.db('app_config').where({ key: 'agent_global_config' }).first();
    assert.ok(!('heartbeatMonitoring' in JSON.parse(stored.value)));

    // A value stored by an older version is dropped on the next write.
    await h.db('monitor_groups').where({ id: G.DEFAULT })
      .update({ agent_group_config: JSON.stringify({ heartbeatMonitoring: false, maxMissedPushes: 3 }) });
    const grp = await admin.patch(`/api/groups/${G.DEFAULT}/agent-config`, { agentGroupConfig: { heartbeatMonitoring: true, pushIntervalSeconds: 45 } });
    assert.equal(grp.status, 200, grp.text);
    const cfgRaw = (await h.db('monitor_groups').where({ id: G.DEFAULT }).first()).agent_group_config;
    const cfg = typeof cfgRaw === 'string' ? JSON.parse(cfgRaw) : cfgRaw;
    assert.equal(cfg.pushIntervalSeconds, 45);
    assert.equal(cfg.maxMissedPushes, 3, 'existing group config keys are kept');
    assert.ok(!('heartbeatMonitoring' in (grp.json.data.agentGroupConfig ?? {})), 'group payload still carries heartbeatMonitoring');
    assert.ok(!('heartbeatMonitoring' in cfg), 'group agent config stored heartbeatMonitoring');
  });

  lotIt('W3-4', '52.4 groupNotifications is ignored and new groups are agent groups', async () => {
    const admin = await h.adminIn(1);
    const name = `w34-${Date.now()}`;
    const created = await admin.post('/api/groups', { name, groupNotifications: true, kind: 'monitor' });
    assert.equal(created.status, 201, created.text);
    const id = created.json.data.id as number;
    assert.equal(created.json.data.kind, 'agent');
    assert.ok(!('groupNotifications' in created.json.data));
    let row = await h.db('monitor_groups').where({ id }).first();
    assert.equal(row.group_notifications, false);
    assert.equal(row.kind, 'agent');

    const updated = await admin.put(`/api/groups/${id}`, { groupNotifications: true, description: 'x' });
    assert.equal(updated.status, 200, updated.text);
    assert.ok(!('groupNotifications' in updated.json.data));
    row = await h.db('monitor_groups').where({ id }).first();
    assert.equal(row.group_notifications, false);
    assert.equal(row.description, 'x');

    // A group delete no longer goes through the removed groupNotification service.
    assert.equal((await admin.del(`/api/groups/${id}`)).status, 200);
  });
});
