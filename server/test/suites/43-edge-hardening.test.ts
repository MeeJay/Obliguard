/**
 * 43 — W1-4 edge and bootstrap hardening:
 *   - utils/clientIp: X-Forwarded-For walked from the right, a forged
 *     left-most entry is ignored, the hop cap holds; the agent push and the
 *     agent WS gate record the resolved address, not the forged one;
 *   - utils/crypto: CREDENTIAL_ENCRYPTION_KEY round-trip, fallback decryption
 *     of values encrypted under SESSION_SECRET / PREVIOUS_SESSION_SECRET;
 *   - config: the production guard refuses missing, short and published
 *     session secrets (the exported assert, never process.exit);
 *   - ensureDefaultAdmin: weak-password detection and the Default membership;
 *   - deployment files: XFF on every nginx proxy location, SPA security
 *     headers, CSP script hashes in sync with client/index.html, no working
 *     default SESSION_SECRET in the compose files.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { startHarness, waitFor } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createKey } from '../seed';
import {
  clientIp,
  compileTrustedProxies,
  normalizeIp,
  resolveClient,
  resolveClientIp,
} from '../../src/utils/clientIp';
import { encryptSecret, decryptSecret } from '../../src/utils/crypto';
import {
  config,
  assertProductionSecrets,
  productionSecretProblem,
  KNOWN_DEFAULT_SESSION_SECRETS,
} from '../../src/config';
import { authService, isWeakBootstrapPassword } from '../../src/services/auth.service';
import { SPA_INLINE_SCRIPT_HASHES } from '../../src/app';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const uniqUuid = (p: string) => `${p}-${crypto.randomBytes(6).toString('hex')}`;

// Docker-like topology: the client container's nginx is in 172.16/12.
const TRUSTED = compileTrustedProxies('loopback, 172.16.0.0/12');
const NGINX = '172.18.0.5';

describe('43 edge and bootstrap hardening (W1-4)', () => {
  // ── clientIp (pure) ────────────────────────────────────────────────────────

  lotIt('W1-4', '43.1 a forged left-most X-Forwarded-For is ignored with 1 trusted hop', () => {
    // nginx appended the real peer (203.0.113.7) after the client-written value.
    assert.equal(resolveClientIp(NGINX, '6.6.6.6, 203.0.113.7', TRUSTED, 1), '203.0.113.7');
    // Even a forged chain of "trusted-looking" addresses stops at the cap.
    assert.equal(resolveClientIp(NGINX, '6.6.6.6, 172.18.0.9, 203.0.113.7', TRUSTED, 1), '203.0.113.7');
    // Header split over several lines is one list.
    assert.equal(resolveClientIp(NGINX, ['6.6.6.6', '203.0.113.7'], TRUSTED, 1), '203.0.113.7');
  });

  lotIt('W1-4', '43.2 right-to-left walk: edge proxy, hop cap, untrusted peer, malformed entries', () => {
    const withEdge = compileTrustedProxies('loopback, 172.16.0.0/12, 192.168.1.10');
    // edge proxy (trusted) -> nginx (trusted) -> client
    assert.equal(resolveClientIp(NGINX, '6.6.6.6, 198.51.100.4, 192.168.1.10', withEdge, 2), '198.51.100.4');
    // The edge only sees a Docker gateway: the cap (2) stops before the forged part.
    assert.equal(resolveClientIp(NGINX, '6.6.6.6, 172.17.0.1', TRUSTED, 2), '6.6.6.6');
    assert.equal(resolveClientIp(NGINX, '6.6.6.6, 172.17.0.1', TRUSTED, 1), '172.17.0.1');
    // An untrusted socket peer never gets its X-Forwarded-For honoured.
    assert.equal(resolveClientIp('203.0.113.9', '1.1.1.1', TRUSTED, 2), '203.0.113.9');
    // No header: the socket address, IPv4-mapped prefix stripped.
    assert.equal(resolveClientIp('::ffff:198.51.100.20', undefined, TRUSTED, 2), '198.51.100.20');
    // A malformed hop stops the walk at the last valid address, flagged relay.
    const bad = resolveClient(NGINX, '6.6.6.6, not-an-ip', TRUSTED, 2);
    assert.equal(bad.ip, NGINX);
    assert.equal(bad.relay, true);
    // Ports and zone ids are stripped.
    assert.equal(normalizeIp('[2001:db8::1]:443'), '2001:db8::1');
    assert.equal(normalizeIp('198.51.100.1:5678'), '198.51.100.1');
    assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
    // A loose prefix must never turn into /0.
    assert.throws(() => compileTrustedProxies('10.0.0.0/'));
    assert.throws(() => compileTrustedProxies('nonsense'));
  });

  lotIt('W1-4', '43.3 clientIp(req) uses the process configuration (loopback trusted by default)', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.4' } };
    assert.equal(clientIp(req as never), '198.51.100.4');
  });

  // ── crypto ────────────────────────────────────────────────────────────────

  lotIt('W1-4', '43.4 credential encryption: dedicated key, session-secret fallback, previous secret', () => {
    const saved = {
      sessionSecret: config.sessionSecret,
      credentialEncryptionKey: config.credentialEncryptionKey,
      previousSessionSecret: config.previousSessionSecret,
    };
    try {
      config.credentialEncryptionKey = undefined;
      config.previousSessionSecret = undefined;
      const legacy = encryptSecret('mikrotik-password');
      assert.equal(decryptSecret(legacy), 'mikrotik-password');

      // A dedicated key encrypts new values and still reads the legacy ones.
      config.credentialEncryptionKey = crypto.randomBytes(32).toString('hex');
      const current = encryptSecret('m365-private-key');
      assert.equal(decryptSecret(current), 'm365-private-key');
      assert.equal(decryptSecret(legacy), 'mikrotik-password');
      assert.notEqual(current.split(':')[2], encryptSecret('m365-private-key').split(':')[2], 'fresh IV per value');

      // Without the dedicated key, values written under it are unreadable.
      const key = config.credentialEncryptionKey;
      config.credentialEncryptionKey = undefined;
      assert.throws(() => decryptSecret(current));
      config.credentialEncryptionKey = key;

      // Session secret rotation: PREVIOUS_SESSION_SECRET keeps old values readable.
      config.credentialEncryptionKey = undefined;
      config.sessionSecret = 'old-secret-'.padEnd(40, 'x');
      const underOld = encryptSecret('rotated');
      config.sessionSecret = 'new-secret-'.padEnd(40, 'y');
      assert.throws(() => decryptSecret(underOld));
      config.previousSessionSecret = 'old-secret-'.padEnd(40, 'x');
      assert.equal(decryptSecret(underOld), 'rotated');

      // Tampering is still detected (GCM tag) with every candidate key.
      const [iv, tag, enc] = underOld.split(':');
      const flipped = (parseInt(enc.slice(0, 2), 16) ^ 1).toString(16).padStart(2, '0') + enc.slice(2);
      assert.throws(() => decryptSecret(`${iv}:${tag}:${flipped}`));
      assert.throws(() => decryptSecret('garbage'));
    } finally {
      Object.assign(config, saved);
    }
  });

  // ── production guard ──────────────────────────────────────────────────────

  lotIt('W1-4', '43.5 production refuses missing, short and published session secrets', () => {
    const strong = crypto.randomBytes(32).toString('hex');
    assert.doesNotThrow(() => assertProductionSecrets('production', strong));
    assert.throws(() => assertProductionSecrets('production', undefined), /not set/);
    assert.throws(() => assertProductionSecrets('production', ''), /not set/);
    assert.throws(() => assertProductionSecrets('production', 'a'.repeat(31)), /shorter than 32/);
    for (const published of ['dev-secret-change-me', 'change-this-in-production', 'change-this-to-a-random-secret']) {
      assert.ok(KNOWN_DEFAULT_SESSION_SECRETS.includes(published));
      assert.throws(() => assertProductionSecrets('production', published), /published default/);
    }
    // Dev and test keep the friendly default.
    assert.equal(productionSecretProblem('development', undefined), null);
    assert.equal(productionSecretProblem('test', 'dev-secret-change-me'), null);
  });

  lotIt('W1-4', '43.5b the guard is wired: loading the session module in production with a weak secret exits 1', () => {
    // Child process: the guard runs at import of session.ts (before migrations
    // and listen) and must stop the process, not just log.
    const sessionModule = path.join(REPO, 'server', 'src', 'session.ts');
    for (const secret of ['change-this-in-production', 'too-short-secret', '']) {
      const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', `require(${JSON.stringify(sessionModule)})`], {
        cwd: path.join(REPO, 'server'),
        env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: secret },
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(r.status, 1, `SESSION_SECRET="${secret}": exit ${r.status} ${r.stderr ?? ''}`);
      assert.match(r.stdout + r.stderr, /Refusing to start/);
    }
  });

  // ── deployment files ──────────────────────────────────────────────────────

  lotIt('W1-4', '43.6 nginx: X-Forwarded-For appended on every proxied location, SPA security headers', () => {
    // Comments stripped: they mention locations too.
    const conf = read('client/nginx.conf').replace(/\r\n/g, '\n').replace(/#[^\n]*/g, '');
    const blocks = [...conf.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)].map((m) => ({ loc: m[1].trim(), body: m[2] }));
    const proxied = blocks.filter((b) => /proxy_pass\s/.test(b.body));
    for (const loc of ['/api/', '/api/agent/', '/socket.io/', '/health', '/auth/']) {
      assert.ok(proxied.some((b) => b.loc === loc), `location ${loc} is proxied`);
    }
    for (const b of proxied) {
      assert.match(b.body, /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/, `${b.loc}: X-Forwarded-For`);
      assert.match(b.body, /proxy_set_header\s+X-Real-IP\s+\$remote_addr;/, `${b.loc}: X-Real-IP`);
      assert.doesNotMatch(b.body, /X-Forwarded-For\s+\$http_x_forwarded_for/, `${b.loc}: never pass the client header as is`);
    }
    // Every SPA location carries the full header set (add_header is not inherited).
    const spa = blocks.filter((b) => !/proxy_pass\s/.test(b.body));
    assert.ok(spa.length >= 3, 'SPA locations: /, /index.html, static assets');
    const indexHtml = read('client/index.html');
    const inline = /<script>([\s\S]*?)<\/script>/.exec(indexHtml);
    assert.ok(inline, 'client/index.html inline theme script');
    const lf = inline[1].replace(/\r\n/g, '\n');
    const hashes = [lf, lf.replace(/\n/g, '\r\n')].map((v) => `'sha256-${crypto.createHash('sha256').update(v).digest('base64')}'`);
    for (const b of spa) {
      const csp = /add_header\s+Content-Security-Policy\s+"([^"]+)"\s+always;/.exec(b.body);
      assert.ok(csp, `${b.loc}: Content-Security-Policy`);
      for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", 'connect-src \'self\' ws: wss:']) {
        assert.ok(csp[1].includes(directive), `${b.loc}: CSP ${directive}`);
      }
      for (const h of hashes) assert.ok(csp[1].includes(h), `${b.loc}: CSP allows the inline theme script ${h}`);
      assert.match(b.body, /add_header\s+X-Content-Type-Options\s+"nosniff"\s+always;/, `${b.loc}: nosniff`);
      assert.match(b.body, /add_header\s+Referrer-Policy\s+"strict-origin-when-cross-origin"\s+always;/, `${b.loc}: Referrer-Policy`);
      assert.match(b.body, /add_header\s+X-Frame-Options\s+"DENY"\s+always;/, `${b.loc}: X-Frame-Options`);
    }
    // helmet (server-served SPA) allows the same inline script.
    assert.deepEqual([...SPA_INLINE_SCRIPT_HASHES].sort(), [...hashes].sort());
  });

  lotIt('W1-4', '43.7 compose files ship no working default session secret', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.build.yml', 'docker-compose.external-db.yml']) {
      const text = read(file);
      const line = /^\s*SESSION_SECRET:\s*(.+)$/m.exec(text);
      assert.ok(line, `${file}: SESSION_SECRET`);
      assert.match(line[1], /^\$\{SESSION_SECRET:\?/, `${file}: SESSION_SECRET is required`);
      for (const published of KNOWN_DEFAULT_SESSION_SECRETS) assert.ok(!text.includes(published), `${file}: ${published}`);
      assert.ok(!/DEFAULT_ADMIN_PASSWORD:\s*\$\{DEFAULT_ADMIN_PASSWORD:-admin123\}/.test(text), `${file}: no admin123 default`);
    }
    const example = read('.env.example');
    assert.match(example, /^SESSION_SECRET=\s*$/m);
    assert.match(example, /TRUSTED_PROXY_HOPS/);
    assert.match(example, /CREDENTIAL_ENCRYPTION_KEY/);
  });

  lotIt('W1-4', '43.8 weak bootstrap passwords are detected', () => {
    assert.equal(isWeakBootstrapPassword('admin123'), true);
    assert.equal(isWeakBootstrapPassword('short-pw-11'), true);
    assert.equal(isWeakBootstrapPassword('a-long-enough-pw'), false);
  });
});

