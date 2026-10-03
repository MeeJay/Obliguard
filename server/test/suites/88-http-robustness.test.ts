/**
 * 88 — W11-4 HTTP robustness (backlog D18): error mapping, async handlers,
 * database guards, health probe.
 *
 *   88.1 malformed JSON body → 400 INVALID_JSON (JSON, no stack); oversized
 *        body → 413 PAYLOAD_TOO_LARGE
 *   88.2 duplicate key through a real route (team name) → 409, without the
 *        constraint, table or SQL in the body
 *   88.3 errorHandler mapping: zod → 400 VALIDATION + details, 23503 → 400 /
 *        409, 22P02 → 400, 57014 → 503, pool timeout → 503, AppError codes
 *        kept, unknown errors → 500 with no message nor stack, headersSent →
 *        delegated to Express
 *   88.4 asyncHandler forwards rejections and sync throws to errorHandler
 *        (uncaught unique violation → 409 CONFLICT); apiNotFoundHandler
 *        answers 404 JSON
 *   88.5 runtime pool: statement_timeout set (cancelled query → 503
 *        TIMEOUT), withoutStatementTimeout lifts it, migrations run on a
 *        handle without it
 *   88.6 health handler: 200 when the database answers, 503 when it fails or
 *        hangs; concurrent probes share one ping
 *   88.7 [W11-5] app wiring: unknown /api route → 404 JSON (GET and POST);
 *        GET /health reports the database
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import { z } from 'zod';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { AppError, errorHandler, apiNotFoundHandler } from '../../src/middleware/errorHandler';
import { asyncHandler } from '../../src/utils/asyncHandler';
import { db, statementTimeoutMs, withoutStatementTimeout, DEFAULT_STATEMENT_TIMEOUT_MS } from '../../src/db';
import { createHealthHandler } from '../../src/routes/health';

interface RawRes { status: number; contentType: string; text: string; json: any }

function rawRequest(port: number, method: string, path: string, body?: string | Buffer, contentType = 'application/json'): Promise<RawRes> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: 'verify.local', accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = contentType;
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), text, json });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout ${method} ${path}`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Runs errorHandler against a recording response. */
function runHandler(err: unknown, opts: { headersSent?: boolean; method?: string } = {}) {
  let status = 0;
  let body: any = null;
  let forwarded: unknown = undefined;
  const res = {
    headersSent: opts.headersSent ?? false,
    status(s: number) { status = s; return res; },
    json(b: unknown) { body = b; return res; },
  };
  errorHandler(err as Error, { method: opts.method ?? 'GET', path: '/x' } as any, res as any, (e?: unknown) => { forwarded = e; });
  return { status, body, forwarded };
}

/** Real PostgreSQL error raised by `sql`. */
async function pgError(sql: string, bindings: unknown[] = []): Promise<unknown> {
  try {
    await db.raw(sql, bindings as any);
  } catch (err) {
    return err;
  }
  throw new Error(`expected "${sql}" to fail`);
}

