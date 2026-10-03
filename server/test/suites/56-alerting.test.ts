/**
 * 56 — W5-1 alerting tenancy: tenant-scoped notification bindings, plugin
 * outbound guard, live-alert incident model.
 *
 *   56.1 a tenant's global binding covers only its own agents; the Default
 *        tenant's global binding covers every tenant; deliveries are logged
 *        with tenant / scope
 *   56.2 "enable globally" twice keeps one row per tenant; bindings carry
 *        tenant_id; the list shows only the caller's rows (Default: all, with
 *        tenantId); unbind global removes only the caller's row
 *   56.3 migration 034 backfills tenant_id and drops duplicate bindings
 *   56.4 outbound guard: webhook to 127.0.0.1 refused, gotify allowed by
 *        default, NOTIFICATION_ALLOW_PRIVATE_TARGETS flips both, Discord /
 *        Slack / Teams pinned to their hosts, redirects refused
 *   56.5 raiseIncident twice → one open alert (bumped), audience = tenant +
 *        Default; a severity change replaces the row
 *   56.6 resolveIncidents closes it (NOTIFICATION_RESOLVED); lists hide it
 *        unless ?includeResolved=1
 *   56.7 markRead emits NOTIFICATION_READ to the reader's room
 *   56.8 a recipient's binding stops firing once the channel share is revoked
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { startHarness, waitFor, drain } from '../harness';
import type { Harness, SocketResult } from '../harness';
import { lotIt } from '../lots';
import { D } from '../fixtures';
import { notificationService } from '../../src/services/notification.service';
import { liveAlertService } from '../../src/services/liveAlert.service';
import { up as migration034 } from '../../src/db/migrations/034_alerting_tenancy';

interface Hit { path: string; body: any }
type Rec = Extract<SocketResult, { ok: true }>;

const ENV_KEY = 'NOTIFICATION_ALLOW_PRIVATE_TARGETS';

/** Run `fn` with NOTIFICATION_ALLOW_PRIVATE_TARGETS set to `value` (undefined = unset). */
async function withPrivateTargets<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  }
}

