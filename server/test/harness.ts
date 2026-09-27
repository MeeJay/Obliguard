/**
 * Harness core: the real createApp() + createSocketServer() on an ephemeral
 * port, against the per-suite disposable database set up by run.ts.
 *
 * Mirrors index.ts main() wiring (set*IO — see WIRED_IO_SETTERS, enforced by
 * 00#4) but starts none of the timers (BanEngine, MikroTik pollers, retention
 * jobs): suites drive banEngine.run() explicitly.
 */
import './guard';
import http from 'http';
import net from 'net';
import dns from 'dns';
import fs from 'fs';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import { io as ioClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { Server as SocketIOServer } from 'socket.io';
import type { Knex } from 'knex';
import * as OTPAuth from 'otpauth';
import { createApp } from '../src/app';
import { createSocketServer } from '../src/socket';
import { db } from '../src/db';
import { sessionStore } from '../src/session';
import { logger } from '../src/utils/logger';
import { setAgentServiceIO } from '../src/services/agent.service';
import { setLiveAlertIO } from '../src/services/liveAlert.service';
import { setUserSessionsIO } from '../src/services/userSessions.service';
import { invalidateUserState } from '../src/middleware/sessionUserGuard';
import { getProtectedAddresses } from '../src/utils/protectedIps';
import { PASSWORD, VERIFY_HOST, VERIFY_ORIGIN, OBLIGATE_API_KEY, KEYS, D } from './fixtures';
import { setSessionTenant as setSessionTenantRow } from './seed';
import { startFakeObligate } from './fakeObligate';
import type { FakeObligate, RecordedRequest } from './fakeObligate';
import { adapters } from './adapters';

/** Exact mirror of the set*IO(io) calls of index.ts main() (00#4). */
export const WIRED_IO_SETTERS = ['setAgentServiceIO', 'setLiveAlertIO', 'setUserSessionsIO'] as const;

// ── HTTP client ──────────────────────────────────────────────────────────────

export interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
  location?: string;
}

export interface RequestOpts {
  body?: unknown;
  headers?: Record<string, string>;
  host?: string;
  timeoutMs?: number;
}

let xffCounter = 0;
function nextXff(): string {
  xffCounter++;
  return `10.99.${(xffCounter >> 8) & 255}.${xffCounter & 255}`;
}

const noKeepAlive = new http.Agent({ keepAlive: false });

export class Client {
  readonly jar = new Map<string, string>();
  readonly xff = nextXff();

  constructor(readonly port: number, readonly defaultHost: string = VERIFY_HOST) {}

  request(method: string, path: string, opts: RequestOpts = {}): Promise<Res> {
    const bodyText = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {
      host: opts.host ?? this.defaultHost,
      'x-forwarded-for': this.xff,
      accept: 'application/json',
    };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (bodyText !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(bodyText));
    }
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
    const timeoutMs = opts.timeoutMs ?? 10_000;

    return new Promise<Res>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.port, method, path, headers, agent: noKeepAlive }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          this.storeCookies(res.headers['set-cookie']);
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try { json = JSON.parse(text); } catch { json = null; }
          const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json, location });
        });
        res.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`request timeout ${method} ${path}`));
      }, timeoutMs);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      if (bodyText !== undefined) req.write(bodyText);
      req.end();
    });
  }

  get(path: string, opts?: RequestOpts) { return this.request('GET', path, opts); }
  post(path: string, body?: unknown, opts: RequestOpts = {}) { return this.request('POST', path, { ...opts, body }); }
  put(path: string, body?: unknown, opts: RequestOpts = {}) { return this.request('PUT', path, { ...opts, body }); }
  patch(path: string, body?: unknown, opts: RequestOpts = {}) { return this.request('PATCH', path, { ...opts, body }); }
  del(path: string, body?: unknown, opts: RequestOpts = {}) { return this.request('DELETE', path, { ...opts, body }); }

  private storeCookies(setCookie: string[] | undefined): void {
    for (const line of setCookie ?? []) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let expired = value === '';
      for (const a of attrs) {
        const [k, v] = a.split('=').map((s) => s.trim());
        if (/^max-age$/i.test(k) && Number(v) <= 0) expired = true;
        if (/^expires$/i.test(k) && v && Date.parse(v) < Date.now()) expired = true;
      }
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** The session id behind connect.sid, or null. */
  sid(): string | null {
    const raw = this.jar.get('connect.sid');
    if (!raw) return null;
    const m = /^s:([^.]+)\./.exec(decodeURIComponent(raw));
    return m ? m[1] : null;
  }

  switchTenant(id: number): Promise<Res> {
    return this.post('/api/tenant/switch', { tenantId: id });
  }
}

// ── Sockets ──────────────────────────────────────────────────────────────────

export interface RecordedEvent { seq: number; event: string; args: any[] }

