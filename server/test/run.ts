/**
 * Verification runner — `npm run verify -w server [-- <substring filters>]`.
 *
 * Starts a disposable PostgreSQL 16 (npm embedded-postgres, no admin rights),
 * migrates + seeds ONE template database, then runs every suite of
 * server/test/suites/*.test.ts in its own clone of it, each in its own node
 * process, against the real createApp() + Socket.io (see harness.ts).
 * Requires Node >= 22.12.
 *
 * Environment:
 *   VERIFY_DATABASE_URL       external PostgreSQL with CREATEDB rights (skips embedded PG)
 *   VERIFY_KEEP_DB=1          keep databases, PG data dir and the work dir
 *   VERIFY_STRICT=1           every lot counts as landed (pending checks fail)
 *   VERIFY_LOTS=A1,A2         these lots count as landed
 *   VERIFY_LOG_LEVEL          server log level inside suites (default 'silent')
 *   VERIFY_PG_PORT            embedded PG port (default: a free port)
 *   VERIFY_PG_DIR             embedded PG data dir (default: <work>/pg — use it if %TEMP% has spaces);
 *                             it must be empty or a previous verify cluster, and it is DELETED
 *                             after the run unless VERIFY_KEEP_DB=1
 *   VERIFY_PG_LOG=1           print PostgreSQL's own log
 *   VERIFY_SKIP_SHARED_BUILD=1  do not rebuild shared/ first
 *   VERIFY_SUITE_TIMEOUT_MS   per-suite timeout (default 240000)
 *
 * Docker fallback when embedded PG cannot run on the box:
 *   docker -H tcp://10.0.0.152:2375 run -d --rm --name obliguard-verify-pg -p 55432:5432 -e POSTGRES_PASSWORD=verify postgres:16-alpine
 *   VERIFY_DATABASE_URL=postgres://postgres:verify@10.0.0.152:55432/postgres
 *
 * Every artifact (PG data, TAP files, per-suite reports) lives under
 * os.tmpdir(): 000-RegularUpdate.bat commits with `git add -A`, nothing may
 * land in the repository tree.
 */
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { pathToFileURL } from 'url';
import knex from 'knex';
import { Client as PgClient } from 'pg';
import { seedFixtures } from './seed';

const TEST_DIR = __dirname;
const SERVER_DIR = path.resolve(TEST_DIR, '..');
const REPO_DIR = path.resolve(SERVER_DIR, '..');
const SUITES_DIR = path.join(TEST_DIR, 'suites');
const KEEP = process.env.VERIFY_KEEP_DB === '1';
const SUITE_TIMEOUT_MS = Number(process.env.VERIFY_SUITE_TIMEOUT_MS) || 240_000;
const WORK = path.join(os.tmpdir(), `obliguard-verify-${process.pid}-${Date.now()}`);

const RESERVED_KEYS = new Set(['DATABASE_URL', 'OBLIGUARD_VERIFY', 'SESSION_SECRET', 'NODE_ENV', 'VERIFY_ADMIN_URL', 'VERIFY_REPORT_FILE']);
const SCRUB_RE = /^(DATABASE_|DB_|SESSION_|APP_|CLIENT_ORIGIN|SSO_|FORCE_HTTPS|DISABLE_2FA|BAN_|AGENT_|MANUAL_SUBNET_|OBLIGATE_|IP_EVENTS_|DEFAULT_ADMIN_|PORT$|LISTEN_PORT|NODE_ENV|OBLIGUARD_|CREDENTIAL_)/;