describe('43 edge hardening with the harness (W1-4)', () => {
  let h: Harness;
  const sockets: WebSocket[] = [];
  before(async () => { h = await startHarness(); });
  after(async () => {
    for (const s of sockets) { try { s.terminate(); } catch { /* ignore */ } }
    await h.close();
  });

  const pushPayload = { hostname: 'edge', agentVersion: '1.0.0', osInfo: { platform: 'linux' }, services: [], events: [], firewallBanned: [], firewallName: 'verify', lanIPs: [] };

  lotIt('W1-4', '43.9 agent push records the right-most untrusted hop, not a forged left-most one', async () => {
    const k = await createKey(h.db, 2);
    const uuid = uniqUuid('edge-push');
    // The harness reaches the server from loopback (trusted, like the client
    // container's nginx): the right-most entry is what nginx appended.
    const r = await h.anon().post('/api/agent/push', pushPayload, {
      headers: { 'x-api-key': k.key, 'x-device-uuid': uuid, 'x-forwarded-for': '6.6.6.6, 198.51.100.77' },
    });
    assert.ok(r.status === 202 || r.status === 200, `push status ${r.status}`);
    const row = await h.db('agent_devices').where({ uuid }).first();
    assert.ok(row, 'pending row created');
    assert.equal(row.ip, '198.51.100.77');
  });

  lotIt('W1-4', '43.10 agent WS gate records the right-most untrusted hop', async () => {
    const k = await createKey(h.db, 2);
    const uuid = uniqUuid('edge-ws');
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/agent/ws?uuid=${encodeURIComponent(uuid)}`, {
      headers: { 'x-api-key': k.key, 'x-forwarded-for': '6.6.6.6, 198.51.100.78' },
    });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws open timeout')), 3000);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); reject(new Error(`refused ${res.statusCode}`)); });
      ws.on('error', () => { /* reported above */ });
    });
    ws.send(JSON.stringify({ type: 'heartbeat', hostname: 'edge-ws', agentVersion: '1.0.0', services: [], firewallBanned: [], lanIPs: [] }));
    const row = await waitFor(async () => h.db('agent_devices').where({ uuid }).first(), 3000);
    assert.equal(row.ip, '198.51.100.78');
  });

  lotIt('W1-4', '43.11 ensureDefaultAdmin creates the bootstrap admin with a Default membership', async () => {
    // Fresh-database situation: no admin left (the suite database is disposable).
    await h.db('users').where({ role: 'admin' }).update({ role: 'user' });
    const username = `boot-${crypto.randomBytes(3).toString('hex')}`;
    await authService.ensureDefaultAdmin(username, 'a-long-bootstrap-password');
    const user = await h.db('users').where({ username }).first();
    assert.ok(user);
    assert.equal(user.role, 'admin');
    const membership = await h.db('user_tenants').where({ user_id: user.id, tenant_id: 1 }).first();
    assert.ok(membership, 'Default membership');
    assert.equal(membership.role, 'admin');
    // Idempotent: an admin exists now, nothing else is created.
    await authService.ensureDefaultAdmin(`${username}-2`, 'admin123');
    assert.equal(await h.db('users').where({ username: `${username}-2` }).first(), undefined);
  });
});
