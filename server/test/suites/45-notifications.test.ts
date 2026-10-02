/**
 * 45 — W1-6 notification dispatch repair.
 *
 *   45.1 every bound channel fires (notification_log insert no longer aborts
 *        the loop) with an IPS text, never "back to normal"
 *   45.2 GET /api/notifications/bindings without scope → 200; bad scope → 400
 *   45.3 channel ownership: another tenant cannot read/edit/delete/test/share
 *        a channel; a shared recipient sees it redacted and read-only
 *   45.4 SMTP server ownership: foreign update/delete/test → 404
 *   45.5 SMTP renderer escapes attacker-controlled text
 *   45.6 global binding upsert does not duplicate
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { D } from '../fixtures';
import { insertEvents, nextIp } from '../seed';
import { notificationService } from '../../src/services/notification.service';
import { buildSmtpMessage } from '../../src/notifications/plugins/smtp';

interface Hit { path: string; body: any }

describe('45 notifications (W1-6)', () => {
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
  });
  after(async () => {
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await h.close();
  });

  const createWebhook = async (tenantId: number, name: string, path: string): Promise<number> => {
    const c = await h.adminIn(tenantId);
    const r = await c.post('/api/notifications/channels', {
      name, type: 'webhook', config: { url: `${sinkUrl}${path}`, secret: 'super-secret-token' },
    });
    assert.equal(r.status, 201, r.text);
    return r.json.data.id as number;
  };

  lotIt('W1-6', '45.1 threat reaches every bound channel with an IPS message', async () => {
    const a = await createWebhook(2, 'w16-a', '/a');
    const b = await createWebhook(2, 'w16-b', '/b');
    const c = await h.adminIn(2);
    assert.equal((await c.post('/api/notifications/bindings', { channelId: a, scope: 'global', scopeId: null })).status, 201);
    assert.equal((await c.post('/api/notifications/bindings', { channelId: b, scope: 'agent', scopeId: D.B.id })).status, 201);

    const ip = nextIp();
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: 2, ip, service: 'ssh', count: 4 });

    hits.length = 0;
    await notificationService.sendForAgent(D.B.id, 'host-b', 'threat', 'ok', [], 'threat');
    const paths = hits.map((x) => x.path).sort();
    assert.deepEqual(paths, ['/a', '/b']);
    for (const hit of hits) {
      const text = JSON.stringify(hit.body);
      assert.ok(!/back to normal/i.test(text), text);
      assert.equal(hit.body.kind, 'threat');
      assert.ok(String(hit.body.message).includes(ip), text);
      assert.ok(String(hit.body.message).includes('ssh'), text);
      assert.equal(hit.body.failureCount, 4);
    }
    const logs = await h.db('notification_log').whereIn('channel_id', [a, b]).where({ success: true });
    assert.equal(logs.length, 2);

    // Ban (attack) text carries the violation.
    hits.length = 0;
    await notificationService.sendForAgent(D.B.id, 'host-b', 'attack', 'ok', [`${ip} banned (7 ssh failures)`], 'attack');
    assert.equal(hits.length, 2);
    for (const hit of hits) {
      assert.ok(String(hit.body.message).startsWith(`${ip} banned (7 ssh failures)`), hit.body.message);
      assert.equal(hit.body.ip, ip);
      assert.ok(!/back to normal/i.test(JSON.stringify(hit.body)));
    }

    // Offline text.
    hits.length = 0;
    await notificationService.sendForAgent(D.B.id, 'host-b', 'down', 'up', [], 'down');
    assert.equal(hits.length, 2);
    assert.ok(/offline - bans are no longer enforced/.test(String(hits[0].body.message)));

    // Tenant B's global binding does not cover a tenant-C agent.
    hits.length = 0;
    await notificationService.sendForAgent(D.C.id, 'host-c', 'threat', 'ok', [], 'threat');
    assert.equal(hits.filter((x) => x.path === '/a').length, 0);
  });

  lotIt('W1-6', '45.2 bindings list validates its query', async () => {
    const c = await h.adminIn(2);
    const all = await c.get('/api/notifications/bindings');
    assert.equal(all.status, 200, all.text);
    assert.ok(Array.isArray(all.json.data));
    assert.equal((await c.get('/api/notifications/bindings?scope=global')).status, 200);
    assert.equal((await c.get('/api/notifications/bindings?scope=monitor')).status, 400);
    assert.equal((await c.get('/api/notifications/bindings?scope=agent&scopeId=abc')).status, 400);
    assert.equal((await c.get('/api/notifications/bindings/resolved?scope=monitor&scopeId=1')).status, 400);
  });

  lotIt('W1-6', '45.3 channel ownership and redaction', async () => {
    const id = await createWebhook(3, 'w16-c-owned', '/c');
    const b = await h.adminIn(2);
    assert.equal((await b.get(`/api/notifications/channels/${id}`)).status, 404);
    assert.equal((await b.put(`/api/notifications/channels/${id}`, { name: 'pwned' })).status, 404);
    assert.equal((await b.del(`/api/notifications/channels/${id}`)).status, 404);
    assert.equal((await b.post(`/api/notifications/channels/${id}/test`)).status, 404);
    assert.equal((await b.get(`/api/notifications/channels/${id}/tenants`)).status, 404);
    assert.equal((await b.put(`/api/notifications/channels/${id}/tenants`, { tenantIds: [2] })).status, 404);
    assert.equal((await b.post('/api/notifications/bindings', { channelId: id, scope: 'agent', scopeId: D.B.id })).status, 404);
    const row = await h.db('notification_channels').where({ id }).first();
    assert.equal(row.name, 'w16-c-owned');

    // Shared to tenant B: visible but redacted and read-only; still not editable.
    const cAdmin = await h.adminIn(3);
    assert.equal((await cAdmin.put(`/api/notifications/channels/${id}/tenants`, { tenantIds: [2] })).status, 200);
    const seen = await b.get(`/api/notifications/channels/${id}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.json.data.readOnly, true);
    assert.ok(!seen.text.includes('super-secret-token'));
    assert.ok(!seen.text.includes(sinkUrl));
    const list = await b.get('/api/notifications/channels');
    const listed = (list.json.data as any[]).find((x) => x.id === id);
    assert.ok(listed, 'shared channel listed for the recipient');
    assert.equal(listed.readOnly, true);
    assert.ok(!JSON.stringify(listed).includes('super-secret-token'));
    assert.equal((await b.put(`/api/notifications/channels/${id}`, { name: 'pwned' })).status, 403);
    assert.equal((await b.del(`/api/notifications/channels/${id}`)).status, 403);
    // A recipient may not bind someone else's channel globally (it would fan out to the owner's agents).
    assert.equal((await b.post('/api/notifications/bindings', { channelId: id, scope: 'global', scopeId: null })).status, 403);
    // ...but may attach it to its own agent, not to a foreign one.
    assert.equal((await b.post('/api/notifications/bindings', { channelId: id, scope: 'agent', scopeId: D.B.id })).status, 201);
    assert.equal((await b.post('/api/notifications/bindings', { channelId: id, scope: 'agent', scopeId: D.C.id })).status, 404);

    // The owner still sees the full config.
    const own = await cAdmin.get(`/api/notifications/channels/${id}`);
    assert.equal(own.json.data.readOnly, false);
    assert.equal(own.json.data.config.secret, 'super-secret-token');

    // The owner's global binding covers only the owner's agents: the recipient
    // does not see it among the global bindings that apply to it.
    assert.equal((await cAdmin.post('/api/notifications/bindings', { channelId: id, scope: 'global', scopeId: null })).status, 201);
    const globals = await b.get('/api/notifications/bindings?scope=global');
    assert.equal(globals.status, 200);
    assert.ok(!(globals.json.data as any[]).some((x) => x.channelId === id), globals.text);

    // Once the share is revoked the recipient can still clean up the binding on its own agent.
    assert.equal((await cAdmin.put(`/api/notifications/channels/${id}/tenants`, { tenantIds: [] })).status, 200);
    assert.equal((await b.get(`/api/notifications/channels/${id}`)).status, 404);
    const rm = await b.del('/api/notifications/bindings', { channelId: id, scope: 'agent', scopeId: D.B.id });
    assert.equal(rm.status, 200, rm.text);
    assert.equal((await h.db('notification_bindings').where({ channel_id: id, scope: 'agent' })).length, 0);
    // ...but never on a foreign agent.
    assert.equal((await b.del('/api/notifications/bindings', { channelId: id, scope: 'agent', scopeId: D.C.id })).status, 404);
  });

  lotIt('W1-6', '45.4 SMTP server ownership', async () => {
    const c = await h.adminIn(3);
    const created = await c.post('/api/admin/smtp-servers', {
      name: 'w16-smtp', host: '127.0.0.1', port: 2525, secure: false,
      username: 'u', password: 'p', fromAddress: 'from@verify.test',
    });
    assert.equal(created.status, 201, created.text);
    const id = created.json.data.id as number;
    const b = await h.adminIn(2);
    assert.equal((await b.put(`/api/admin/smtp-servers/${id}`, { host: 'evil.example' })).status, 404);
    assert.equal((await b.del(`/api/admin/smtp-servers/${id}`)).status, 404);
    assert.equal((await b.post(`/api/admin/smtp-servers/${id}/test`)).status, 404);
    // A channel of tenant B cannot borrow tenant C's SMTP credentials.
    const ch = await b.post('/api/notifications/channels', {
      name: 'w16-smtp-borrow', type: 'smtp', config: { smtpServerId: id, to: 'x@verify.test' },
    });
    assert.equal(ch.status, 400);
    const row = await h.db('smtp_servers').where({ id }).first();
    assert.equal(row.host, '127.0.0.1');
  });

  lotIt('W1-6', '45.5 SMTP renderer escapes attacker-controlled text', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const msg = buildSmtpMessage({
      monitorName: 'host-b', oldStatus: 'ok', newStatus: 'alert', timestamp: new Date().toISOString(),
      kind: 'threat', title: 'host-b: suspicious activity\r\nBcc: victim@example.com', message: `suspicious activity from 192.0.2.1 by ${evil}`,
      username: evil, agentName: `<b>host</b>`, url: 'javascript:alert(1)',
    });
    assert.ok(!msg.html.includes('<img'), msg.html);
    assert.ok(!msg.html.includes('<b>host'), msg.html);
    assert.ok(msg.html.includes('&lt;img src=x onerror=alert(1)&gt;'), msg.html);
    assert.ok(!msg.html.includes('href="javascript:'), msg.html);
    assert.ok(!/[\r\n]/.test(msg.subject), msg.subject);
    assert.ok(msg.subject.includes('Bcc: victim'), msg.subject); // folded into one line, not dropped
  });

  lotIt('W1-6', '45.6 global binding enable is idempotent', async () => {
    const id = await createWebhook(2, 'w16-dup', '/dup');
    const c = await h.adminIn(2);
    for (let i = 0; i < 3; i++) {
      assert.equal((await c.post('/api/notifications/bindings', { channelId: id, scope: 'global', scopeId: null })).status, 201);
    }
    const rows = await h.db('notification_bindings').where({ channel_id: id, scope: 'global' });
    assert.equal(rows.length, 1);
    const del = await c.del('/api/notifications/bindings', { channelId: id, scope: 'global', scopeId: null });
    assert.equal(del.status, 200);
    assert.equal((await h.db('notification_bindings').where({ channel_id: id })).length, 0);
  });
});