interface EmbeddedPostgresLike {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresLike;

let pgServer: EmbeddedPostgresLike | null = null;
let runningChild: ChildProcess | null = null;
let cleaningUp = false;

function log(msg: string): void {
  process.stdout.write(`[verify] ${msg}\n`);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function withDb(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function adminQuery(adminUrl: string, sql: string): Promise<void> {
  const c = new PgClient({ connectionString: adminUrl });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function stopPg(): Promise<void> {
  if (!pgServer) return;
  const s = pgServer;
  pgServer = null;
  try { await s.stop(); } catch (err) { console.error('[verify] failed to stop embedded PostgreSQL:', err); }
}

async function emergencyCleanup(code: number): Promise<never> {
  if (!cleaningUp) {
    cleaningUp = true;
    try { runningChild?.kill(); } catch { /* ignore */ }
    await stopPg();
  }
  process.exit(code);
}

process.on('SIGINT', () => { void emergencyCleanup(130); });
process.on('SIGTERM', () => { void emergencyCleanup(143); });
process.on('exit', () => { try { runningChild?.kill(); } catch { /* ignore */ } });

// ── 0) Dependencies ─────────────────────────────────────────────────────────

function ensureDeps(): void {
  const nm = path.join(TEST_DIR, 'node_modules');
  const need = ['socket.io-client', 'ws'];
  if (!process.env.VERIFY_DATABASE_URL) need.push('embedded-postgres');
  const missing = need.filter((p) => !fs.existsSync(path.join(nm, p, 'package.json')));
  if (missing.length === 0) return;
  log(`installing the harness dependencies (${missing.join(', ')}) into server/test/node_modules ...`);
  const r = spawnSync(`npm ci --prefix "${TEST_DIR}" --no-audit --no-fund`, { stdio: 'inherit', shell: true, cwd: SERVER_DIR });
  if (r.status !== 0) {
    console.error('[verify] `npm ci` of server/test failed — run `npm run verify:setup -w server` and retry.');
    process.exit(1);
  }
}

// ── 1) Shared build ─────────────────────────────────────────────────────────

function buildShared(): void {
  if (process.env.VERIFY_SKIP_SHARED_BUILD === '1') return;
  const tsc = require.resolve('typescript/bin/tsc', { paths: [SERVER_DIR] });
  const r = spawnSync(process.execPath, [tsc, '-p', path.join(REPO_DIR, 'shared')], { stdio: 'inherit', cwd: REPO_DIR });
  if (r.status !== 0) {
    console.error('[verify] shared build failed');
    process.exit(1);
  }
}

// ── 2) Database server ──────────────────────────────────────────────────────

async function startDatabase(): Promise<string> {
  if (process.env.VERIFY_DATABASE_URL) {
    log('using VERIFY_DATABASE_URL (external PostgreSQL)');
    return process.env.VERIFY_DATABASE_URL;
  }
  // No literal 'embedded-postgres' specifier anywhere (ESM-only, no types):
  // resolve through the string `exports`, then import the file URL.
  const entry = require.resolve('embedded-postgres', { paths: [TEST_DIR] });
  const mod = await import(pathToFileURL(entry).href) as { default: EmbeddedPostgresCtor };
  const port = Number(process.env.VERIFY_PG_PORT) || await freePort();
  const customDir = process.env.VERIFY_PG_DIR;
  const databaseDir = customDir ?? path.join(WORK, 'pg');
  // A reused cluster (VERIFY_KEEP_DB=1 + VERIFY_PG_DIR) keeps the password it
  // was initialised with: persist it next to the data dir.
  const pwFile = path.join(databaseDir, '.verify-password');
  let password = crypto.randomBytes(12).toString('hex');
  const reuse = fs.existsSync(path.join(databaseDir, 'PG_VERSION'));
  if (reuse) {
    try { password = fs.readFileSync(pwFile, 'utf8').trim(); } catch {
      throw new Error(`VERIFY_PG_DIR ${databaseDir} holds a cluster without ${pwFile} — delete the directory or point VERIFY_PG_DIR elsewhere`);
    }
  } else if (customDir && fs.existsSync(customDir) && fs.readdirSync(customDir).length > 0) {
    throw new Error(`VERIFY_PG_DIR ${customDir} is not empty and is not a verify cluster — refusing to use it`);
  }
  const t0 = Date.now();
  pgServer = new mod.default({
    databaseDir,
    user: 'verify',
    password,
    port,
    persistent: KEEP,
    // --locale=C: English server messages on a localized Windows (some
    // controllers match on error texts, e.g. 'unique').
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: process.env.VERIFY_PG_LOG ? console.log : () => { /* quiet */ },
    onError: (e: unknown) => console.error('[pg]', e),
  });
  if (!reuse) {
    await pgServer.initialise();
    try { fs.writeFileSync(pwFile, password, { mode: 0o600 }); } catch { /* ignore */ }
  }
  await pgServer.start();
  log(`embedded PostgreSQL 16 on 127.0.0.1:${port} (${Date.now() - t0} ms, data ${databaseDir})`);
  return `postgres://verify:${password}@127.0.0.1:${port}/postgres`;
}

// ── 4) Template database ────────────────────────────────────────────────────

async function buildTemplate(tplUrl: string): Promise<void> {
  const k = knex({ client: 'pg', connection: tplUrl, pool: { min: 0, max: 2 } });
  try {
    const t0 = Date.now();
    const [, applied] = await k.migrate.latest({
      directory: path.join(SERVER_DIR, 'src', 'db', 'migrations'),
      loadExtensions: ['.ts'],
    }) as [number, string[]];
    log(`template: ${applied.length} migrations applied in ${Date.now() - t0} ms`);
    await seedFixtures(k);
    log('template: fixtures seeded');
  } finally {
    await k.destroy();
  }
}

// ── 6) Suites ───────────────────────────────────────────────────────────────

interface Directives { env: Record<string, string>; emptyDb: boolean }

function parseDirectives(file: string): Directives {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 15);
  const env: Record<string, string> = {};
  let emptyDb = false;
  for (const line of lines) {
    const e = /^\s*\/\/\s*verify-env:\s*(.+)$/.exec(line);
    if (e) {
      for (const pair of e[1].trim().split(/\s+/)) {
        const eq = pair.indexOf('=');
        if (eq <= 0) throw new Error(`${path.basename(file)}: bad verify-env entry "${pair}"`);
        const key = pair.slice(0, eq);
        if (RESERVED_KEYS.has(key)) throw new Error(`${path.basename(file)}: verify-env may not set reserved key ${key}`);
        env[key] = pair.slice(eq + 1);
      }
    }
    if (/^\s*\/\/\s*verify-db:\s*empty\s*$/.test(line)) emptyDb = true;
  }
  return { env, emptyDb };
}

function childEnv(suiteUrl: string, adminUrl: string, reportFile: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SCRUB_RE.test(k)) env[k] = v;
  }
  Object.assign(env, {
    NODE_ENV: 'test',
    OBLIGUARD_VERIFY: '1',
    DATABASE_URL: suiteUrl,
    VERIFY_ADMIN_URL: adminUrl,
    VERIFY_REPORT_FILE: reportFile,
    DATABASE_POOL_MAX: '5',
    SESSION_SECRET: crypto.randomBytes(24).toString('hex'),
    APP_URL: 'http://verify.local',
    CLIENT_ORIGIN: 'http://verify.local',
    SSO_ALLOWED_HOSTS: '',
    FORCE_HTTPS: 'false',
    DISABLE_2FA_FORCE: 'false',
    BAN_MIN_PREFIX_V4: '16',
    BAN_MIN_PREFIX_V6: '48',
    AGENT_KEY_BINDING: 'strict',
    AGENT_MAX_PENDING_PER_KEY: '500',
  });
  Object.assign(env, extra);
  return env;
}

function runSuite(file: string, env: NodeJS.ProcessEnv, tapFile: string): Promise<{ code: number; timedOut: boolean }> {
  const guardUrl = pathToFileURL(path.join(TEST_DIR, 'guard.ts')).href;
  const args = [
    '--disable-warning=DEP0169',
    '--import', 'tsx',
    '--import', guardUrl,
    '--test', '--test-isolation=none', '--test-force-exit',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${tapFile}`,
    file,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: SERVER_DIR, env, stdio: 'inherit' });
    runningChild = child;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[verify] ${path.basename(file)}: timeout after ${SUITE_TIMEOUT_MS} ms — killed`);
      try { child.kill(); } catch { /* ignore */ }
    }, SUITE_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      runningChild = null;
      resolve({ code: code ?? 1, timedOut });
    });
  });
}

