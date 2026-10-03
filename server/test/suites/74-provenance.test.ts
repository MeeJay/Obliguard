/**
 * 74 — W9-1 ban provenance v2 (BROKEN-15, owner decisions 6, 7, 17):
 *   - imported addresses become global 'remote' bans tagged with origin_ref
 *     ('blocklist:<id>', 'mikrotik:<deviceId>'), never 'auto';
 *   - a remote list creates bans only while it enforces (new lists start off;
 *     turning enforce off, disabling an entry or the source dropping it lifts
 *     the ban as 'remote_sync', which sets no BanEngine lift watermark);
 *   - the MikroTik import skips whitelisted entries (containment) and
 *     evaluate-only routers, and does not undo an operator Lift;
 *   - remote / external / MikroTik bans are never pushed to obli.tools;
 *   - MikroTik API-SSL pinning (TOFU): the verifier refuses a mismatch, the
 *     admin reset clears the pin.
 *
 * Outbound fetches are stubbed in-test on top of the harness network guard;
 * list URLs use 2001:db8:74::/48 literals (no DNS needed).
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import crypto from 'crypto';
import tls from 'tls';
import forge from 'node-forge';
import path from 'path';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createGroup, createMikrotikDevice, insertBan, insertWhitelist, litIp, nextIp } from '../seed';
import { batchImportIPs } from '../../src/services/mikrotik/mikrotikImport.service';
import type { ImportDevice } from '../../src/services/mikrotik/mikrotikImport.service';
import { mikrotikDeviceService } from '../../src/services/mikrotik/mikrotikDevice.service';
import { remoteBlocklistService } from '../../src/services/remoteBlocklist.service';
import {
  RouterOSClient,
  createRouterOSClient,
  normalizeFingerprint,
  verifyPinnedFingerprint,
  TlsFingerprintMismatchError,
  TLS_FINGERPRINT_MISMATCH_PREFIX,
} from '../../src/services/mikrotik/routerosClient';

const LIST_URL = (n: number) => `https://[${litIp('2001:db8', 0x74, n)}]/list.txt`;
const PUSH_URL = 'https://guard.obli.tools/';
const FP_A = 'AB:'.repeat(31) + 'AB';
const FP_B = 'CD:'.repeat(31) + 'CD';

type FetchStub = (url: string, init: RequestInit | undefined) => Response | null;

interface BanRowLite { id: number; ban_type: string; origin_ref: string | null; is_active: boolean; lift_reason: string | null; reason: string | null }

describe('74 ban provenance (W9-1)', () => {
  let h: Harness;
  let stub: FetchStub | null = null;
  let harnessFetch: typeof fetch;
  // Routers are spied: no socket is opened by the fire-and-forget pushes.
  const proto = RouterOSClient.prototype as any;
  const savedProto: Record<string, unknown> = {};
  before(async () => {
    h = await startHarness();
    for (const m of ['connect', 'login', 'banIP', 'unbanIP', 'close']) savedProto[m] = proto[m];
    proto.connect = async () => { /* spy */ };
    proto.login = async () => { /* spy */ };
    proto.banIP = async () => { /* spy */ };
    proto.unbanIP = async () => { /* spy */ };
    proto.close = () => { /* spy */ };
    harnessFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      const r = stub?.(String(url), init) ?? null;
      if (r) return r;
      return harnessFetch(input, init);
    }) as typeof fetch;
  });
  after(async () => {
    for (const [m, fn] of Object.entries(savedProto)) proto[m] = fn;
    globalThis.fetch = harnessFetch;
    await h.close();
  });

  const bansOf = (ip: string) =>
    h.db('ip_bans').whereRaw('host(ip) = ?', [ip]).orderBy('id') as Promise<BanRowLite[]>;
  const activeOf = async (ip: string) => (await bansOf(ip)).filter((b) => b.is_active);

  async function syncWith(listId: number, url: string, ips: string[]): Promise<void> {
    stub = (u) => (u === url ? new Response(ips.join('\n'), { status: 200 }) : null);
    try {
      const r = await (await h.adminIn(1)).post(`/api/remote-blocklists/${listId}/sync`);
      assert.equal(r.status, 200, r.text);
    } finally { stub = null; }
  }

  function importDevice(deviceId: number, tenantId: number): ImportDevice {
    return { deviceId, tenantId, apiHost: 'x', apiPort: 0, apiUseTls: false, apiUsername: 'x', apiPasswordEnc: 'x', importLists: [] };
  }

  lotIt('W9-1', '74.1 a new list does not enforce: its entries are listed, no ban is created', async () => {
    const admin = await h.adminIn(1);
    const created = await admin.post('/api/remote-blocklists', { name: 'verify-74-off', sourceType: 'url', url: LIST_URL(1) });
    assert.equal(created.status, 201, created.text);
    const id = created.json.data.id as number;
    assert.equal(created.json.data.enforce, false);
    assert.equal((await h.db('remote_blocklists').where({ id }).first()).enforce, false);

    const a = nextIp();
    const b = nextIp();
    await syncWith(id, LIST_URL(1), [a, b]);
    assert.equal(Number((await h.db('remote_blocked_ips').where({ blocklist_id: id }).count<{ c: string }[]>({ c: '*' }))[0].c), 2);
    assert.deepEqual(await activeOf(a), []);
    assert.deepEqual(await activeOf(b), []);

    const ips = await admin.get(`/api/remote-blocklists/ips?blocklistId=${id}`);
    assert.equal(ips.status, 200);
    for (const row of ips.json.data as Array<{ listEnforce: boolean; enforced: boolean }>) {
      assert.equal(row.listEnforce, false);
      assert.equal(row.enforced, false);
    }
    // Explicit opt-in at creation, type-checked.
    assert.equal((await admin.post('/api/remote-blocklists', { name: 'x', sourceType: 'url', url: LIST_URL(2), enforce: 'yes' })).status, 400);
  });

  lotIt('W9-1', '74.2 enforce on creates remote bans; entry disable, source drop and enforce off lift them (remote_sync)', async () => {
    const admin = await h.adminIn(1);
    const created = await admin.post('/api/remote-blocklists', { name: 'verify-74-on', sourceType: 'url', url: LIST_URL(3) });
    const id = created.json.data.id as number;
    const ref = `blocklist:${id}`;
    const a = nextIp();
    const b = nextIp();
    const c = nextIp();
    const covered = nextIp();
    await insertBan(h.db, { ip: covered, banType: 'manual', originTenantId: 1 });
    await syncWith(id, LIST_URL(3), [a, b, c, covered]);
    assert.deepEqual(await activeOf(a), []);

    // Turning enforcement on bans the synced entries at once.
    const on = await admin.put(`/api/remote-blocklists/${id}`, { enforce: true });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.data.enforce, true);
    for (const ip of [a, b, c]) {
      const act = await activeOf(ip);
      assert.equal(act.length, 1, ip);
      assert.equal(act[0].ban_type, 'remote');
      assert.equal(act[0].origin_ref, ref);
    }
    // Already banned globally: no second row.
    const cov = await activeOf(covered);
    assert.equal(cov.length, 1);
    assert.equal(cov[0].ban_type, 'manual');

    // The ban list exposes the provenance (god view).
    const bans = await admin.get(`/api/bans?search=${a}`);
    assert.equal(bans.status, 200, bans.text);
    const shown = (bans.json.data as Array<{ ip: string; banType: string; originRef: string | null }>).find((x) => String(x.ip).startsWith(a));
    assert.equal(shown?.banType, 'remote');
    assert.equal(shown?.originRef, ref);

    // Disabling the entry lifts its ban.
    const entry = await h.db('remote_blocked_ips').where({ blocklist_id: id }).whereRaw('host(ip) = ?', [a]).first('id');
    assert.equal((await admin.put(`/api/remote-blocklists/ips/${entry.id}/toggle`, { enabled: false })).status, 200);
    assert.deepEqual(await activeOf(a), []);
    const liftedA = (await bansOf(a)).at(-1)!;
    assert.equal(liftedA.lift_reason, 'remote_sync');

    // The source drops b: entry removed, ban lifted.
    await syncWith(id, LIST_URL(3), [a, c, covered]);
    assert.deepEqual(await activeOf(b), []);
    assert.equal((await h.db('remote_blocked_ips').where({ blocklist_id: id }).whereRaw('host(ip) = ?', [b])).length, 0);
    assert.equal((await activeOf(c)).length, 1);

    // Enforcement off: every ban of the list goes, the manual one stays.
    assert.equal((await admin.put(`/api/remote-blocklists/${id}`, { enforce: false })).status, 200);
    assert.deepEqual(await activeOf(c), []);
    assert.equal((await activeOf(covered)).length, 1);
    assert.equal(Number((await h.db('ip_bans').where({ origin_ref: ref, is_active: true }).count<{ c: string }[]>({ c: '*' }))[0].c), 0);
    assert.equal((await admin.put(`/api/remote-blocklists/${id}`, { enforce: 'no' })).status, 400);
  });

  lotIt('W9-1', '74.3 an operator Lift of a remote ban disables its entry: the next sync does not bring it back', async () => {
    const admin = await h.adminIn(1);
    const created = await admin.post('/api/remote-blocklists', { name: 'verify-74-lift', sourceType: 'url', url: LIST_URL(4), enforce: true });
    assert.equal(created.status, 201, created.text);
    const id = created.json.data.id as number;
    const a = nextIp();
    await syncWith(id, LIST_URL(4), [a]);
    const [ban] = await activeOf(a);
    assert.equal(ban?.ban_type, 'remote');
    assert.equal((await admin.del(`/api/bans/${ban.id}`)).status, 200);
    assert.equal((await bansOf(a)).at(-1)!.lift_reason, 'lift');
    await syncWith(id, LIST_URL(4), [a]);
    assert.deepEqual(await activeOf(a), []);
    const entry = await h.db('remote_blocked_ips').where({ blocklist_id: id }).whereRaw('host(ip) = ?', [a]).first('enabled');
    assert.equal(entry.enabled, false);

    // Deleting a list lifts its bans.
    const b = nextIp();
    await syncWith(id, LIST_URL(4), [a, b]);
    assert.equal((await activeOf(b)).length, 1);
    assert.equal((await admin.del(`/api/remote-blocklists/${id}`)).status, 200);
    assert.deepEqual(await activeOf(b), []);
  });

  lotIt('W9-1', '74.4 obli.tools pull: only "banned" entries of an enforcing list are banned, as remote', async () => {
    const [list] = await h.db('remote_blocklists').insert({
      name: 'verify-74-oblitools', source_type: 'oblitools', url: 'https://oblitools.verify.invalid/api/delta', api_key: 'k', enabled: false, enforce: false, tenant_id: null,
    }).returning('*');
    const banned = nextIp();
    const suspicious = nextIp();
    const body = JSON.stringify({ ips: { [banned]: { status: 'banned', reports: 3 }, [suspicious]: { status: 'suspicious', reports: 2 } } });
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      await remoteBlocklistService.syncOblitools(list);
      assert.deepEqual(await activeOf(banned), [], 'not enforcing: nothing banned');
      // The stored flag decides, not the sync's copy of the row: a sync that
      // started before enforcement was turned off bans nothing.
      await remoteBlocklistService.syncOblitools({ ...list, enforce: true });
      assert.deepEqual(await activeOf(banned), [], 'stale enforce=true copy: nothing banned');
      await h.db('remote_blocklists').where({ id: list.id }).update({ enforce: true });
      await remoteBlocklistService.syncOblitools(list);
    } finally {
      globalThis.fetch = saved;
    }
    const [row] = await activeOf(banned);
    assert.equal(row?.ban_type, 'remote');
    assert.equal(row?.origin_ref, `blocklist:${list.id}`);
    assert.match(String(row?.reason), /^obli\.tools:/);
    assert.deepEqual(await activeOf(suspicious), []);
    const st = await h.db('remote_blocked_ips').where({ blocklist_id: list.id }).whereRaw('host(ip) = ?', [suspicious]).first('status');
    assert.equal(st.status, 'suspicious');
  });

  lotIt('W9-1', '74.5 MikroTik import: whitelisted entries (containment) and evaluate-only routers create nothing; others are remote, tagged by router', async () => {
    const dev = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: 'mt-74a.verify.invalid' });
    const ok = nextIp();
    const wlHost = nextIp();
    const wlNet = litIp('2001:db8', 0x74, 0x50);
    const tenantWl = nextIp();
    await insertWhitelist(h.db, { ip: `${wlHost}/32`, scope: 'global' });
    await insertWhitelist(h.db, { ip: '2001:db8:74::/64', scope: 'global' });
    await insertWhitelist(h.db, { ip: `${tenantWl}/32`, scope: 'tenant', tenantId: 2 });

    const n = await batchImportIPs([ok, wlHost, wlNet, tenantWl], 'blacklist', importDevice(dev.id, 2));
    assert.equal(n, 1);
    const [row] = await activeOf(ok);
    assert.equal(row?.ban_type, 'remote');
    assert.equal(row?.origin_ref, `mikrotik:${dev.id}`);
    for (const ip of [wlHost, wlNet, tenantWl]) assert.deepEqual(await bansOf(ip), [], ip);

    // A router in an evaluate-only group (inherited) imports nothing.
    const g = await createGroup(h.db, { tenantId: 2, evaluateOnly: true });
    const evalDev = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: 'mt-74b.verify.invalid' });
    await h.db('agent_devices').where({ id: evalDev.id }).update({ group_id: g });
    const e1 = nextIp();
    assert.equal(await batchImportIPs([e1], 'blacklist', importDevice(evalDev.id, 2)), 0);
    assert.deepEqual(await bansOf(e1), []);
    // Its own flag too.
    const ownDev = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: 'mt-74c.verify.invalid' });
    await h.db('agent_devices').where({ id: ownDev.id }).update({ evaluate_only: true });
    assert.equal(await batchImportIPs([e1], 'blacklist', importDevice(ownDev.id, 2)), 0);
    assert.deepEqual(await bansOf(e1), []);

    // An operator Lift is not undone by the next import of the same router;
    // a duplicate import is a no-op (WHERE NOT EXISTS, no failing ON CONFLICT).
    assert.equal(await batchImportIPs([ok], 'blacklist', importDevice(dev.id, 2)), 0);
    assert.equal((await activeOf(ok)).length, 1);
    assert.equal((await (await h.adminIn(1)).del(`/api/bans/${row.id}`)).status, 200);
    assert.equal(await batchImportIPs([ok], 'blacklist', importDevice(dev.id, 2)), 0);
    assert.deepEqual(await activeOf(ok), []);
  });

  lotIt('W9-1', '74.6 remote, external and MikroTik bans are never pushed to obli.tools; the remote lift watermark is ignored', async () => {
    const setCfg = async (key: string, value: string | null) => {
      if (value === null) await h.db('app_config').where({ key }).del();
      else await h.db('app_config').insert({ key, value }).onConflict('key').merge({ value });
    };
    await setCfg('oblitools_push_enabled', 'true');
    await setCfg('oblitools_api_key', 'verify-74-key');
    await setCfg('oblitools_instance_name', 'verify74');
    await setCfg('oblitools_last_push_at', null);

    const local = nextIp();
    await insertBan(h.db, { ip: local, banType: 'auto', originTenantId: 2 });
    const remote = nextIp();
    const rId = await insertBan(h.db, { ip: remote, banType: 'manual' });
    await h.db('ip_bans').where({ id: rId }).update({ ban_type: 'remote', origin_ref: 'blocklist:999' });
    // A legacy row mislabelled 'auto' but carrying a provenance is not local either.
    const tagged = nextIp();
    const tId = await insertBan(h.db, { ip: tagged, banType: 'auto' });
    await h.db('ip_bans').where({ id: tId }).update({ origin_ref: 'mikrotik:1' });
    const dev = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: 'mt-74d.verify.invalid' });
    const imported = nextIp();
    await batchImportIPs([imported], 'honeypot', importDevice(dev.id, 2));
    const external = nextIp();
    const eId = await insertBan(h.db, { ip: external, banType: 'external' });
    await h.db('ip_bans').where({ id: eId }).update({ origin_app: 'oblihub' });

    let body: any = null;
    stub = (url, init) => {
      if (!url.startsWith(PUSH_URL)) return null;
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ accepted: 1, new: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    let r;
    try {
      r = await (await h.adminIn(1)).post('/api/remote-blocklists/push-now');
    } finally { stub = null; }
    assert.equal(r.status, 200, r.text);
    assert.ok(body, 'no push request was sent');
    const pushed = new Set((body.ips as Array<{ ip: string }>).map((x) => x.ip));
    assert.ok(pushed.has(local));
    for (const ip of [remote, tagged, imported, external]) assert.ok(!pushed.has(ip), `${ip} must not be contributed`);

    // BanEngine watermark: a remote_sync deactivation is not an operator Lift.
    const banSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'services', 'ban.service.ts'), 'utf8');
    assert.match(banSrc, /lb\.lift_reason IS DISTINCT FROM 'remote_sync'/);
  });

  lotIt('W9-1', '74.6b the "already covered by an active global ban" lookup of the imports can use the GiST network index', async () => {
    // Small test tables favour a seq scan (or the scope index): disable the
    // seq scan and leave the scope filter out, to check that the index
    // matches ban.service networkSql() and is usable for >>= at all.
    const plan = await h.db.transaction(async (trx) => {
      await trx.raw('SET LOCAL enable_seqscan = off');
      const r = await trx.raw(
        `EXPLAIN SELECT 1 FROM unnest(?::text[]) AS t(addr)
          WHERE NOT EXISTS (
            SELECT 1 FROM ip_bans b
             WHERE b.is_active = true
               AND set_masklen(b.ip, COALESCE(b.cidr_prefix, masklen(b.ip))) >>= set_masklen(t.addr::inet, 32))`,
        [[nextIp(), nextIp()]],
      ) as { rows: Array<{ 'QUERY PLAN': string }> };
      return r.rows.map((x) => x['QUERY PLAN']).join(' | ');
    });
    assert.match(plan, /idx_ip_bans_active_network_gist/, plan);
  });

  lotIt('W9-1', '74.7 API-SSL pinning: the verifier pins on first use and refuses any mismatch', async () => {
    assert.equal(normalizeFingerprint(FP_A.toLowerCase().replace(/:/g, '')), FP_A);
    assert.equal(normalizeFingerprint('ab-'.repeat(31) + 'ab'), FP_A);
    assert.equal(normalizeFingerprint('zz'), null);
    assert.equal(normalizeFingerprint('AB:CD'), null);
    assert.equal(normalizeFingerprint(null), null);

    assert.deepEqual(verifyPinnedFingerprint([], FP_A), { ok: true, firstUse: true, fingerprint: FP_A });
    assert.deepEqual(verifyPinnedFingerprint([null], FP_A.toLowerCase()), { ok: true, firstUse: true, fingerprint: FP_A });
    assert.deepEqual(verifyPinnedFingerprint([FP_A], FP_A), { ok: true, firstUse: false, fingerprint: FP_A });
    const bad = verifyPinnedFingerprint([FP_A], FP_B);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad, { ok: false, expected: FP_A, presented: FP_B });
    // Every stored pin of the endpoint must match.
    assert.equal(verifyPinnedFingerprint([FP_A, FP_B], FP_A).ok, false);
    // No certificate / garbage is never trusted, even on first use.
    assert.equal(verifyPinnedFingerprint([], undefined).ok, false);
    assert.equal(verifyPinnedFingerprint([], 'not-a-fingerprint').ok, false);

    const err = new TlsFingerprintMismatchError('10.0.0.1:8729', FP_A, FP_B);
    assert.ok(err.message.startsWith(TLS_FINGERPRINT_MISMATCH_PREFIX));
    assert.ok(err.message.includes(FP_A) && err.message.includes(FP_B));
    assert.equal(err.code, 'TLS_FINGERPRINT_MISMATCH');
  });

  lotIt('W9-1', '74.8 the pin is exposed, a mismatch is flagged, and the admin reset (or an endpoint change) clears it', async () => {
    const dev = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: 'mt-74e.verify.invalid' });
    await h.db('mikrotik_credentials').where({ device_id: dev.id }).update({
      tls_fingerprint: FP_A,
      last_api_error: new TlsFingerprintMismatchError('mt-74e:8729', FP_A, FP_B).message,
    });
    let creds = await mikrotikDeviceService.getCredentials(dev.id);
    assert.equal(creds?.tlsFingerprint, FP_A);
    assert.equal(creds?.tlsFingerprintMismatch, true);

    // An unrelated update keeps the pin.
    await mikrotikDeviceService.updateCredentials(dev.id, { addressListName: 'verify74' });
    assert.equal((await mikrotikDeviceService.getCredentials(dev.id))?.tlsFingerprint, FP_A);

    await mikrotikDeviceService.updateCredentials(dev.id, { resetTlsFingerprint: true });
    creds = await mikrotikDeviceService.getCredentials(dev.id);
    assert.equal(creds?.tlsFingerprint, null);
    assert.equal(creds?.tlsFingerprintMismatch, false);
    assert.equal(creds?.lastApiError, null);

    await h.db('mikrotik_credentials').where({ device_id: dev.id }).update({ tls_fingerprint: FP_B });
    await mikrotikDeviceService.updateCredentials(dev.id, { apiHost: 'mt-74e-new.verify.invalid' });
    assert.equal((await mikrotikDeviceService.getCredentials(dev.id))?.tlsFingerprint, null);
  });

  lotIt('W9-1', '74.9 real API-SSL handshake: first use pins after login, another certificate is refused before any credential is sent', async () => {
    /** Self-signed certificate (the RouterOS default), RSA key generated natively. */
    const selfSigned = (cn: string): { key: string; cert: string; fp: string } => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
      const c = forge.pki.createCertificate();
      c.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }) as string);
      c.serialNumber = crypto.randomBytes(8).toString('hex').replace(/^[89a-f]/, '1');
      c.validity.notBefore = new Date(Date.now() - 60_000);
      c.validity.notAfter = new Date(Date.now() + 86_400_000);
      c.setSubject([{ name: 'commonName', value: cn }]);
      c.setIssuer([{ name: 'commonName', value: cn }]);
      c.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
      const cert = forge.pki.certificateToPem(c);
      return { key: keyPem, cert, fp: new crypto.X509Certificate(cert).fingerprint256 };
    };
    /** Fake RouterOS API-SSL: records every byte received, answers each sentence with `reply`. */
    const fakeRouter = async (pair: { key: string; cert: string }, reply: string[]) => {
      const received: Buffer[] = [];
      const sentence = Buffer.concat([...reply.map((w) => Buffer.concat([Buffer.from([w.length]), Buffer.from(w)])), Buffer.from([0])]);
      const server = tls.createServer({ key: pair.key, cert: pair.cert }, (sock) => {
        sock.on('data', (d) => { received.push(d); sock.write(sentence); });
        sock.on('error', () => { /* client hang-up */ });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      return {
        port,
        received: () => Buffer.concat(received).toString('latin1'),
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    };
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 100));

    const certA = selfSigned('router-a');
    const certB = selfSigned('router-b');
    assert.notEqual(certA.fp, certB.fp);
    const dev = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: '127.0.0.1' });
    const pinOf = async () => (await h.db('mikrotik_credentials').where({ device_id: dev.id }).first('tls_fingerprint')).tls_fingerprint as string | null;
    const cfg = (port: number) => ({ host: '127.0.0.1', port, useTls: true, username: 'admin', password: 'secret-74-pw', deviceId: dev.id });

    // The suite spies connect/login (no router sockets): the real ones here.
    const spied = { connect: proto.connect, login: proto.login, close: proto.close };
    proto.connect = savedProto.connect;
    proto.login = savedProto.login;
    proto.close = savedProto.close;
    try {
      // A login refused by the router: nothing is pinned.
      const trap = await fakeRouter(certA, ['!trap', '=message=invalid user name or password (6)']);
      await h.db('mikrotik_credentials').where({ device_id: dev.id }).update({ api_port: trap.port, api_use_tls: true });
      await assert.rejects(createRouterOSClient(cfg(trap.port)), /Login failed/);
      await trap.close();
      assert.equal(await pinOf(), null);

      // First successful login: the certificate is pinned.
      const a = await fakeRouter(certA, ['!done']);
      const client = await createRouterOSClient(cfg(a.port));
      client.close();
      await a.close();
      assert.ok(a.received().includes('secret-74-pw'), 'the login reached router A');
      assert.equal(await pinOf(), certA.fp);

      // Another certificate: refused at the handshake, no credential sent.
      const b = await fakeRouter(certB, ['!done']);
      await assert.rejects(createRouterOSClient(cfg(b.port)), (err: unknown) => {
        assert.ok(err instanceof TlsFingerprintMismatchError, String(err));
        assert.equal(err.expected, certA.fp);
        assert.equal(err.presented, certB.fp);
        return true;
      });
      await settle();
      await b.close();
      assert.equal(b.received(), '', 'no byte (no credential) reaches a router with another certificate');
      assert.equal(await pinOf(), certA.fp, 'a refused certificate never replaces the pin');

      // Without deviceId (callers keyed by endpoint) the pin of the endpoint applies.
      const b2 = await fakeRouter(certB, ['!done']);
      await h.db('mikrotik_credentials').where({ device_id: dev.id }).update({ api_port: b2.port });
      const { deviceId: _omit, ...byEndpoint } = cfg(b2.port);
      await assert.rejects(createRouterOSClient(byEndpoint), TlsFingerprintMismatchError);
      await settle();
      await b2.close();
      assert.equal(b2.received(), '');
    } finally {
      proto.connect = spied.connect;
      proto.login = spied.login;
      proto.close = spied.close;
    }
  });
});
