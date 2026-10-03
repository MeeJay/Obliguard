// verify-env: NOTIFICATION_ALLOW_PRIVATE_TARGETS=1
/**
 * 93 — W12-5 secrets at rest: smtp_servers.password and the secret fields of
 * notification_channels.config (notifications/secretFields.ts) are stored as
 * "enc:v1:" + AES-256-GCM (utils/crypto.ts). No migration:
 *
 *   93.1 an SMTP server created through the API is stored sealed; the API
 *        never returns the password; test / transport get the plaintext
 *   93.2 a legacy plaintext SMTP row still works and is sealed by its next
 *        write (even one that does not touch the password)
 *   93.3 a channel created through the API is stored sealed; the owner reads
 *        it decrypted; a send still carries the real secret
 *   93.4 a legacy plaintext channel still sends, is sealed by its next write,
 *        and a masked value round-tripped by the form keeps the stored secret
 *   93.5 reencryptSecrets() seals legacy rows of both tables, idempotently
 *   93.6 a secret no key can decrypt is refused at send time (never sent as is)
 *   93.7 an SMTP channel resolves the decrypted server password
 */
import { describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import nodemailer from 'nodemailer';
import { NOTIFICATION_REDACTED } from '@obliview/shared';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { smtpServerService } from '../../src/services/smtpServer.service';
import { notificationService } from '../../src/services/notification.service';
import { SECRET_ENVELOPE_PREFIX, secretFieldsFor } from '../../src/notifications/secretFields';

interface Hit { path: string; auth: string | undefined }
interface Transport { host: unknown; user: unknown; pass: unknown }

const SEALED = /^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;

describe('93 secrets at rest (W12-5)', () => {
  let h: Harness;
  let sink: http.Server;
  let sinkUrl = '';
  const hits: Hit[] = [];
  const transports: Transport[] = [];

  before(async () => {
    h = await startHarness();
    sink = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits.push({ path: req.url ?? '', auth: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    mock.method(nodemailer as unknown as { createTransport: (...a: unknown[]) => unknown }, 'createTransport',
      (opts: { host: unknown; auth?: { user: unknown; pass: unknown } }) => {
        transports.push({ host: opts.host, user: opts.auth?.user, pass: opts.auth?.pass });
        return {
          verify: async () => true,
          sendMail: async () => ({ messageId: `verify-${transports.length}` }),
        };
      });
  });
  after(async () => {
    mock.restoreAll();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await h.close();
  });

  const rawChannel = async (id: number): Promise<Record<string, unknown>> => {
    const row = await h.db('notification_channels').where({ id }).first();
    return typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
  };

  const insertLegacySmtp = async (name: string, password: string): Promise<number> => {
    const [row] = await h.db('smtp_servers').insert({
      name, host: 'smtp.verify.invalid', port: 587, secure: false,
      username: 'legacy', password, from_address: 'legacy@verify.test', tenant_id: 2,
    }).returning('id') as Array<{ id: number }>;
    return row.id;
  };

  const insertLegacyChannel = async (name: string, config: Record<string, unknown>): Promise<number> => {
    const [row] = await h.db('notification_channels').insert({
      name, type: 'webhook', config: JSON.stringify(config), is_enabled: true, tenant_id: 2,
    }).returning('id') as Array<{ id: number }>;
    return row.id;
  };

  lotIt('W12-5', '93.1 SMTP password created through the API is sealed', async () => {
    const c = await h.adminIn(2);
    const created = await c.post('/api/admin/smtp-servers', {
      name: 'w125-smtp', host: 'smtp-a.verify.invalid', port: 587, secure: false,
      username: 'mailer', password: 'smtp-plain-pw-93', fromAddress: 'from@verify.test',
    });
    assert.equal(created.status, 201, created.text);
    assert.ok(!created.text.includes('smtp-plain-pw-93'));
    const id = created.json.data.id as number;

    const row = await h.db('smtp_servers').where({ id }).first();
    assert.match(row.password, SEALED);
    assert.ok(!row.password.includes('smtp-plain-pw-93'));

    const list = await c.get('/api/admin/smtp-servers');
    assert.equal(list.status, 200, list.text);
    assert.ok(!list.text.includes('smtp-plain-pw-93'));
    assert.ok(!list.text.includes(SECRET_ENVELOPE_PREFIX));

    const transport = await smtpServerService.getTransportConfig(id);
    assert.equal(transport?.password, 'smtp-plain-pw-93');

    transports.length = 0;
    const tested = await c.post(`/api/admin/smtp-servers/${id}/test`);
    assert.equal(tested.status, 200, tested.text);
    assert.deepEqual(transports.map((t) => t.pass), ['smtp-plain-pw-93']);

    // A new password is sealed again (fresh IV), and still opens.
    assert.equal((await c.put(`/api/admin/smtp-servers/${id}`, { password: 'smtp-new-pw-93' })).status, 200);
    const after = await h.db('smtp_servers').where({ id }).first();
    assert.match(after.password, SEALED);
    assert.notEqual(after.password, row.password);
    assert.equal((await smtpServerService.getTransportConfig(id))?.password, 'smtp-new-pw-93');
  });

  lotIt('W12-5', '93.2 legacy plaintext SMTP password works and is sealed on the next write', async () => {
    const id = await insertLegacySmtp('w125-legacy-smtp', 'legacy-smtp-pw');
    assert.equal((await smtpServerService.getTransportConfig(id))?.password, 'legacy-smtp-pw');

    const c = await h.adminIn(2);
    transports.length = 0;
    assert.equal((await c.post(`/api/admin/smtp-servers/${id}/test`)).status, 200);
    assert.deepEqual(transports.map((t) => t.pass), ['legacy-smtp-pw']);

    // Reading does not rewrite the row: the next write seals it.
    assert.equal((await h.db('smtp_servers').where({ id }).first()).password, 'legacy-smtp-pw');

    // A write that does not touch the password still seals it.
    assert.equal((await c.put(`/api/admin/smtp-servers/${id}`, { name: 'w125-legacy-smtp-renamed' })).status, 200);
    const row = await h.db('smtp_servers').where({ id }).first();
    assert.match(row.password, SEALED);
    assert.equal((await smtpServerService.getTransportConfig(id))?.password, 'legacy-smtp-pw');
  });

  lotIt('W12-5', '93.3 channel secrets created through the API are sealed and still delivered', async () => {
    const c = await h.adminIn(2);
    const url = `${sinkUrl}/w125-new`;
    const r = await c.post('/api/notifications/channels', {
      name: 'w125-hook', type: 'webhook', config: { url, secret: 'hook-secret-93' },
    });
    assert.equal(r.status, 201, r.text);
    const id = r.json.data.id as number;

    const raw = await rawChannel(id);
    assert.match(String(raw.url), SEALED);
    assert.match(String(raw.secret), SEALED);
    const rawText = JSON.stringify(raw);
    assert.ok(!rawText.includes('hook-secret-93'), rawText);
    assert.ok(!rawText.includes('w125-new'), rawText);

    // The owner reads the config decrypted.
    const own = await c.get(`/api/notifications/channels/${id}`);
    assert.equal(own.status, 200, own.text);
    assert.equal(own.json.data.config.url, url);
    assert.equal(own.json.data.config.secret, 'hook-secret-93');

    hits.length = 0;
    const t = await c.post(`/api/notifications/channels/${id}/test`);
    assert.equal(t.status, 200, t.text);
    assert.deepEqual(hits, [{ path: '/w125-new', auth: 'hook-secret-93' }]);
  });

  lotIt('W12-5', '93.4 legacy plaintext channel still sends and is sealed on the next write', async () => {
    const url = `${sinkUrl}/w125-legacy`;
    const id = await insertLegacyChannel('w125-legacy-hook', { url, secret: 'legacy-hook-secret' });
    const c = await h.adminIn(2);

    hits.length = 0;
    assert.equal((await c.post(`/api/notifications/channels/${id}/test`)).status, 200);
    assert.deepEqual(hits, [{ path: '/w125-legacy', auth: 'legacy-hook-secret' }]);

    // Sending does not rewrite the row: the next write seals it.
    assert.equal((await rawChannel(id)).secret, 'legacy-hook-secret');

    // A write without config (rename) seals the legacy secrets.
    assert.equal((await c.put(`/api/notifications/channels/${id}`, { name: 'w125-legacy-renamed' })).status, 200);
    const sealed = await rawChannel(id);
    assert.match(String(sealed.url), SEALED);
    assert.match(String(sealed.secret), SEALED);

    // The form round-trips a masked secret: the stored one is kept, sealed.
    const upd = await c.put(`/api/notifications/channels/${id}`, { config: { url, secret: NOTIFICATION_REDACTED } });
    assert.equal(upd.status, 200, upd.text);
    const kept = await rawChannel(id);
    assert.equal(kept.secret, sealed.secret);
    assert.match(String(kept.url), SEALED);

    hits.length = 0;
    assert.equal((await c.post(`/api/notifications/channels/${id}/test`)).status, 200);
    assert.deepEqual(hits, [{ path: '/w125-legacy', auth: 'legacy-hook-secret' }]);
  });

  lotIt('W12-5', '93.5 reencryptSecrets() seals legacy rows of both tables, idempotently', async () => {
    const smtpId = await insertLegacySmtp('w125-reenc-smtp', 'reenc-smtp-pw');
    const chId = await insertLegacyChannel('w125-reenc-hook', { url: `${sinkUrl}/w125-reenc`, secret: 'reenc-secret' });
    assert.equal((await h.db('smtp_servers').where({ id: smtpId }).first()).password, 'reenc-smtp-pw');
    assert.equal((await rawChannel(chId)).secret, 'reenc-secret');
    const before = await h.db('notification_channels').where({ id: chId }).first('updated_at');

    assert.ok(await smtpServerService.reencryptSecrets() >= 1);
    assert.ok(await notificationService.reencryptSecrets() >= 1);

    const smtp = await h.db('smtp_servers').where({ id: smtpId }).first();
    assert.match(smtp.password, SEALED);
    const ch = await rawChannel(chId);
    assert.match(String(ch.url), SEALED);
    assert.match(String(ch.secret), SEALED);
    const afterRow = await h.db('notification_channels').where({ id: chId }).first('updated_at');
    assert.equal(new Date(afterRow.updated_at).getTime(), new Date(before.updated_at).getTime(), 'not a user change');

    // Second pass: nothing left to seal, values unchanged.
    assert.equal(await smtpServerService.reencryptSecrets(), 0);
    assert.equal(await notificationService.reencryptSecrets(), 0);
    assert.equal((await h.db('smtp_servers').where({ id: smtpId }).first()).password, smtp.password);
    assert.deepEqual(await rawChannel(chId), ch);

    assert.equal((await smtpServerService.getTransportConfig(smtpId))?.password, 'reenc-smtp-pw');
    const opened = await notificationService.getChannelById(chId);
    assert.equal(opened?.config.secret, 'reenc-secret');

    // Every plugin with a credential has at least one sealed field.
    for (const type of ['webhook', 'discord', 'slack', 'teams', 'telegram', 'gotify', 'ntfy', 'pushover', 'freemobile']) {
      assert.ok(secretFieldsFor(type).length > 0, type);
    }
    assert.ok(secretFieldsFor('pushover').includes('userKey'));
    assert.ok(secretFieldsFor('telegram').includes('botToken'));
  });

  lotIt('W12-5', '93.6 an undecryptable secret is refused at send time', async () => {
    // Envelope sealed with a key the server does not have.
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update('foreign-secret', 'utf-8'), cipher.final()]);
    const foreign = `${SECRET_ENVELOPE_PREFIX}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
    const id = await insertLegacyChannel('w125-foreign', { url: `${sinkUrl}/w125-foreign`, secret: foreign });

    hits.length = 0;
    await assert.rejects(() => notificationService.testChannel(id), /cannot be decrypted/);
    assert.equal(hits.length, 0);
    const log = await h.db('notification_log').where({ channel_id: id }).first();
    assert.equal(log?.success, false);

    // The owner's form keeps the stored envelope instead of sealing it twice.
    const c = await h.adminIn(2);
    const seen = await c.get(`/api/notifications/channels/${id}`);
    assert.equal(seen.status, 200, seen.text);
    assert.equal((await c.put(`/api/notifications/channels/${id}`, { config: seen.json.data.config })).status, 200);
    assert.equal((await rawChannel(id)).secret, foreign);
  });

  lotIt('W12-5', '93.7 an SMTP channel sends with the decrypted server password', async () => {
    const c = await h.adminIn(2);
    const created = await c.post('/api/admin/smtp-servers', {
      name: 'w125-smtp-ch', host: 'smtp-ch.verify.invalid', port: 587, secure: false,
      username: 'ch', password: 'smtp-channel-pw', fromAddress: 'ch@verify.test',
    });
    assert.equal(created.status, 201, created.text);
    const ch = await c.post('/api/notifications/channels', {
      name: 'w125-mail', type: 'smtp', config: { smtpServerId: created.json.data.id, to: 'ops@verify.test' },
    });
    assert.equal(ch.status, 201, ch.text);
    transports.length = 0;
    const t = await c.post(`/api/notifications/channels/${ch.json.data.id}/test`);
    assert.equal(t.status, 200, t.text);
    assert.deepEqual(transports.map((x) => [x.host, x.pass]), [['smtp-ch.verify.invalid', 'smtp-channel-pw']]);
  });
});
