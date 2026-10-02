/**
 * 44 — W1-5 delegation-token hardening and the external-bans repair.
 *
 * The suite runs its own Ed25519 signer + JWKS endpoint (full control over
 * every claim, including the ones fakeObligate always stamps) and points the
 * app_config Obligate URL at it, so `iss` is the configured origin exactly as
 * real Obligate stamps it. The harness' fakeObligate is still used once to
 * check the OBLIGATE_ISSUER override for split-URL installs.
 */
import { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { nextIp } from '../seed';
import { OBLIGATE_API_KEY } from '../fixtures';
import { __resetDelegationStateForTest } from '../../src/services/delegationAuth.service';

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

interface Signer {
  url: string;
  jwksFetches: number;
  mint(claims?: Record<string, unknown>, header?: Record<string, unknown>): string;
  close(): Promise<void>;
}

async function startSigner(): Promise<Signer> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'w15-kid', alg: 'EdDSA' };
  const signer = { jwksFetches: 0 } as Signer;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/delegation/jwks') {
      signer.jwksFetches++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  signer.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  signer.mint = (claims = {}, header = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const full: Record<string, unknown> = {
      iss: signer.url, aud: 'obliguard', azp: 'oblihub', sub: 'app:oblihub', ost: 'default', scp: 'bans',
      jti: crypto.randomUUID(), iat: now, nbf: now, exp: now + 120,
      ...claims,
    };
    for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k];
    const h = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'w15-kid', ...header }));
    const p = b64url(JSON.stringify(full));
    return `${h}.${p}.${b64url(crypto.sign(null, Buffer.from(`${h}.${p}`), privateKey))}`;
  };
  signer.close = () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return signer;
}