interface SuiteOutcome { name: string; ok: boolean; seconds: number; tapFile: string; reportFile: string }

// ── 7) Report ───────────────────────────────────────────────────────────────

const TODO_RE = /^\s*(not )?ok \d+ - (.*) \[([A-Z]\d+|UNTRACKED)\] # TODO/;

function report(outcomes: SuiteOutcome[]): void {
  log('');
  log('Suites');
  for (const o of outcomes) log(`  ${o.name.padEnd(40)} ${o.ok ? 'PASS' : 'FAIL'}  ${o.seconds.toFixed(1)} s`);

  for (const o of outcomes) {
    if (!fs.existsSync(o.reportFile)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(o.reportFile, 'utf8')) as { unhandled?: string[]; blockedNetwork?: string[]; blockedDns?: string[] };
      const un = r.unhandled ?? [];
      const bn = r.blockedNetwork ?? [];
      const bd = r.blockedDns ?? [];
      if (un.length === 0 && bn.length === 0 && bd.length === 0) continue;
      log(`  ${o.name}: ${un.length} unhandled rejection(s), ${bn.length} blocked outbound call(s), ${bd.length} blocked DNS lookup(s) (informational)`);
      for (const u of un.slice(0, 3)) log(`    unhandled: ${u.split('\n')[0]}`);
      for (const b of bn.slice(0, 3)) log(`    blocked:   ${b}`);
      for (const b of bd.slice(0, 3)) log(`    blocked:   ${b}`);
    } catch { /* ignore */ }
  }

  const pending = new Map<string, { total: number; pass: number; fail: number }>();
  for (const o of outcomes) {
    if (!fs.existsSync(o.tapFile)) continue;
    for (const line of fs.readFileSync(o.tapFile, 'utf8').split(/\r?\n/)) {
      const m = TODO_RE.exec(line);
      if (!m) continue;
      const lot = m[3];
      const e = pending.get(lot) ?? { total: 0, pass: 0, fail: 0 };
      e.total++;
      if (m[1]) e.fail++; else e.pass++;
      pending.set(lot, e);
    }
  }
  log('');
  log('Pending lot checks (node:test TODO)');
  if (pending.size === 0) log('  none');
  const lots = [...pending.keys()].sort();
  for (const lot of lots) {
    const e = pending.get(lot)!;
    log(`  ${lot.padEnd(10)} total ${String(e.total).padStart(3)}   passing now ${String(e.pass).padStart(3)}   failing now ${String(e.fail).padStart(3)}`);
  }
  for (const lot of lots) {
    const e = pending.get(lot)!;
    if (lot !== 'UNTRACKED' && e.fail === 0 && e.total > 0) log(`  flip "${lot}": true in server/test/lots.json`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  fs.mkdirSync(WORK, { recursive: true });
  ensureDeps();
  buildShared();

  const adminUrl = await startDatabase();
  const RUN = `verify_${crypto.randomBytes(3).toString('hex')}`;
  const tplName = `${RUN}_tpl`;
  await adminQuery(adminUrl, `CREATE DATABASE "${tplName}"`);

  let exitCode = 0;
  const outcomes: SuiteOutcome[] = [];
  try {
    try {
      await buildTemplate(withDb(adminUrl, tplName));
    } catch (err) {
      console.error('[verify] migrations/seed failed:', err);
      outcomes.push({ name: 'migrations', ok: false, seconds: 0, tapFile: '', reportFile: '' });
      report(outcomes);
      exitCode = 1;
      return exitCode;
    }

    const suites = fs.readdirSync(SUITES_DIR)
      .filter((f) => f.endsWith('.test.ts'))
      .sort()
      .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)));
    if (suites.length === 0) log('no suite matches the filters');

    for (let i = 0; i < suites.length; i++) {
      const file = path.join(SUITES_DIR, suites[i]);
      const directives = parseDirectives(file);
      const dbName = `${RUN}_${pad2(i)}`;
      await adminQuery(adminUrl, `CREATE DATABASE "${dbName}" TEMPLATE "${directives.emptyDb ? 'template0' : tplName}"`);
      const tapFile = path.join(WORK, `tap-${pad2(i)}.tap`);
      const reportFile = path.join(WORK, `report-${pad2(i)}.json`);
      const env = childEnv(withDb(adminUrl, dbName), adminUrl, reportFile, directives.env);
      log(`── ${suites[i]} ──`);
      const t0 = Date.now();
      const { code, timedOut } = await runSuite(file, env, tapFile);
      const ok = code === 0 && !timedOut;
      if (!ok) exitCode = 1;
      outcomes.push({ name: suites[i], ok, seconds: (Date.now() - t0) / 1000, tapFile, reportFile });
      if (!KEEP) {
        await adminQuery(adminUrl, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch((err) => console.error('[verify] drop failed:', err));
      }
    }
    report(outcomes);
  } finally {
    if (!KEEP) await adminQuery(adminUrl, `DROP DATABASE IF EXISTS "${tplName}" WITH (FORCE)`).catch(() => { /* ignore */ });
    await stopPg();
    if (!KEEP) {
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ }
    } else {
      log(`kept: ${WORK} (databases ${RUN}_*)`);
    }
  }
  return exitCode;
}

// Explicit exit: embedded-postgres registers async-exit-hook, whose
// `beforeExit` handler calls process.exit(0) and would override
// process.exitCode — the gate must be able to fail.
main().then(
  (code) => process.exit(code),
  async (err) => {
    console.error('[verify] fatal:', err);
    await stopPg();
    process.exit(1);
  },
);
