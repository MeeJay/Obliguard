// verify-env: NOTIFICATION_ALLOW_PRIVATE_TARGETS=1
/**
 * 62 — W6-2 live-alert and channel producers.
 *
 *   62.1 an agent channel closed past its grace window → ONE open
 *        agent_offline incident + webhook 'down'; the sweep does not
 *        duplicate it; the reconnection resolves it + webhook 'up'
 *   62.2 persisted sweep: an approved agent silent past its window (no
 *        channel) is declared offline; suspended / pending devices never;
 *        its next push resolves the incident + 'up'
 *   62.3 two threat flushes within the cooldown → one notification, with the
 *        real ip / service / count; a flush after the cooldown notifies again
 *   62.4 agent event timestamps are clamped: +1 day → now, -3 days → now-24h
 *        (WS flush and HTTP push)
 *   62.5 >= AUTO_BAN_BURST_THRESHOLD auto-bans of a tenant in a cycle → one
 *        ban_burst incident per tenant per hour; quiet bursts are resolved
 *   62.6 a new pending agent raises agent_pending; approval resolves it
 *   62.7 a failed update raises agent_update_failed; the update succeeding
 *        resolves it
 *   62.8 a failed remote blocklist sync raises blocklist_sync_failed; the
 *        next successful sync resolves it
 *   62.9 a failed MikroTik sync raises mikrotik_sync_failed (per router and
 *        direction); a success of the same direction resolves it
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { startHarness, waitFor, drain, FakeWs } from '../harness';
import type { Harness } from '../harness';
import type { AgentIpEvent } from '@obliview/shared';
import { lotIt } from '../lots';
import { createDevice, createMikrotikDevice, nextIp } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';
import { agentService, clampEventTimestamp } from '../../src/services/agent.service';
import { banEngine, AUTO_BAN_BURST_THRESHOLD } from '../../src/services/ban.service';
import { remoteBlocklistService } from '../../src/services/remoteBlocklist.service';
import { mikrotikBanSync, resolveMikrotikSyncFailure, reportMikrotikSyncFailure } from '../../src/services/mikrotik/mikrotikBanSync.service';

interface Hit { path: string; body: any }

const SVC = 'w62-svc';

describe('62 alert producers (W6-2)', () => {
  let h: Harness;
  let sink: http.Server;
  let sinkUrl = '';
  const hits: Hit[] = [];

  before(async () => {
    h = await startHarness();
    sink = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: any = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        hits.push({ path: req.url ?? '', body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;

    // One global webhook per tenant used below (tenant 3: agents, tenant 2: pending).
    for (const tenantId of [2, 3]) {
      const c = await h.adminIn(tenantId);
      const ch = await c.post('/api/notifications/channels', { name: `w62-${tenantId}`, type: 'webhook', config: { url: `${sinkUrl}/w62-t${tenantId}` } });
      assert.equal(ch.status, 201, ch.text);
      const b = await c.post('/api/notifications/bindings', { channelId: ch.json.data.id, scope: 'global', scopeId: null });
      assert.equal(b.status, 201, b.text);
    }
  });
  after(async () => {
    obliguardHub.offlineGraceMsOverride = null;
    obliguardHub.sweepSince = Date.now();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await h.close();
  });

  /** Webhook deliveries of tenant 3's channel about `deviceName` with `kind`. */
  const hitsFor = (deviceName: string, kind: string) =>
    hits.filter((x) => x.path === '/w62-t3' && x.body?.kind === kind && x.body?.monitorName === deviceName);

  /** An agent event (harness shape) typed for the service calls. */
  // Service without a template: never dropped by the opt-in gate (built-ins are disabled by default).
  const ev = (ip: string, over: Record<string, unknown> = {}): AgentIpEvent =>
    h.event(ip, { service: SVC, ...over }) as unknown as AgentIpEvent;

  const openIncidents = (where: Record<string, unknown>) =>
    h.db('live_alerts').where(where).whereNull('resolved_at');

  lotIt('W6-2', '62.1 channel closed past the grace window: one agent_offline + down; reconnect resolves + up', async () => {
    const dev = await createDevice(h.db, { tenantId: 3, keyId: 3, groupId: 3, hostname: `w62-off-${crypto.randomBytes(3).toString('hex')}` });
    const ws1 = new FakeWs();
    const ws2 = new FakeWs();
    obliguardHub.offlineGraceMsOverride = 30;
    try {
      assert.equal(await obliguardHub.register(dev.uuid, 3, 3, '127.0.0.1', ws1 as any), true);
      ws1.close();

      const row = await waitFor(() => openIncidents({ device_id: dev.id, incident_kind: 'agent_offline' }).first());
      assert.equal(row.tenant_id, 3);
      assert.equal(row.severity, 'down');
      assert.equal(row.navigate_to, `/agents/${dev.id}`);
      assert.equal(row.stable_key, `agent_offline:device:${dev.id}`);
      await waitFor(() => hitsFor(dev.hostname, 'down').length === 1);

      // The persisted sweep sees the open incident: no second row, no second 'down'.
      await h.db('agent_devices').where({ id: dev.id }).update({ last_seen_at: new Date(Date.now() - 3600_000) });
      await obliguardHub.sweepOffline();
      assert.equal((await openIncidents({ device_id: dev.id, incident_kind: 'agent_offline' })).length, 1);
      assert.equal(await drain(() => hitsFor(dev.hostname, 'down').length > 1, 500), null);

      // Reconnection: resolved, 'up' sent once.
      assert.equal(await obliguardHub.register(dev.uuid, 3, 3, '127.0.0.1', ws2 as any), true);
      assert.equal((await openIncidents({ device_id: dev.id, incident_kind: 'agent_offline' })).length, 0);
      const resolved = await h.db('live_alerts').where({ id: row.id }).first();
      assert.ok(resolved.resolved_at, 'incident resolved');
      await waitFor(() => hitsFor(dev.hostname, 'up').length === 1);
      assert.equal(await drain(() => hitsFor(dev.hostname, 'up').length > 1, 300), null);
    } finally {
      // No grace override for the last close: its (default) timer never fires in this run.
      obliguardHub.offlineGraceMsOverride = null;
      ws1.close();
      ws2.close();
    }
  });

  lotIt('W6-2', '62.2 persisted sweep: silent approved agents only; the next push resolves + up', async () => {
    const old = new Date(Date.now() - 3600_000);
    const silent = await createDevice(h.db, { tenantId: 3, keyId: 3, groupId: 3, hostname: `w62-sweep-${crypto.randomBytes(3).toString('hex')}` });
    const suspended = await createDevice(h.db, { tenantId: 3, keyId: 3, groupId: 3, status: 'suspended' });
    const pending = await createDevice(h.db, { tenantId: 3, keyId: 3, status: 'pending' });
    const fresh = await createDevice(h.db, { tenantId: 3, keyId: 3, groupId: 3 });
    await h.db('agent_devices').whereIn('id', [silent.id, suspended.id, pending.id]).update({ last_seen_at: old });
    await h.db('agent_devices').where({ id: fresh.id }).update({ last_seen_at: new Date() });

    // Startup grace: an agent last seen before the server started gets a full
    // window to reconnect (no 'down' storm after a restart).
    obliguardHub.sweepSince = Date.now();
    await obliguardHub.sweepOffline();
    assert.equal((await openIncidents({ device_id: silent.id, incident_kind: 'agent_offline' })).length, 0);
    obliguardHub.sweepSince = 0;
    const declared = await obliguardHub.sweepOffline();
    assert.ok(declared >= 1);
    const open = await openIncidents({ incident_kind: 'agent_offline' }).whereIn('device_id', [silent.id, suspended.id, pending.id, fresh.id]);
    assert.deepEqual(open.map((r) => r.device_id), [silent.id]);
    assert.equal(open[0].tenant_id, 3);
    await waitFor(() => hitsFor(silent.hostname, 'down').length === 1);
    const dev = await h.db('agent_devices').where({ id: silent.id }).first();
    assert.ok(dev.last_offline_at, 'last_offline_at stamped');

    // A second sweep adds nothing.
    assert.equal(await obliguardHub.sweepOffline(), 0);

    // The agent pushes again (e.g. after a server restart): resolved + 'up'.
    const r = await h.push(3, silent.uuid, { hostname: silent.hostname });
    assert.equal(r.status, 200, r.text);
    assert.equal((await openIncidents({ device_id: silent.id, incident_kind: 'agent_offline' })).length, 0);
    await waitFor(() => hitsFor(silent.hostname, 'up').length === 1);
  });

  lotIt('W6-2', '62.3 threat notifications: one per cooldown window, with the real source', async () => {
    const dev = await createDevice(h.db, { tenantId: 3, keyId: 3, groupId: 3, hostname: `w62-threat-${crypto.randomBytes(3).toString('hex')}` });
    const ip = nextIp();
    const other = nextIp();
    await agentService.processEventsFlush(dev.id, 3, [
      ev(ip, { username: 'admin' }),
      ev(ip, { username: 'admin' }),
      ev(other),
    ]);
    const first = await waitFor(() => hitsFor(dev.hostname, 'threat')[0]);
    assert.equal(first.body.ip, ip);
    assert.equal(first.body.service, SVC);
    assert.equal(first.body.failureCount, 2);
    const claimed = await h.db('agent_devices').where({ id: dev.id }).first('last_threat_at');
    assert.ok(claimed.last_threat_at, 'last_threat_at set');

    // Second flush inside the cooldown: no notification, last_threat_at kept.
    await agentService.processEventsFlush(dev.id, 3, [ev(nextIp())]);
    assert.equal(await drain(() => hitsFor(dev.hostname, 'threat').length > 1, 700), null);
    const kept = await h.db('agent_devices').where({ id: dev.id }).first('last_threat_at');
    assert.equal(new Date(kept.last_threat_at).getTime(), new Date(claimed.last_threat_at).getTime());

    // Success events never notify; after the cooldown a failure notifies again.
    await h.db('agent_devices').where({ id: dev.id }).update({ last_threat_at: new Date(Date.now() - 4 * 60_000) });
    await agentService.processEventsFlush(dev.id, 3, [ev(nextIp(), { eventType: 'auth_success' })]);
    assert.equal(await drain(() => hitsFor(dev.hostname, 'threat').length > 1, 500), null);
    await agentService.processEventsFlush(dev.id, 3, [ev(nextIp())]);
    await waitFor(() => hitsFor(dev.hostname, 'threat').length === 2);
  });

  lotIt('W6-2', '62.4 agent event timestamps are clamped to [now-24h, now+5min]', async () => {
    const now = Date.now();
    assert.equal(clampEventTimestamp(new Date(now + 86_400_000).toISOString(), now).getTime(), now);
    assert.equal(clampEventTimestamp(new Date(now + 60_000).toISOString(), now).getTime(), now + 60_000);
    assert.equal(clampEventTimestamp(new Date(now - 3 * 86_400_000).toISOString(), now).getTime(), now - 86_400_000);
    assert.equal(clampEventTimestamp('not-a-date', now).getTime(), now);
    assert.equal(clampEventTimestamp(undefined, now).getTime(), now);

    const dev = await createDevice(h.db, { tenantId: 3, keyId: 3, groupId: 3 });
    const future = nextIp();
    const past = nextIp();
    const before = Date.now();
    await agentService.processEventsFlush(dev.id, 3, [
      ev(future, { timestamp: new Date(before + 86_400_000).toISOString() }),
      ev(past, { timestamp: new Date(before - 3 * 86_400_000).toISOString() }),
    ]);
    const after = Date.now();
    const rowOf = (ip: string) => h.db('ip_events').where({ device_id: dev.id }).whereRaw('ip = ?::inet', [ip]).first();
    const f = new Date((await rowOf(future)).timestamp).getTime();
    assert.ok(f >= before - 1000 && f <= after + 1000, `future event stored as now (${new Date(f).toISOString()})`);
    const p = new Date((await rowOf(past)).timestamp).getTime();
    assert.ok(p >= before - 86_400_000 - 1000 && p <= after - 86_400_000 + 1000, 'old event clamped to now - 24 h');

    // HTTP push path.
    const pushed = await createDevice(h.db, { tenantId: 3, keyId: 3, groupId: 3 });
    const viaPush = nextIp();
    const t0 = Date.now();
    const r = await h.push(3, pushed.uuid, { events: [ev(viaPush, { timestamp: new Date(t0 + 86_400_000).toISOString() })] });
    assert.equal(r.status, 200, r.text);
    const pr = await h.db('ip_events').where({ device_id: pushed.id }).whereRaw('ip = ?::inet', [viaPush]).first();
    assert.ok(pr, 'pushed event stored');
    const pt = new Date(pr.timestamp).getTime();
    assert.ok(pt >= t0 - 1000 && pt <= Date.now() + 1000, 'pushed future event stored as now');
  });

  lotIt('W6-2', '62.5 auto-ban bursts: one ban_burst per tenant per hour; quiet bursts resolved', async () => {
    assert.equal(AUTO_BAN_BURST_THRESHOLD, 10);
    const now = new Date();
    await banEngine.reportBursts(new Map([[2, AUTO_BAN_BURST_THRESHOLD], [3, AUTO_BAN_BURST_THRESHOLD - 1]]), now);
    const b = await openIncidents({ incident_kind: 'ban_burst', tenant_id: 2 });
    assert.equal(b.length, 1);
    assert.equal(b[0].stable_key, `ban_burst:tenant:2:${now.toISOString().slice(0, 13)}`);
    assert.equal(b[0].severity, 'warning');
    assert.equal((await openIncidents({ incident_kind: 'ban_burst', tenant_id: 3 })).length, 0);

    // Same hour: the open incident is bumped, not duplicated.
    await banEngine.reportBursts(new Map([[2, 25]]), now);
    const bumped = await openIncidents({ incident_kind: 'ban_burst', tenant_id: 2 });
    assert.equal(bumped.length, 1);
    assert.equal(Number(bumped[0].occurrences), 2);

    // No new burst for 24 h: resolved by a later cycle.
    await h.db('live_alerts').where({ id: bumped[0].id }).update({ updated_at: new Date(now.getTime() - 25 * 3600_000) });
    await banEngine.reportBursts(new Map(), new Date(now.getTime() + 11 * 60_000));
    assert.equal((await openIncidents({ incident_kind: 'ban_burst', tenant_id: 2 })).length, 0);
  });

  lotIt('W6-2', '62.6 a pending agent raises agent_pending; approval resolves it', async () => {
    const uuid = `w62-pending-${crypto.randomBytes(4).toString('hex')}`;
    const r = await h.push(2, uuid, { hostname: 'w62-pending-host' });
    assert.equal(r.status, 202, r.text);
    const dev = await h.db('agent_devices').where({ uuid }).first();
    assert.equal(dev.status, 'pending');
    // Raised in the background of the enrolment answer.
    const inc = await waitFor(() => openIncidents({ device_id: dev.id, incident_kind: 'agent_pending' }).first());
    assert.equal(inc.tenant_id, 2);
    assert.equal(inc.navigate_to, '/manage/agents');

    const admin = await h.adminIn(2);
    const ok = await admin.patch(`/api/agent/devices/${dev.id}`, { status: 'approved', groupId: 2 });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await h.db('agent_devices').where({ id: dev.id }).first()).status, 'approved');
    assert.equal((await openIncidents({ device_id: dev.id, incident_kind: 'agent_pending' })).length, 0);
  });

  lotIt('W6-2', '62.7 a failed update raises agent_update_failed; success resolves it', async () => {
    const dev = await createDevice(h.db, { tenantId: 3, keyId: 3, groupId: 3, version: '1.0.0' });
    assert.equal(await agentService.applyUpdateStatus(dev.id, 3, { targetVersion: '1.0.5', phase: 'failed', error: 'msi exit 1603' }), true);
    const inc = await openIncidents({ device_id: dev.id, incident_kind: 'agent_update_failed' }).first();
    assert.ok(inc, 'update failure incident raised');
    assert.equal(inc.tenant_id, 3);
    assert.match(inc.message, /1\.0\.5/);

    const r = await h.push(3, dev.uuid, { agentVersion: '1.0.5' });
    assert.equal(r.status, 200, r.text);
    const attempt = await h.db('agent_update_attempts').where({ device_id: dev.id, target_version: '1.0.5' }).first();
    assert.equal(attempt.phase, 'succeeded');
    assert.equal((await openIncidents({ device_id: dev.id, incident_kind: 'agent_update_failed' })).length, 0);
  });

  lotIt('W6-2', '62.8 remote blocklist sync failure raises an alert; the next success resolves it', async () => {
    const [row] = await h.db('remote_blocklists').insert({
      name: 'w62-list',
      source_type: 'url',
      url: 'https://blocklist.verify.invalid/w62.txt',
      api_key: null,
      enabled: false,
      tenant_id: 2,
    }).returning('*');
    await assert.rejects(remoteBlocklistService.syncOne(row));
    const inc = await openIncidents({ incident_kind: 'blocklist_sync_failed', stable_key: `blocklist_sync_failed:list:${row.id}` });
    assert.equal(inc.length, 1);
    assert.equal(inc[0].tenant_id, 2);

    // A platform list (tenant_id NULL) alerts the Default tenant.
    const [platform] = await h.db('remote_blocklists').insert({
      name: 'w62-platform', source_type: 'url', url: 'https://blocklist.verify.invalid/p.txt', api_key: null, enabled: false, tenant_id: null,
    }).returning('*');
    await assert.rejects(remoteBlocklistService.syncOne(platform));
    assert.equal((await openIncidents({ stable_key: `blocklist_sync_failed:list:${platform.id}` }).first()).tenant_id, 1);

    // Next sync succeeds (obli.tools source without a key: nothing to pull).
    await h.db('remote_blocklists').where({ id: row.id }).update({ source_type: 'oblitools' });
    await remoteBlocklistService.syncOne({ ...row, source_type: 'oblitools', api_key: null });
    assert.equal((await openIncidents({ stable_key: `blocklist_sync_failed:list:${row.id}` })).length, 0);
    // Deleting the failing platform list resolves its alert too.
    assert.equal(await remoteBlocklistService.delete(platform.id, null), true);
    assert.equal((await openIncidents({ stable_key: `blocklist_sync_failed:list:${platform.id}` })).length, 0);
  });

  lotIt('W6-2', '62.9 MikroTik sync failure raises an alert per router and direction; success resolves it', async () => {
    const mt = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: 'router-w62.verify.invalid' });
    const res = await mikrotikBanSync.fullSync(mt.id);
    assert.ok(res.error, 'sync failed');
    const push = await openIncidents({ device_id: mt.id, incident_kind: 'mikrotik_sync_failed' });
    assert.equal(push.length, 1);
    assert.equal(push[0].tenant_id, 2);
    assert.equal(push[0].stable_key, `mikrotik_sync_failed:device:${mt.id}:push`);

    // The import direction has its own incident; a push success leaves it open.
    await reportMikrotikSyncFailure(mt.id, 'import', 'connection refused');
    assert.equal((await openIncidents({ device_id: mt.id, incident_kind: 'mikrotik_sync_failed' })).length, 2);
    await resolveMikrotikSyncFailure(mt.id, 'push');
    const left = await openIncidents({ device_id: mt.id, incident_kind: 'mikrotik_sync_failed' });
    assert.deepEqual(left.map((r) => r.stable_key), [`mikrotik_sync_failed:device:${mt.id}:import`]);
    await resolveMikrotikSyncFailure(mt.id, 'import');
    assert.equal((await openIncidents({ device_id: mt.id, incident_kind: 'mikrotik_sync_failed' })).length, 0);
  });
});
