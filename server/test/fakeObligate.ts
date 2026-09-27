/**
 * A fake Obligate (SSO gateway + delegation JWKS) on 127.0.0.1:<ephemeral>.
 *
 * - Ed25519 JWKS (kid 'verify-kid-1'); a second 'foreign' key is never published.
 * - OAuth code exchange: codes are SINGLE-USE and bound to the redirect_uri
 *   they were issued for; every request is recorded in `requests`.
 */
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { OBLIGATE_API_KEY } from './fixtures';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
  at: number;
}

export interface StoredAssertion {
  assertion: Record<string, unknown>;
  redirectUri: string | null;
}

export interface MintOpts {
  sub: string;
  aud?: string;
  iatOffsetSec?: number;
  expOffsetSec?: number;
  nbfOffsetSec?: number;
  /** null → header without typ */
  typ?: string | null;
  jti?: string;
}

export interface FakeObligate {
  url: string;
  apiKey: string;
  requests: RecordedRequest[];
  assertions: Map<string, StoredAssertion>;
  mintDelegation(o: MintOpts, x?: { foreignKey?: boolean; tamper?: 'bitflip' }): string;
  close(): Promise<void>;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s: string): Buffer {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64');
}

export async function startFakeObligate(apiKey = OBLIGATE_API_KEY): Promise<FakeObligate> {
  const main = crypto.generateKeyPairSync('ed25519');
  const foreign = crypto.generateKeyPairSync('ed25519');
  const jwk = { ...(main.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'verify-kid-1', alg: 'EdDSA' };
  const clientId = crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');

  const requests: RecordedRequest[] = [];
  const assertions = new Map<string, StoredAssertion>();

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = null;
      if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
      const url = new URL(req.url ?? '/', 'http://fake-obligate');
      const path = url.pathname;
      requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body, at: Date.now() });

      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && path === '/api/delegation/jwks') return send(res, 200, { keys: [jwk] });
      if (req.method === 'GET' && path === '/api/oauth/authorize') {
        if (url.searchParams.get('client_id') === clientId) {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
        return send(res, 400, { error: 'Invalid client_id' });
      }
      if (req.method === 'POST' && path === '/api/oauth/token/exchange') {
        if (req.headers.authorization !== `Bearer ${apiKey}`) return send(res, 401, { error: 'Unauthorized' });
        const code = body?.code;
        const redirectUri = body?.redirect_uri;
        if (!code || !redirectUri) return send(res, 400, { error: 'Missing code or redirect_uri' });
        const stored = assertions.get(code);
        if (!stored) return send(res, 400, { error: 'Invalid or expired code' });
        assertions.delete(code); // single-use
        if (stored.redirectUri !== null && stored.redirectUri !== redirectUri) {
          return send(res, 400, { error: 'redirect_uri mismatch' });
        }
        return send(res, 200, { success: true, data: stored.assertion });
      }
      if (req.method === 'POST' && ['/api/apps/report-provision', '/api/devices/register', '/api/apps/sync-capability-schemas'].includes(path)) {
        return send(res, 200, { success: true });
      }
      if (req.method === 'GET' && path.startsWith('/api/apps/user-preferences/')) return send(res, 200, { success: true, data: {} });
      if (req.method === 'GET' && path === '/api/apps/connected') return send(res, 200, { success: true, data: [] });
      return send(res, 404, { error: 'Not found' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  function mintDelegation(o: MintOpts, x: { foreignKey?: boolean; tamper?: 'bitflip' } = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const kid = x.foreignKey ? 'foreign-kid' : 'verify-kid-1';
    const typ = o.typ === undefined ? 'JWT' : o.typ;
    const header: Record<string, string> = { alg: 'EdDSA', kid };
    if (typ !== null) header.typ = typ;
    const claims = {
      iss: 'fake-obligate',
      aud: o.aud ?? 'obliguard',
      azp: 'oblihub',
      sub: o.sub,
      ost: 'default',
      scp: 'bans',
      jti: o.jti ?? crypto.randomUUID(),
      iat: now + (o.iatOffsetSec ?? 0),
      nbf: now + (o.nbfOffsetSec ?? 0),
      exp: now + (o.expOffsetSec ?? 120),
    };
    const h = b64url(JSON.stringify(header));
    const p = b64url(JSON.stringify(claims));
    const key = x.foreignKey ? foreign.privateKey : main.privateKey;
    let sig = crypto.sign(null, Buffer.from(`${h}.${p}`), key);
    if (x.tamper === 'bitflip') {
      // Deterministic: flip a bit INSIDE the 64 signature bytes. Changing the
      // last base64url character could leave the decoded bytes unchanged (the
      // decoder drops the 2 padding bits).
      sig = Buffer.from(sig);
      sig[32] ^= 0x01;
      if (b64urlDecode(b64url(sig)).equals(crypto.sign(null, Buffer.from(`${h}.${p}`), key))) {
        throw new Error('bitflip tamper produced the original signature');
      }
    }
    return `${h}.${p}.${b64url(sig)}`;
  }

  return {
    url,
    apiKey,
    requests,
    assertions,
    mintDelegation,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