/** A throwaway express app on an ephemeral port. */
async function miniApp(setup: (app: express.Express) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  setup(app);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function assertNoLeak(text: string): void {
  assert.doesNotMatch(text, /\bat .+\(.+:\d+:\d+\)|node_modules|\.ts:\d+/, 'stack trace leaked');
  assert.doesNotMatch(text, /insert into|select |violates|constraint|user_teams|duplicate key/i, 'SQL / schema detail leaked');
}

describe('88 HTTP robustness (W11-4)', () => {
  let h: Harness;

  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  lotIt('W11-4', '88.1 malformed JSON → 400 INVALID_JSON; oversized body → 413', async () => {
    const bad = await rawRequest(h.port, 'POST', '/api/auth/login', '{"username": "admin", ');
    assert.equal(bad.status, 400, bad.text);
    assert.match(bad.contentType, /application\/json/);
    assert.equal(bad.json?.success, false);
    assert.equal(bad.json?.code, 'INVALID_JSON');
    assertNoLeak(bad.text);
    assert.equal(bad.json?.stack, undefined);

    const big = await rawRequest(h.port, 'POST', '/api/auth/login', JSON.stringify({ username: 'x'.repeat(1_100_000) }));
    assert.equal(big.status, 413, big.text);
    assert.equal(big.json?.code, 'PAYLOAD_TOO_LARGE');
  });

  lotIt('W11-4', '88.2 duplicate key through a real route → 409, nothing leaked', async () => {
    const admin = await h.adminIn(1);
    const name = `dup-team-${Date.now()}`;
    const first = await admin.post('/api/teams', { name });
    assert.equal(first.status, 201, first.text);
    const second = await admin.post('/api/teams', { name });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.json?.success, false);
    assert.equal(typeof second.json?.error, 'string');
    assertNoLeak(second.text);
    assert.equal(await h.db('user_teams').where({ name }).count<{ count: string }[]>('* as count').then((r) => Number(r[0].count)), 1);
  });

  lotIt('W11-4', '88.3 errorHandler maps zod / PostgreSQL / pool errors and hides the rest', async () => {
    // zod
    const parsed = z.object({ name: z.string().min(3), port: z.number() }).safeParse({ name: 'a', port: 'x' });
    assert.equal(parsed.success, false);
    const zr = runHandler(!parsed.success ? parsed.error : null);
    assert.equal(zr.status, 400);
    assert.equal(zr.body.code, 'VALIDATION');
    assert.ok(Array.isArray(zr.body.details.name) && Array.isArray(zr.body.details.port), JSON.stringify(zr.body));

    // 23505 / 23503 / 22P02 from the real database
    const team = `fk-team-${Date.now()}`;
    await db('user_teams').insert({ name: team, tenant_id: 1 });
    const dup = runHandler(await pgError('INSERT INTO user_teams (name, tenant_id) VALUES (?, 1)', [team]));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'CONFLICT');
    const missing = runHandler(await pgError('INSERT INTO team_memberships (team_id, user_id) VALUES (2147480000, 1)'));
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'INVALID_REFERENCE');
    const badText = runHandler(await pgError(`SELECT 'not-a-number'::int`));
    assert.equal(badText.status, 400);
    assert.equal(badText.body.code, 'INVALID_INPUT');
    for (const r of [dup, missing, badText]) assertNoLeak(JSON.stringify(r.body));

    // Deleting a row still referenced → 409 (same shape pg reports).
    const inUse = runHandler(Object.assign(new Error('delete from x - update or delete violates foreign key'), {
      code: '23503', severity: 'ERROR', detail: 'Key (id)=(3) is still referenced from table "y".',
    }));
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.code, 'REFERENCE_CONFLICT');
    // Localized server messages (lc_messages = fr_FR): still a 409 for a delete.
    const frDetail = { code: '23503', severity: 'ERREUR', detail: 'La clé (id)=(3) est toujours référencée à partir de la table « y ».' };
    assert.equal(runHandler(Object.assign(new Error('x'), frDetail)).status, 409);
    const frNoDetail = { code: '23503', severity: 'ERREUR', detail: 'La clé est référencée.' };
    assert.equal(runHandler(Object.assign(new Error('delete from "user_teams" where "id" = $1 - ...'), frNoDetail)).status, 409);
    assert.equal(runHandler(Object.assign(new Error('x'), frNoDetail), { method: 'DELETE' }).status, 409);
    assert.equal(runHandler(Object.assign(new Error('insert into "y" - ...'), frNoDetail)).status, 400);

    // Statement timeout and pool exhaustion → 503.
    const cancelled = runHandler(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' }));
    assert.equal(cancelled.status, 503);
    assert.equal(cancelled.body.code, 'TIMEOUT');
    const poolTimeout = new Error('Knex: Timeout acquiring a connection. The pool is probably full.');
    poolTimeout.name = 'KnexTimeoutError';
    assert.equal(runHandler(poolTimeout).status, 503);

    // A Node system error with a 5-letter code is not mistaken for SQLSTATE.
    const sys = runHandler(Object.assign(new Error('write EPIPE /secret/path'), { code: 'EPIPE' }));
    assert.equal(sys.status, 500);

    // An arbitrary error carrying a `status` (not an http-errors object) does
    // not dictate this server's status: a stray 401 would log the user out.
    const upstream = runHandler(Object.assign(new Error('upstream said 401'), { status: 401 }));
    assert.equal(upstream.status, 500);
    assert.equal(upstream.body.code, 'INTERNAL');
    // http-errors objects (body-parser...) keep their 4xx; message only when exposable.
    const unsupported = runHandler(Object.assign(new Error('unsupported charset "X"'), { status: 415, expose: true, type: 'charset.unsupported' }));
    assert.deepEqual(unsupported.body, { success: false, error: 'unsupported charset "X"', code: 'BAD_REQUEST' });
    assert.equal(unsupported.status, 415);
    const hidden = runHandler(Object.assign(new Error('/srv/secret'), { status: 403, expose: false }));
    assert.deepEqual([hidden.status, hidden.body.error], [403, 'Bad request']);

    // AppError: status, message and domain code untouched.
    const app = runHandler(new AppError(403, 'No tenant access', 'noTenantAccess'));
    assert.deepEqual(app, { status: 403, body: { success: false, error: 'No tenant access', code: 'noTenantAccess' }, forwarded: undefined });

    // Unknown error: generic 500, no message nor stack.
    const boom = new Error('secret detail /srv/obliguard/config.ts');
    const unknown = runHandler(boom);
    assert.equal(unknown.status, 500);
    assert.deepEqual(unknown.body, { success: false, error: 'Internal server error', code: 'INTERNAL' });

    // Response already started: handed back to Express (which closes the socket).
    const late = runHandler(boom, { headersSent: true });
    assert.equal(late.status, 0);
    assert.equal(late.forwarded, boom);
  });

  lotIt('W11-4', '88.4 asyncHandler forwards rejections and throws; apiNotFoundHandler answers 404 JSON', async () => {
    const app = await miniApp((a) => {
      a.get('/reject', asyncHandler(async () => { throw new AppError(418, 'teapot', 'teapot'); }));
      a.get('/throw', asyncHandler(() => { throw new Error('sync boom'); }));
      a.get('/db', asyncHandler(async () => { await db.raw(`SELECT 'x'::uuid`); }));
      // A unique violation nobody catches: errorHandler's own 409.
      a.post('/dup', asyncHandler(async (req, res) => {
        await db('user_teams').insert({ name: String(req.body.name), tenant_id: 1 });
        res.status(201).json({ success: true });
      }));
      a.get('/ok', asyncHandler(async (_req, res) => { res.json({ ok: true }); }));
      a.use('/api', apiNotFoundHandler);
    });
    try {
      const rejected = await rawRequest(app.port, 'GET', '/reject');
      assert.equal(rejected.status, 418);
      assert.deepEqual(rejected.json, { success: false, error: 'teapot', code: 'teapot' });
      const thrown = await rawRequest(app.port, 'GET', '/throw');
      assert.equal(thrown.status, 500);
      assert.equal(thrown.json?.code, 'INTERNAL');
      assertNoLeak(thrown.text);
      const dbErr = await rawRequest(app.port, 'GET', '/db');
      assert.equal(dbErr.status, 400);
      assert.equal(dbErr.json?.code, 'INVALID_INPUT');
      assert.deepEqual((await rawRequest(app.port, 'GET', '/ok')).json, { ok: true });
      const dupName = JSON.stringify({ name: `raw-dup-${Date.now()}` });
      assert.equal((await rawRequest(app.port, 'POST', '/dup', dupName)).status, 201);
      const dup = await rawRequest(app.port, 'POST', '/dup', dupName);
      assert.equal(dup.status, 409, dup.text);
      assert.deepEqual(dup.json, { success: false, error: 'This entry already exists', code: 'CONFLICT' });

      for (const method of ['GET', 'POST', 'DELETE']) {
        const nf = await rawRequest(app.port, method, '/api/definitely/not/a/route');
        assert.equal(nf.status, 404, `${method} ${nf.text}`);
        assert.match(nf.contentType, /application\/json/);
        assert.deepEqual(nf.json, { success: false, error: 'Not found', code: 'NOT_FOUND' });
      }
    } finally {
      await app.close();
    }
  });

  lotIt('W11-4', '88.5 runtime pool: statement_timeout set and enforced; lifted for long jobs and migrations', async () => {
    assert.equal(statementTimeoutMs, DEFAULT_STATEMENT_TIMEOUT_MS);
    const shown = await db.raw('SHOW statement_timeout');
    assert.equal(shown.rows[0].statement_timeout, '30s');

    const lifted = await withoutStatementTimeout((trx) => trx.raw('SHOW statement_timeout'));
    assert.equal(lifted.rows[0].statement_timeout, '0');
    // SET LOCAL: the pooled connection keeps its default afterwards.
    const after = await db.raw('SHOW statement_timeout');
    assert.equal(after.rows[0].statement_timeout, '30s');

    // A query running past the timeout is cancelled and answered 503.
    const err = await db.transaction(async (trx) => {
      await trx.raw('SET LOCAL statement_timeout = 50');
      try {
        await trx.raw('SELECT pg_sleep(2)');
      } catch (e) {
        return e;
      }
      return null;
    }).catch((e: unknown) => e);
    assert.equal((err as { code?: string } | null)?.code, '57014');
    assert.equal(runHandler(err).status, 503);

    // Migrations: a handle without the statement timeout.
    const migrator = db.migrate as unknown as { knex: { client: { config: { connection: unknown } } } };
    const conn = migrator.knex.client.config.connection;
    assert.ok(typeof conn === 'string' || (conn as { statement_timeout?: unknown }).statement_timeout === undefined, JSON.stringify(conn));
    const runtimeConn = (db.client as { config: { connection: { statement_timeout?: number } } }).config.connection;
    assert.equal(runtimeConn.statement_timeout, DEFAULT_STATEMENT_TIMEOUT_MS);
  });

  lotIt('W11-4', '88.6 health handler: 200 / 503 with the database state; probes coalesced', async () => {
    let pings = 0;
    let mode: 'ok' | 'fail' | 'hang' = 'ok';
    const handler = createHealthHandler({
      version: '9.9.9',
      timeoutMs: 200,
      cacheMs: 0,
      ping: async () => {
        pings++;
        if (mode === 'fail') throw new Error('ECONNREFUSED');
        if (mode === 'hang') await new Promise(() => undefined);
        await new Promise((r) => setTimeout(r, 30));
      },
    });
    const real = createHealthHandler({ version: '1.0.0' });
    const app = await miniApp((a) => {
      a.get('/health', handler);
      a.get('/health-real', real);
    });
    try {
      const ok = await rawRequest(app.port, 'GET', '/health');
      assert.equal(ok.status, 200);
      assert.equal(ok.json.status, 'ok');
      assert.equal(ok.json.database, 'ok');
      assert.equal(ok.json.version, '9.9.9');
      assert.ok(!Number.isNaN(Date.parse(ok.json.timestamp)));

      // Concurrent probes share one in-flight ping.
      pings = 0;
      await Promise.all([1, 2, 3, 4].map(() => rawRequest(app.port, 'GET', '/health')));
      assert.equal(pings, 1);

      mode = 'fail';
      const down = await rawRequest(app.port, 'GET', '/health');
      assert.equal(down.status, 503);
      assert.equal(down.json.status, 'error');
      assert.equal(down.json.database, 'unreachable');
      assert.equal(down.json.version, '9.9.9');

      mode = 'hang';
      const t0 = Date.now();
      const hung = await rawRequest(app.port, 'GET', '/health');
      assert.equal(hung.status, 503);
      assert.ok(Date.now() - t0 < 3000, 'a hanging database must not hang the probe');

      const viaDb = await rawRequest(app.port, 'GET', '/health-real');
      assert.equal(viaDb.status, 200, viaDb.text);
      assert.equal(viaDb.json.database, 'ok');
    } finally {
      await app.close();
    }
  });

  lotIt('W11-5', '88.7 app wiring: unknown /api route → 404 JSON; /health reports the database', async () => {
    // Signed in: anonymous calls stop at the routers' requireAuth (401).
    const admin = await h.adminIn(1);
    for (const nf of [await admin.get('/api/definitely/not/a/route'), await admin.post('/api/definitely/not/a/route', {})]) {
      assert.equal(nf.status, 404, nf.text.slice(0, 200));
      assert.match(String(nf.headers['content-type'] ?? ''), /application\/json/);
      assert.equal(nf.json?.code, 'NOT_FOUND');
    }
    const health = await rawRequest(h.port, 'GET', '/health');
    assert.equal(health.status, 200, health.text);
    assert.equal(health.json?.status, 'ok');
    assert.equal(health.json?.database, 'ok');
    assert.equal(typeof health.json?.version, 'string');
  });
});