export type SocketResult =
  | { ok: true; socket: ClientSocket; events: RecordedEvent[] }
  | { ok: false; error: string };

let eventSeq = 0;

// ── FakeWs (obliguardHub) ────────────────────────────────────────────────────

/** A stand-in for a `ws` WebSocket, registered directly on obliguardHub. */
export class FakeWs extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(d: unknown): void {
    this.sent.push(JSON.parse(String(d)));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit('close', code, reason);
  }

  /** ws API: forced close (A5's disconnectWhere falls back to it). */
  terminate(): void {
    this.close(1006);
  }

  ping(): void { /* keep-alive no-op */ }

  receive(m: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(m)));
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

export interface SsoAssertionInput {
  obligateUserId: number;
  username: string;
  [k: string]: unknown;
}

export interface SsoLoginResult {
  client: Client;
  redirect: Res;
  callback: Res;
  exchange: RecordedRequest | null;
  /** The exact /auth/callback path+query that was requested (for replay checks). */
  callbackPath: string;
}

export type PushKey = 1 | 2 | 3 | { key: string };

export interface Harness {
  db: Knex;
  io: SocketIOServer;
  server: http.Server;
  port: number;
  baseUrl: string;
  obligate: FakeObligate | null;
  blockedNetwork: string[];
  /** DNS lookups of non-allowed hosts after the protected-set pre-warm (informational). */
  blockedDns: string[];
  unhandled: string[];
  anon(): Client;
  login(username: string, password?: string): Promise<Client>;
  loginStep1(username: string, password?: string): Promise<{ client: Client; res: Res }>;
  /** Cached logged-in client of a fixture user (use login() for a fresh session). */
  as(username: string): Promise<Client>;
  /** Cached platform-admin client switched to `tenantId`. */
  adminIn(tenantId: number): Promise<Client>;
  ssoLogin(assertion: SsoAssertionInput, opts?: { client?: Client; callbackHost?: string; callbackHeaders?: Record<string, string> }): Promise<SsoLoginResult>;
  push(keyTenant: PushKey, uuid: string, body?: Record<string, unknown>): Promise<Res>;
  event(ip: string, over?: Record<string, unknown>): Record<string, unknown>;
  socket(client: Client | null, opts?: { origin?: string | null; auth?: Record<string, unknown> }): Promise<SocketResult>;
  roomsOf(userId: number): Promise<string[]>;
  setSessionTenant(client: Client, tenantId: number): Promise<void>;
  invalidateUser(id: number): void;
  close(): Promise<void>;
}

