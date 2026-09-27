/**
 * 00 — meta checks (migrations, merge order, opt-in templates, IO wiring, health).
 *
 * ── Suite conventions (every suite) ────────────────────────────────────────
 * (a) Addresses follow the IP policy of fixtures.ts: nextIp() for dynamic
 *     addresses, litIp() literal blocks only, exact-IP list assertions.
 * (b) A check expecting a write to be REFUSED targets a per-test throwaway
 *     object (createDevice, createGroup, createKey, createUser, insertBan,
 *     insertWhitelist), never a shared fixture row: on the baseline the write
 *     succeeds. A TODO that would write through a shared path is ordered so
 *     the baseline aborts before any write (05#6 / 05#7 lead with 'not-an-ip').
 * (c) State restoration runs in finally or afterEach, never after an
 *     assertion that can throw.
 * (d) Destructive checks run last in 05: 05#15, then 05#16.
 * (e) Every status assertion is paired with a DB-state assertion.
 * (f) Where lot plans legitimately differ, assert a status set (403|404,
 *     400|422) plus the invariant.
 * (g) No sleep, except 01#5 (sessionUserGuard TTL). Waits are waitFor with a
 *     bounded timeout, or a SENTINEL: a later event that must arrive, before
 *     which nothing forbidden may appear. Fire-and-forget side effects
 *     (Obligate register, MikroTik pushes) are drained with a sentinel whose
 *     waitFor failure is tolerated (drain()), then asserted.
 * (h) Every FakeWs and ws client is closed in finally (obliguardHub is a
 *     per-process singleton).
 * (i) The TOTP fixture user serves ONE successful verify per suite; other
 *     TOTP checks use createTotpUser.
 * Test titles carry their check id as "NN.k" plus the owning lot tag.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { startHarness, WIRED_IO_SETTERS } from '../harness';
import type { Harness } from '../harness';

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const REPO_DIR = path.resolve(SERVER_DIR, '..');
const MIG_DIR = path.join(SERVER_DIR, 'src', 'db', 'migrations');
const MIG_REL = 'server/src/db/migrations';

function prefixOf(name: string): number {
  return Number(path.basename(name).slice(0, 3));
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO_DIR, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function lsMigrations(rev: string): string[] {
  return git(['ls-tree', '--name-only', `${rev}:${MIG_REL}`])
    .split(/\r?\n/).map((s) => s.trim()).filter((s) => s.endsWith('.ts'));
}

describe('00 meta', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  it('00.1 migration files are unique, contiguous and applied in sorted order [BASELINE]', async () => {
    const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.ts')).sort();
    assert.ok(files.length > 0);
    for (const f of files) assert.match(f, /^\d{3}_[a-z0-9_]+\.ts$/, `bad migration file name ${f}`);
    const prefixes = files.map(prefixOf);
    assert.equal(new Set(prefixes).size, prefixes.length, 'duplicate migration prefixes');
    prefixes.forEach((p, i) => assert.equal(p, i + 1, `migration prefixes must be contiguous from 001 (got ${files[i]})`));
    const applied = await h.db('knex_migrations').orderBy('id').pluck('name') as string[];
    assert.deepEqual(applied, files);
  });

  it('00.2 merge-order guard: new migrations are numbered above everything committed [BASELINE]', (t) => {
    try {
      git(['rev-parse', 'HEAD']);
    } catch {
      t.skip('git not available');
      return;
    }
    const head = lsMigrations('HEAD');
    const headMax = Math.max(0, ...head.map(prefixOf));
    const headSet = new Set(head);
    const tree = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.ts'));
    for (const f of tree) {
      if (!headSet.has(f)) assert.ok(prefixOf(f) > headMax, `uncommitted migration ${f} must be numbered above ${headMax}`);
    }

    const anchors = git(['log', '--diff-filter=A', '--format=%H', '--', 'server/test/lots.json'])
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const anchor = anchors[anchors.length - 1];
    if (!anchor) return; // D8 not committed yet: only the working-tree check applies
    const commits = git(['rev-list', '--first-parent', '--reverse', `${anchor}..HEAD`])
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const c of commits) {
      const added = git(['diff-tree', '-r', '--no-commit-id', '--diff-filter=A', '--name-only', `${c}^`, c, '--', MIG_REL])
        .split(/\r?\n/).map((s) => s.trim()).filter((s) => s.endsWith('.ts'));
      if (added.length === 0) continue;
      const parentMax = Math.max(0, ...lsMigrations(`${c}^`).map(prefixOf));
      for (const f of added) {
        assert.ok(prefixOf(f) > parentMax, `commit ${c.slice(0, 10)} adds ${path.basename(f)} below the committed max ${parentMax}`);
      }
    }
  });

  it('00.3 built-in platform templates stay opt-in [BASELINE]', async () => {
    const [{ count }] = await h.db('service_templates')
      .where({ is_builtin: true, enabled: true })
      .whereNull('owner_scope')
      .count<{ count: string }[]>({ count: '*' });
    assert.equal(Number(count), 0);
  });

  it('00.4 harness wiring mirrors the set*IO calls of index.ts [BASELINE]', () => {
    const src = fs.readFileSync(path.join(SERVER_DIR, 'src', 'index.ts'), 'utf8');
    const called = new Set([...src.matchAll(/\b(set[A-Za-z0-9]*IO)\(\s*io\s*\)/g)].map((m) => m[1]));
    assert.deepEqual([...called].sort(), [...WIRED_IO_SETTERS].sort());
  });

  it('00.5 tenants sequence, health and anonymous refusal [BASELINE]', async () => {
    const [row] = await h.db('tenants').insert({ name: 'Seq', slug: 'seq-check' }).returning('id') as Array<{ id: number }>;
    try {
      assert.ok(row.id > 3, `new tenant id ${row.id} must be > 3`);
    } finally {
      await h.db('tenants').where({ id: row.id }).delete();
    }
    const health = await h.anon().get('/health');
    assert.equal(health.status, 200);
    assert.equal(health.json?.status, 'ok');
    const bans = await h.anon().get('/api/bans');
    assert.equal(bans.status, 401);
  });
});