describe('44 delegation hardening', () => {
  let h: Harness;
  let s: Signer;
  const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
  const ping = (token: string) => h.anon().get('/api/external-bans/ping', auth(token));
  const rowsFor = (ip: string) => h.db('ip_bans').whereRaw('host(ip) = ?', [ip]);
  const pointObligateAt = async (url: string) => {
    const value = JSON.stringify({ url, apiKey: OBLIGATE_API_KEY });
    await h.db('app_config').insert({ key: 'obligate_config', value }).onConflict('key').merge({ value });
    __resetDelegationStateForTest();
  };

  before(async () => {
    h = await startHarness({ obligate: true });
    s = await startSigner();
  });
  after(async () => {
    delete process.env.OBLIGATE_ISSUER;
    delete process.env.EXTERNAL_BAN_MAX_SECONDS;
    await s.close();
    await h.close();
  });
  beforeEach(async () => {
    delete process.env.OBLIGATE_ISSUER;
    delete process.env.EXTERNAL_BAN_MAX_SECONDS;
    await pointObligateAt(s.url);
  });

  lotIt('A11', '44.1 a well-formed token pings', async () => {
    const r = await ping(s.mint());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.sourceApp, 'oblihub');
  });

  lotIt('A11', '44.2 iat / nbf / exp are required integers', async () => {
    for (const missing of ['exp', 'iat', 'nbf'] as const) {
      const r = await ping(s.mint({ [missing]: undefined }));
      assert.equal(r.status, 401, missing);
      assert.equal(r.json?.code, 'payload_invalid', missing);
    }
    const now = Math.floor(Date.now() / 1000);
    const r = await ping(s.mint({ exp: String(now + 60) }));
    assert.equal(r.status, 401);
    assert.equal(r.json?.code, 'payload_invalid');
  });

  lotIt('A11', '44.3 lifetime above 300 s is refused', async () => {
    const now = Math.floor(Date.now() / 1000);
    const r = await ping(s.mint({ iat: now, exp: now + 3600 }));
    assert.equal(r.status, 401);
    assert.equal(r.json?.code, 'lifetime_excessive');
    const ok = await ping(s.mint({ iat: now, exp: now + 300 }));
    assert.equal(ok.status, 200);
  });

  lotIt('A11', '44.4 iss must be the configured Obligate origin (OBLIGATE_ISSUER override)', async () => {
    for (const iss of ['https://evil.example', 'fake-obligate', undefined]) {
      const r = await ping(s.mint({ iss }));
      assert.equal(r.status, 401, String(iss));
      assert.equal(r.json?.code, 'wrong_issuer', String(iss));
    }
    // Trailing slash on the stamped issuer is tolerated.
    assert.equal((await ping(s.mint({ iss: `${s.url}/` }))).status, 200);
    // Split-URL install: the operator names the public issuer explicitly.
    process.env.OBLIGATE_ISSUER = 'https://gate.example.com';
    assert.equal((await ping(s.mint({ iss: 'https://gate.example.com' }))).status, 200);
    const internal = await ping(s.mint());
    assert.equal(internal.status, 401);
    assert.equal(internal.json?.code, 'wrong_issuer');
  });

  lotIt('A11', '44.5 the harness fakeObligate verifies with its issuer named explicitly', async () => {
    await pointObligateAt(h.obligate!.url);
    const token = h.obligate!.mintDelegation({ sub: 'app:oblihub' });
    const iss = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).iss as string;
    if (iss !== h.obligate!.url) process.env.OBLIGATE_ISSUER = iss;
    const r = await ping(token);
    assert.equal(r.status, 200, r.text);
  });

  lotIt('A11', '44.6 aud must be a plain string equal to obliguard', async () => {
    const arr = await ping(s.mint({ aud: ['obliguard'] }));
    assert.equal(arr.status, 403);
    assert.equal(arr.json?.code, 'wrong_audience');
    const other = await ping(s.mint({ aud: 'obliance' }));
    assert.equal(other.status, 403);
    assert.equal(other.json?.code, 'wrong_audience');
  });

  lotIt('A11', '44.7 jti, azp and typ formats', async () => {
    const cases: Array<[string, string, string]> = [
      ['jti not a uuid', s.mint({ jti: 'abc' }), 'jti_invalid'],
      ['azp missing', s.mint({ azp: undefined }), 'azp_invalid'],
      ['azp malformed', s.mint({ azp: 'Obli Hub!' }), 'azp_invalid'],
      ['typ missing', s.mint({}, { typ: undefined }), 'typ_invalid'],
      ['typ other', s.mint({}, { typ: 'at+jwt' }), 'typ_invalid'],
      ['alg none', s.mint({}, { alg: 'none' }), 'malformed_token'],
    ];
    for (const [label, token, code] of cases) {
      const r = await ping(token);
      assert.equal(r.status, 401, label);
      assert.equal(r.json?.code, code, label);
    }
  });

  lotIt('A11', '44.8 a replayed jti is refused, a refused token does not burn its jti', async () => {
    const token = s.mint();
    assert.equal((await ping(token)).status, 200);
    const again = await ping(token);
    assert.equal(again.status, 401);
    assert.equal(again.json?.code, 'replayed');
    // Same jti, first presented with a wrong audience (refused), then legitimately.
    const jti = crypto.randomUUID();
    assert.equal((await ping(s.mint({ jti, aud: 'obliance' }))).status, 403);
    assert.equal((await ping(s.mint({ jti }))).status, 200);
  });

  lotIt('A11', '44.9 unknown kids trigger at most one JWKS fetch per 30 s', async () => {
    const before = s.jwksFetches;
    for (let i = 0; i < 2; i++) {
      const r = await ping(s.mint({}, { kid: `random-${crypto.randomUUID()}` }));
      assert.equal(r.status, 401);
      assert.equal(r.json?.code, 'kid_unknown');
    }
    assert.equal(s.jwksFetches - before, 1);
    // A known kid keeps verifying from the cache while refetches are rate-limited.
    assert.equal((await ping(s.mint())).status, 200);
    assert.equal(s.jwksFetches - before, 1);
  });

  lotIt('A11', '44.10 Obligate disabled or unset answers 503 not_configured', async () => {
    await h.db('app_config').where({ key: 'obligate_enabled' }).update({ value: 'false' });
    __resetDelegationStateForTest();
    try {
      const r = await ping(s.mint());
      assert.equal(r.status, 503);
      assert.equal(r.json?.code, 'not_configured');
    } finally {
      await h.db('app_config').where({ key: 'obligate_enabled' }).update({ value: 'true' });
      __resetDelegationStateForTest();
    }
  });

  lotIt('A11', '44.11 POST no longer 500s; duration capped; DELETE withdraws without 42703', async () => {
    const ip = nextIp();
    const created = await h.anon().post('/api/external-bans', { ip }, auth(s.mint()));
    assert.ok([200, 201].includes(created.status), `${created.status} ${created.text}`);
    let rows = await rowsFor(ip).where({ is_active: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin_app, 'oblihub');
    assert.equal(rows[0].origin_tenant_id, 1);
    // No banned_until: permanent is not available to a sibling app, the 7-day cap applies.
    const cap = Date.now() + 7 * 24 * 3600 * 1000;
    assert.ok(rows[0].expires_at, 'expires_at set');
    assert.ok(Math.abs(new Date(rows[0].expires_at).getTime() - cap) < 60_000);

    const deleted = await h.anon().del(`/api/external-bans/${encodeURIComponent(ip)}`, undefined, auth(s.mint()));
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(deleted.json.data.deleted, 1);
    rows = await rowsFor(ip).where({ is_active: true });
    assert.equal(rows.length, 0);

    const bad = await h.anon().del('/api/external-bans/not-an-ip', undefined, auth(s.mint()));
    assert.equal(bad.status, 400);
  });

  lotIt('A11', '44.12 banned_until is capped by EXTERNAL_BAN_MAX_SECONDS and validated', async () => {
    process.env.EXTERNAL_BAN_MAX_SECONDS = '3600';
    const ip = nextIp();
    const far = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const r = await h.anon().post('/api/external-bans', { ip, banned_until: far }, auth(s.mint()));
    assert.ok([200, 201].includes(r.status), `${r.status} ${r.text}`);
    const [row] = await rowsFor(ip).where({ is_active: true });
    assert.ok(Math.abs(new Date(row.expires_at).getTime() - (Date.now() + 3600_000)) < 60_000);

    for (const banned_until of ['tomorrow-ish', new Date(Date.now() - 60_000).toISOString(), 12345]) {
      const ip2 = nextIp();
      const bad = await h.anon().post('/api/external-bans', { ip: ip2, banned_until }, auth(s.mint()));
      assert.equal(bad.status, 400, String(banned_until));
      assert.equal((await rowsFor(ip2)).length, 0);
    }
  });

  lotIt('A11', '44.13 source apps outside the allowlist are refused', async () => {
    const ip = nextIp();
    const r = await h.anon().post('/api/external-bans', { ip }, auth(s.mint({ sub: 'app:evilapp', azp: 'evilapp' })));
    assert.equal(r.status, 403);
    assert.equal(r.json?.code, 'source_app_not_allowed');
    assert.equal((await rowsFor(ip)).length, 0);
  });
});