export async function startHarness(opts: { obligate?: boolean } = {}): Promise<Harness> {
  // a) Logger
  logger.level = process.env.VERIFY_LOG_LEVEL ?? 'silent';

  const blockedNetwork: string[] = [];
  const blockedDns: string[] = [];
  const unhandled: string[] = [];

  // b) Network guard
  const allowed = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  try { allowed.add(new URL(process.env.DATABASE_URL ?? '').hostname); } catch { /* guard.ts already checked */ }
  const isAllowed = (host: string | undefined | null) => !host || allowed.has(host) || allowed.has(host.replace(/^\[|\]$/g, ''));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    let hostname: string | null = null;
    try { hostname = new URL(String(url)).hostname; } catch { hostname = null; }
    if (!isAllowed(hostname)) {
      blockedNetwork.push(String(url));
      throw new TypeError('verify: outbound network blocked ' + String(url));
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const originalConnect = net.Socket.prototype.connect;
  (net.Socket.prototype as any).connect = function patchedConnect(this: net.Socket, ...args: any[]) {
    let first = args[0];
    if (Array.isArray(first)) first = first[0]; // net.connect() passes normalized args
    let host: string | undefined;
    let isPath = false;
    if (first && typeof first === 'object') {
      if (first.path) isPath = true;
      host = first.host;
    } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
      isPath = true; // IPC path
    } else if (typeof args[1] === 'string') {
      host = args[1];
    }
    if (!isPath && host && !isAllowed(host)) {
      blockedNetwork.push(`tcp:${host}`);
      process.nextTick(() => this.destroy(new Error('verify: outbound network blocked')));
      return this;
    }
    return (originalConnect as any).apply(this, args);
  };

  // b2) DNS guard (A2): protectedIps resolves the APP_URL / CLIENT_ORIGIN /
  //     SSO_ALLOWED_HOSTS hosts (verify.local). A real lookup can stall up to
  //     3 s (mDNS on Windows): non-allowed hosts fail fast with ENOTFOUND. Not
  //     recorded in blockedNetwork (no connection is attempted; 13.2 stays a
  //     TCP/fetch guard) but in blockedDns, except the hosts the protected-set
  //     pre-warm (step e) resolves, so a stray lookup is still reported.
  const dnsPromises = dns.promises as unknown as { lookup: (...args: any[]) => Promise<unknown> };
  const originalLookup = dnsPromises.lookup;
  const prewarmDns = new Set<string>();
  let dnsPrewarmDone = false;
  dnsPromises.lookup = async (host: string, ...rest: any[]) => {
    if (isAllowed(host)) return originalLookup.call(dns.promises, host, ...rest);
    if (!dnsPrewarmDone) prewarmDns.add(host);
    else if (!prewarmDns.has(host)) blockedDns.push(`dns:${host}`);
    const err = new Error(`verify: DNS blocked ${host}`) as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  };

  // c) Unhandled rejections: recorded (reported by the runner), never pinned
  //    onto whatever BASELINE test happens to be running. Mirrors production
  //    (index.ts logs and keeps serving).
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (r) => {
    unhandled.push(String((r as any)?.stack ?? r));
  });

  // d) Fake Obligate
  let obligate: FakeObligate | null = null;
  if (opts.obligate) {
    obligate = await startFakeObligate(OBLIGATE_API_KEY);
    for (const [key, value] of [
      ['obligate_config', JSON.stringify({ url: obligate.url, apiKey: OBLIGATE_API_KEY })],
      ['obligate_enabled', 'true'],
    ]) {
      await db('app_config').insert({ key, value }).onConflict('key').merge({ value });
    }
  }

  // e) Wiring, in index.ts order
  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);
  app.set('io', io);
  setAgentServiceIO(io);
  setLiveAlertIO(io);
  setUserSessionsIO(io);
  adapters.agentWs?.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Pre-warm the protected set (A2) so no timed check pays for its first build.
  await getProtectedAddresses();
  dnsPrewarmDone = true;
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const openSockets: ClientSocket[] = [];
  const asCache = new Map<string, Client>();
  const adminCache = new Map<number, Client>();
  const agentClient = new Client(port);

  const h: Harness = {
    db,
    io,
    server,
    port,
    baseUrl,
    obligate,
    blockedNetwork,
    blockedDns,
    unhandled,

    anon: () => new Client(port),

    async loginStep1(username, password = PASSWORD) {
      const client = new Client(port);
      const res = await client.post('/api/auth/login', { username, password });
      return { client, res };
    },

    async login(username, password = PASSWORD) {
      const { client, res } = await h.loginStep1(username, password);
      if (res.status !== 200 || !res.json?.success || res.json?.data?.requires2fa) {
        throw new Error(`login(${username}) failed: ${res.status} ${res.text.slice(0, 200)}`);
      }
      return client;
    },

    async as(username) {
      const hit = asCache.get(username);
      if (hit) return hit;
      const c = await h.login(username);
      asCache.set(username, c);
      return c;
    },

    async adminIn(tenantId) {
      const hit = adminCache.get(tenantId);
      if (hit) return hit;
      const c = await h.login('admin');
      const r = await c.switchTenant(tenantId);
      if (r.status !== 200) throw new Error(`adminIn(${tenantId}): switch failed ${r.status}`);
      adminCache.set(tenantId, c);
      return c;
    },

    async ssoLogin(assertion, o = {}) {
      if (!obligate) throw new Error('ssoLogin requires startHarness({ obligate: true })');
      const client = o.client ?? new Client(port);
      const redirect = await client.get('/auth/sso-redirect', { host: VERIFY_HOST });
      if (redirect.status !== 302 || !redirect.location) {
        throw new Error(`ssoLogin: sso-redirect answered ${redirect.status} ${redirect.location ?? ''}`);
      }
      const loc = new URL(redirect.location, VERIFY_ORIGIN);
      const state = loc.searchParams.get('state');
      const redirectUri = loc.searchParams.get('redirect_uri');
      if (!state) throw new Error(`ssoLogin: no state in ${redirect.location}`);
      const code = `code-${crypto.randomUUID()}`;
      obligate.assertions.set(code, {
        assertion: {
          email: `${assertion.username}@verify.test`,
          displayName: assertion.username,
          role: 'user',
          tenants: [],
          teams: [],
          authSource: 'local',
          linkedLocalUserId: null,
          ...assertion,
        },
        redirectUri,
      });
      const callbackPath = `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      const callback = await client.get(
        callbackPath,
        { host: o.callbackHost ?? VERIFY_HOST, headers: o.callbackHeaders },
      );
      const exchange = [...obligate.requests].reverse()
        .find((r) => r.method === 'POST' && r.path === '/api/oauth/token/exchange' && r.body?.code === code) ?? null;
      return { client, redirect, callback, exchange, callbackPath };
    },

    push(keyTenant, uuid, body) {
      const key = typeof keyTenant === 'object' ? keyTenant.key : KEYS[keyTenant];
      const fixture = Object.values(D).find((d) => d.uuid === uuid);
      const payload = {
        hostname: fixture?.hostname ?? 'verify-host',
        agentVersion: fixture?.version ?? '1.0.0',
        osInfo: { platform: 'linux', distro: 'verify', release: '1', arch: 'x64' },
        services: [],
        events: [],
        firewallBanned: [],
        firewallName: 'verify',
        lanIPs: [],
        ...(body ?? {}),
      };
      return agentClient.post('/api/agent/push', payload, { headers: { 'x-api-key': key, 'x-device-uuid': uuid } });
    },

    event(ip, over = {}) {
      return {
        ip,
        username: 'root',
        service: 'ssh',
        eventType: 'auth_failure',
        timestamp: new Date().toISOString(),
        rawLog: 'verify',
        ...over,
      };
    },

    socket(client, o = {}) {
      const extraHeaders: Record<string, string> = { 'x-forwarded-for': client?.xff ?? nextXff() };
      const cookie = client?.cookieHeader();
      if (cookie) extraHeaders.cookie = cookie;
      const origin = o.origin === undefined ? VERIFY_ORIGIN : o.origin;
      if (origin !== null) extraHeaders.origin = origin;
      const socket = ioClient(baseUrl, {
        transports: ['websocket'],
        extraHeaders,
        auth: o.auth ?? {},
        reconnection: false,
        forceNew: true,
        timeout: 5000,
      });
      openSockets.push(socket);
      const events: RecordedEvent[] = [];
      socket.onAny((event: string, ...args: any[]) => { events.push({ seq: ++eventSeq, event, args }); });
      socket.on('disconnect', (reason) => { events.push({ seq: ++eventSeq, event: 'disconnect', args: [reason] }); });
      return new Promise<SocketResult>((resolve) => {
        const timer = setTimeout(() => { socket.close(); resolve({ ok: false, error: 'timeout' }); }, 6000);
        socket.once('connect', () => { clearTimeout(timer); resolve({ ok: true, socket, events }); });
        socket.once('connect_error', (err: Error) => { clearTimeout(timer); socket.close(); resolve({ ok: false, error: err.message }); });
      });
    },

    async roomsOf(userId) {
      const sockets = await io.in(`user:${userId}`).fetchSockets();
      const rooms = new Set<string>();
      for (const s of sockets) for (const r of s.rooms) rooms.add(r);
      return [...rooms];
    },

    async setSessionTenant(client, tenantId) {
      const sid = client.sid();
      if (!sid) throw new Error('setSessionTenant: client has no session');
      await setSessionTenantRow(db, sid, tenantId);
    },

    invalidateUser(id) { invalidateUserState(id); },

    async close() {
      for (const s of openSockets) { try { s.close(); } catch { /* ignore */ } }
      await new Promise<void>((resolve) => { io.close(() => resolve()); });
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      try { (sessionStore as any).close?.(); } catch { /* ignore */ }
      try { await db.destroy(); } catch { /* ignore */ }
      try { await obligate?.close(); } catch { /* ignore */ }
      const report = process.env.VERIFY_REPORT_FILE;
      if (report) {
        try { fs.writeFileSync(report, JSON.stringify({ unhandled, blockedNetwork, blockedDns }, null, 2)); } catch { /* ignore */ }
      }
      globalThis.fetch = originalFetch;
      (net.Socket.prototype as any).connect = originalConnect;
      dnsPromises.lookup = originalLookup;
    },
  };

  return h;
}

// ── Utilities ────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `pred` until it returns a truthy value (returned), or throw after `timeoutMs`. */
export async function waitFor<T>(pred: () => T | Promise<T>, timeoutMs = 3000, stepMs = 25): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await pred();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs} ms${last ? ` (last error: ${String(last)})` : ''}`);
    }
    await sleep(stepMs);
  }
}

/** Like waitFor, but a timeout is tolerated (sentinel drains). Returns null on timeout. */
export async function drain<T>(pred: () => T | Promise<T>, timeoutMs = 2000): Promise<NonNullable<T> | null> {
  try { return await waitFor(pred, timeoutMs); } catch { return null; }
}

function totpFor(secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}

export function totp(secret: string, stepOffset = 0): string {
  return totpFor(secret).generate({ timestamp: Date.now() + stepOffset * 30_000 });
}

/**
 * A 6-digit code that is NOT valid now. The server accepts ±2 steps
 * (twoFactorService window 2), so all codes from -2 to +2 are excluded.
 */
export function wrongTotp(secret: string): string {
  const valid = new Set([-2, -1, 0, 1, 2].map((o) => totp(secret, o)));
  for (;;) {
    const c = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!valid.has(c)) return c;
  }
}

/** Host part of an inet/cidr text value. */
export function hostOf(ip: string | null | undefined): string {
  return String(ip ?? '').split('/')[0];
}