describe('56 alerting tenancy (W5-1)', () => {
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
        if ((req.url ?? '').startsWith('/redirect')) {
          res.writeHead(302, { location: `${sinkUrl}/redirected` });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await h.close();
  });

  const createChannel = async (tenantId: number, name: string, type: string, config: Record<string, unknown>): Promise<number> => {
    const c = await h.adminIn(tenantId);
    const r = await c.post('/api/notifications/channels', { name, type, config });
    assert.equal(r.status, 201, r.text);
    return r.json.data.id as number;
  };
  const createWebhook = (tenantId: number, name: string, path: string) =>
    createChannel(tenantId, name, 'webhook', { url: `${sinkUrl}${path}` });

  const bindGlobal = async (tenantId: number, channelId: number): Promise<void> => {
    const c = await h.adminIn(tenantId);
    const r = await c.post('/api/notifications/bindings', { channelId, scope: 'global', scopeId: null });
    assert.equal(r.status, 201, r.text);
  };

  const open = async (username: string): Promise<Rec> => {
    const s = await h.socket(await h.login(username));
    if (!s.ok) throw new Error(`socket for ${username}`);
    return s;
  };
  const find = (r: Rec, event: string, pred: (p: any) => boolean) =>
    r.events.find((e) => e.event === event && pred(e.args[0]));

  lotIt('W5-1', '56.1 global bindings: own tenant only, Default covers every tenant', async () => {
    const bGlobal = await createWebhook(2, 'w51-b-global', '/w51-b-global');
    const cGlobal = await createWebhook(3, 'w51-c-global', '/w51-c-global');
    const defGlobal = await createWebhook(1, 'w51-default-global', '/w51-default-global');
    await bindGlobal(2, bGlobal);
    await bindGlobal(3, cGlobal);
    await bindGlobal(1, defGlobal);

    const rows = await h.db('notification_bindings').whereIn('channel_id', [bGlobal, cGlobal, defGlobal]).orderBy('channel_id');
    assert.deepEqual(rows.map((r) => [r.channel_id, r.tenant_id]), [[bGlobal, 2], [cGlobal, 3], [defGlobal, 1]]);

    await withPrivateTargets('1', async () => {
      // Tenant C agent: C's and Default's global bindings fire, never B's.
      hits.length = 0;
      await notificationService.sendForAgent(D.C.id, 'host-c', 'threat', 'ok', [], 'threat');
      let paths = hits.map((x) => x.path).filter((p) => p.startsWith('/w51-')).sort();
      assert.deepEqual(paths, ['/w51-c-global', '/w51-default-global']);

      // Tenant B agent: B's and Default's, never C's.
      hits.length = 0;
      await notificationService.sendForAgent(D.B.id, 'host-b', 'threat', 'ok', [], 'threat');
      paths = hits.map((x) => x.path).filter((p) => p.startsWith('/w51-')).sort();
      assert.deepEqual(paths, ['/w51-b-global', '/w51-default-global']);
    });

    // The resolver agrees (and the UI source view too).
    assert.ok(!(await notificationService.resolveChannelsForAgent(D.C.id)).includes(bGlobal));
    const sources = await notificationService.resolveBindingsWithSourcesForAgent(D.C.id);
    assert.ok(sources.some((s) => s.channelId === defGlobal && s.source === 'global'));
    assert.ok(!sources.some((s) => s.channelId === bGlobal));

    // Deliveries are logged with the agent's tenant and scope.
    const log = await h.db('notification_log').where({ channel_id: cGlobal, success: true }).orderBy('id', 'desc').first();
    assert.ok(log, 'delivery logged');
    assert.equal(log.tenant_id, 3);
    assert.equal(log.scope, 'agent');
    assert.equal(log.scope_id, D.C.id);

    // A Default-made global binding of a tenant's own channel covers every
    // tenant, while the owner's own global binding keeps covering only its agents.
    await bindGlobal(1, bGlobal);
    assert.ok((await notificationService.resolveChannelsForAgent(D.C.id)).includes(bGlobal));
    const c1 = await h.adminIn(1);
    assert.equal((await c1.del('/api/notifications/bindings', { channelId: bGlobal, scope: 'global', scopeId: null })).status, 200);
    assert.ok(!(await notificationService.resolveChannelsForAgent(D.C.id)).includes(bGlobal));
    // ...and Default's unbind removed only its own row.
    assert.equal((await h.db('notification_bindings').where({ channel_id: bGlobal, scope: 'global', tenant_id: 2 })).length, 1);
  });

  lotIt('W5-1', '56.2 enable globally is idempotent per tenant; lists are tenant-scoped', async () => {
    const id = await createWebhook(2, 'w51-dup', '/w51-dup');
    for (let i = 0; i < 2; i++) await bindGlobal(2, id);
    // The Default tenant may bind the same channel globally: its own row.
    for (let i = 0; i < 2; i++) await bindGlobal(1, id);
    const rows = await h.db('notification_bindings').where({ channel_id: id, scope: 'global' }).orderBy('tenant_id');
    assert.deepEqual(rows.map((r) => r.tenant_id), [1, 2]);

    // Agent binding: tenant_id of the operating tenant.
    const b = await h.adminIn(2);
    assert.equal((await b.post('/api/notifications/bindings', { channelId: id, scope: 'agent', scopeId: D.B.id })).status, 201);
    assert.equal((await b.post('/api/notifications/bindings', { channelId: id, scope: 'agent', scopeId: D.B.id, overrideMode: 'replace' })).status, 201);
    const agentRows = await h.db('notification_bindings').where({ channel_id: id, scope: 'agent' });
    assert.equal(agentRows.length, 1);
    assert.equal(agentRows[0].tenant_id, 2);
    assert.equal(agentRows[0].override_mode, 'replace');

    // Tenant B lists only its own rows; Default lists every tenant's, with tenantId.
    const listB = await b.get('/api/notifications/bindings?scope=global');
    assert.equal(listB.status, 200, listB.text);
    const mine = (listB.json.data as any[]).filter((x) => x.channelId === id);
    assert.deepEqual(mine.map((x) => x.tenantId), [2]);
    assert.ok((listB.json.data as any[]).every((x) => x.tenantId === 2), listB.text);
    const allB = await b.get('/api/notifications/bindings');
    assert.ok((allB.json.data as any[]).every((x) => x.tenantId === 2), allB.text);
    const c3 = await h.adminIn(3);
    const listC = await c3.get('/api/notifications/bindings?scope=global');
    assert.ok(!(listC.json.data as any[]).some((x) => x.channelId === id), listC.text);
    const def = await h.adminIn(1);
    const listDef = await def.get('/api/notifications/bindings?scope=global');
    const forChannel = (listDef.json.data as any[]).filter((x) => x.channelId === id).map((x) => x.tenantId).sort();
    assert.deepEqual(forChannel, [1, 2]);

    // Tenant B's unbind removes its own global row only.
    assert.equal((await b.del('/api/notifications/bindings', { channelId: id, scope: 'global', scopeId: null })).status, 200);
    const left = await h.db('notification_bindings').where({ channel_id: id, scope: 'global' });
    assert.deepEqual(left.map((r) => r.tenant_id), [1]);
  });

  lotIt('W5-1', '56.3 migration 034 backfills tenant_id and removes duplicate bindings', async () => {
    const shared = await createWebhook(3, 'w51-mig', '/w51-mig');
    const legacyDefault = await createWebhook(1, 'w51-mig-default', '/w51-mig-default');
    // Rebuild the pre-034 shape on a copy of the rows: nullable tenant_id, no unique index.
    await h.db.raw('DROP INDEX IF EXISTS notification_bindings_scope_tenant_unique');
    await h.db.raw('ALTER TABLE notification_bindings ALTER COLUMN tenant_id DROP NOT NULL');
    await h.db('notification_bindings').insert([
      { channel_id: shared, scope: 'global', scope_id: null, override_mode: 'merge', tenant_id: null },
      { channel_id: shared, scope: 'global', scope_id: null, override_mode: 'merge', tenant_id: null },
      { channel_id: shared, scope: 'global', scope_id: null, override_mode: 'merge', tenant_id: null },
      { channel_id: shared, scope: 'agent', scope_id: D.B.id, override_mode: 'merge', tenant_id: null },
      { channel_id: shared, scope: 'group', scope_id: 2, override_mode: 'merge', tenant_id: null },
      // Pre-W1 shape: a Default channel (not shared) bound from Default on a tenant B agent.
      { channel_id: legacyDefault, scope: 'agent', scope_id: D.B.id, override_mode: 'merge', tenant_id: null },
    ]);
    await migration034(h.db);

    const rows = await h.db('notification_bindings').where({ channel_id: shared }).orderBy('id');
    const byScope = (scope: string) => rows.filter((r) => r.scope === scope);
    assert.equal(byScope('global').length, 1, 'duplicate global bindings removed');
    assert.equal(byScope('global')[0].tenant_id, 3, 'global binding: channel owner');
    assert.equal(byScope('agent')[0].tenant_id, 2, 'agent binding: tenant of the agent');
    assert.equal(byScope('group')[0].tenant_id, 2, 'group binding: tenant of the group');
    // The legacy Default row stays Default's and keeps firing for the agent.
    const legacy = await h.db('notification_bindings').where({ channel_id: legacyDefault, scope: 'agent' });
    assert.deepEqual(legacy.map((r) => r.tenant_id), [1]);
    assert.ok((await notificationService.resolveChannelsForAgent(D.B.id)).includes(legacyDefault));
    // ...while the unshared tenant-C channel bound on a tenant B agent does not.
    assert.ok(!(await notificationService.resolveChannelsForAgent(D.B.id)).includes(shared));
    const col = await h.db.raw(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'notification_bindings' AND column_name = 'tenant_id'`);
    assert.equal(col.rows[0].is_nullable, 'NO');
    // The unique index is back: a raw duplicate insert is refused.
    await assert.rejects(h.db('notification_bindings').insert({ channel_id: shared, scope: 'global', scope_id: null, override_mode: 'merge', tenant_id: 3 }));
  });

  lotIt('W5-1', '56.4 plugin outbound guard', async () => {
    const c = await h.adminIn(2);
    const test = (id: number) => c.post(`/api/notifications/channels/${id}/test`);

    const webhook = await createWebhook(2, 'w51-loopback', '/w51-loopback');
    const gotify = await createChannel(2, 'w51-gotify', 'gotify', { serverUrl: `${sinkUrl}/w51-gotify`, appToken: 'tok' });

    await withPrivateTargets(undefined, async () => {
      hits.length = 0;
      const r = await test(webhook);
      assert.equal(r.status, 400, r.text);
      assert.match(r.text, /private/i);
      assert.equal(hits.length, 0, 'the loopback target was never contacted');
      const fail = await h.db('notification_log').where({ channel_id: webhook, event_type: 'test' }).orderBy('id', 'desc').first();
      assert.equal(fail.success, false);
      assert.equal(fail.tenant_id, 2);

      // Gotify / ntfy: private (self-hosted) targets allowed by default.
      const g = await test(gotify);
      assert.equal(g.status, 200, g.text);
      assert.ok(hits.some((x) => x.path.startsWith('/w51-gotify/message')));
    });

    await withPrivateTargets('false', async () => {
      hits.length = 0;
      const g = await test(gotify);
      assert.equal(g.status, 400, g.text);
      assert.equal(hits.length, 0);
    });

    await withPrivateTargets('1', async () => {
      hits.length = 0;
      assert.equal((await test(webhook)).status, 200);
      assert.ok(hits.some((x) => x.path === '/w51-loopback'));

      // Redirects are never followed.
      const redirect = await createWebhook(2, 'w51-redirect', '/redirect');
      hits.length = 0;
      const r = await test(redirect);
      assert.equal(r.status, 400, r.text);
      assert.match(r.text, /redirect/i);
      assert.ok(!hits.some((x) => x.path === '/redirected'));

      // Discord / Slack / Teams stay pinned to their official hosts, whatever the switch.
      const pinned: Array<[string, string]> = [
        ['discord', `${sinkUrl}/api/webhooks/1/x`],
        ['discord', 'https://discord.com.evil.example/api/webhooks/1/x'],
        ['slack', 'http://hooks.slack.com/services/T/B/X'],
        ['slack', 'https://hooks.slack.com.evil.example/services/T/B/X'],
        ['teams', 'https://webhook.office.com.evil.example/webhookb2/x'],
        ['teams', `${sinkUrl}/webhookb2/x`],
      ];
      for (const [type, url] of pinned) {
        const id = await createChannel(2, `w51-${type}-pin`, type, { webhookUrl: url });
        hits.length = 0;
        const res = await test(id);
        assert.equal(res.status, 400, `${type} ${url}: ${res.text}`);
        assert.equal(hits.length, 0, `${type} ${url} was contacted`);
      }
    });
  });

  lotIt('W5-1', '56.5 raiseIncident twice keeps one open alert; audience is the tenant plus Default', async () => {
    const mb = await open('member_b');
    const mc = await open('member_c');
    const dm = await open('default_member');
    const stableKey = `agent_offline:device:${D.B.id}`;
    const input = {
      tenantId: 2, kind: 'agent_offline' as const, stableKey, deviceId: D.B.id,
      title: 'host-b is offline', message: 'Agent host-b is offline', severity: 'down' as const, link: `/agents/${D.B.id}`,
    };

    const first = await liveAlertService.raiseIncident(input);
    assert.equal(first.created, true);
    const second = await liveAlertService.raiseIncident({ ...input, message: 'Agent host-b is still offline' });
    assert.equal(second.created, false);
    assert.equal(second.alert.id, first.alert.id);
    assert.equal(second.alert.occurrences, 2);

    const open1 = await h.db('live_alerts').where({ tenant_id: 2, stable_key: stableKey }).whereNull('resolved_at');
    assert.equal(open1.length, 1);
    assert.equal(open1[0].occurrences, 2);
    assert.equal(open1[0].message, 'Agent host-b is still offline');
    assert.equal(open1[0].incident_kind, 'agent_offline');
    assert.equal(open1[0].device_id, D.B.id);

    // NOTIFICATION_NEW once, to tenant B and Default, never to tenant C.
    await waitFor(() => find(mb, 'notification:new', (p) => p?.id === first.alert.id), 3000);
    await waitFor(() => find(dm, 'notification:new', (p) => p?.id === first.alert.id), 3000);
    assert.equal(await drain(() => find(mc, 'notification:new', (p) => p?.id === first.alert.id), 500), null);
    assert.equal(mb.events.filter((e) => e.event === 'notification:new' && e.args[0]?.id === first.alert.id).length, 1);

    // Concurrent raises still leave one active row.
    const key2 = `ban_burst:tenant:2:${Date.now()}`;
    await Promise.all(Array.from({ length: 5 }, () => liveAlertService.raiseIncident({ ...input, kind: 'ban_burst', stableKey: key2, deviceId: null, severity: 'warning' })));
    const burst = await h.db('live_alerts').where({ tenant_id: 2, stable_key: key2 }).whereNull('resolved_at');
    assert.equal(burst.length, 1);
    assert.equal(burst[0].occurrences, 5);

    // A severity change replaces the open row (escalation is announced again).
    const escalated = await liveAlertService.raiseIncident({ ...input, severity: 'warning' });
    assert.equal(escalated.created, true);
    assert.notEqual(escalated.alert.id, first.alert.id);
    const active = await h.db('live_alerts').where({ tenant_id: 2, stable_key: stableKey }).whereNull('resolved_at');
    assert.deepEqual(active.map((r) => r.id), [escalated.alert.id]);
    await waitFor(() => find(mb, 'notification:resolved', (p) => (p?.ids ?? []).includes(first.alert.id)), 3000);

    // Members see one row of the incident.
    const b = await h.as('member_b');
    const list = await b.get('/api/live-alerts/all');
    assert.equal(list.status, 200, list.text);
    assert.equal((list.json.alerts as any[]).filter((a) => a.stableKey === stableKey).length, 1);
    // Tenant C's members do not see it; the Default tenant does.
    const cList = await (await h.as('member_c')).get('/api/live-alerts/all');
    assert.ok(!(cList.json.alerts as any[]).some((a) => a.stableKey === stableKey));
    const dList = await (await h.as('default_member')).get('/api/live-alerts/all');
    assert.ok((dList.json.alerts as any[]).some((a) => a.stableKey === stableKey));

    await assert.rejects(liveAlertService.raiseIncident({ ...input, kind: 'nope' as any }));
  });

  lotIt('W5-1', '56.6 resolveIncidents closes the incident and hides it', async () => {
    const mb = await open('member_b');
    const stableKey = `agent_update_failed:device:${D.B_EVAL.id}`;
    const raised = await liveAlertService.raiseIncident({
      tenantId: 2, kind: 'agent_update_failed', stableKey, deviceId: D.B_EVAL.id,
      title: 'update failed', message: 'host-b-eval update failed', severity: 'warning',
    });
    const b = await h.as('member_b');
    await b.switchTenant(2);
    assert.ok(((await b.get('/api/live-alerts')).json as any[]).some((a) => a.id === raised.alert.id));

    const ids = await liveAlertService.resolveIncidents({ tenantId: 2, stableKey });
    assert.deepEqual(ids, [raised.alert.id]);
    const row = await h.db('live_alerts').where({ id: raised.alert.id }).first();
    assert.ok(row.resolved_at, 'resolved_at set');
    await waitFor(() => find(mb, 'notification:resolved', (p) => (p?.ids ?? []).includes(raised.alert.id)), 3000);

    // Hidden by default, listed with ?includeResolved=1.
    assert.ok(!((await b.get('/api/live-alerts')).json as any[]).some((a) => a.id === raised.alert.id));
    assert.ok(!((await b.get('/api/live-alerts/all')).json.alerts as any[]).some((a) => a.id === raised.alert.id));
    const withResolved = (await b.get('/api/live-alerts?includeResolved=1')).json as any[];
    const listed = withResolved.find((a) => a.id === raised.alert.id);
    assert.ok(listed, 'resolved alert listed with includeResolved');
    assert.ok(listed.resolvedAt);

    // Resolving again is a no-op; a new raise opens a fresh incident.
    assert.deepEqual(await liveAlertService.resolveIncidents({ tenantId: 2, stableKey }), []);
    const again = await liveAlertService.raiseIncident({
      tenantId: 2, kind: 'agent_update_failed', stableKey, deviceId: D.B_EVAL.id,
      title: 'update failed', message: 'host-b-eval update failed', severity: 'warning',
    });
    assert.equal(again.created, true);

    // Resolve by device + kind, across tenants.
    assert.deepEqual(await liveAlertService.resolveIncidents({ deviceId: D.B_EVAL.id, kind: 'agent_update_failed' }), [again.alert.id]);
    await assert.rejects(liveAlertService.resolveIncidents({}));
  });

  lotIt('W5-1', '56.7 markRead emits NOTIFICATION_READ to the reader', async () => {
    const mb = await open('member_b');
    const mc = await open('member_c');
    const raised = await liveAlertService.raiseIncident({
      tenantId: 2, kind: 'agent_pending', stableKey: `agent_pending:device:${D.B_PENDING.id}`, deviceId: D.B_PENDING.id,
      title: 'pending agent', message: 'host-b-pending awaits approval', severity: 'info',
    });
    const b = await h.as('member_b');
    const r = await b.patch(`/api/live-alerts/${raised.alert.id}/read`);
    assert.equal(r.status, 200, r.text);
    const ev = await waitFor(() => find(mb, 'notification:read', (p) => (p?.ids ?? []).includes(raised.alert.id)), 3000);
    assert.equal(ev.args[0].tenantId, 2);
    assert.ok(ev.args[0].readAt);
    assert.equal(await drain(() => find(mc, 'notification:read', (p) => (p?.ids ?? []).includes(raised.alert.id)), 500), null);
    const row = await h.db('live_alerts').where({ id: raised.alert.id }).first();
    assert.ok(row.read_at);

    // Tenant C cannot mark tenant B's alert read.
    const c = await h.as('member_c');
    assert.equal((await c.patch(`/api/live-alerts/${raised.alert.id}/read`)).status, 404);
    assert.equal((await c.patch('/api/live-alerts/abc/read')).status, 404);
  });

  lotIt('W5-1', '56.8 a revoked share stops the recipient binding from firing', async () => {
    const id = await createWebhook(3, 'w51-shared', '/w51-shared');
    const owner = await h.adminIn(3);
    assert.equal((await owner.put(`/api/notifications/channels/${id}/tenants`, { tenantIds: [2] })).status, 200);
    const b = await h.adminIn(2);
    assert.equal((await b.post('/api/notifications/bindings', { channelId: id, scope: 'agent', scopeId: D.B.id })).status, 201);
    assert.ok((await notificationService.resolveChannelsForAgent(D.B.id)).includes(id));

    assert.equal((await owner.put(`/api/notifications/channels/${id}/tenants`, { tenantIds: [] })).status, 200);
    assert.ok(!(await notificationService.resolveChannelsForAgent(D.B.id)).includes(id));
    // The row is still there (the recipient can clean it up), it just no longer fires.
    assert.equal((await h.db('notification_bindings').where({ channel_id: id, scope: 'agent', tenant_id: 2 })).length, 1);
  });
});
