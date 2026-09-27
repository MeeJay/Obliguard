// verify-db: empty
/**
 * 14 — data migrations on legacy rows. No harness: this suite owns its knex
 * instances, on the suite's EMPTY database and on two sub-databases
 * (<db>_m2, <db>_m3) created from template0 through VERIFY_ADMIN_URL and
 * dropped in after() unless VERIFY_KEEP_DB=1.
 *
 * Imposed migration numbers (owner answers, wave 1): A1 = 026, C17 = 027,
 * A4 = 028, D4 = 029. A lot that lands under another number updates these
 * constants in its landing commit.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import knex from 'knex';
import type { Knex } from 'knex';
import { lotIt } from '../lots';

const A4_MIGRATION = 28;
const D4_MIGRATION = 29;
const MIG_DIR = path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations');
const MIG_CFG = { directory: MIG_DIR, loadExtensions: ['.ts'] };

const DB_URL = process.env.DATABASE_URL!;
const ADMIN_URL = process.env.VERIFY_ADMIN_URL!;
const DB_NAME = new URL(DB_URL).pathname.slice(1);

function urlFor(name: string): string {
  const u = new URL(DB_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

async function migrateBelow(k: Knex, prefix: number): Promise<void> {
  for (;;) {
    const [, pending] = await k.migrate.list(MIG_CFG) as [unknown[], Array<{ file: string }>];
    const next = pending[0];
    if (!next || Number(path.basename(next.file).slice(0, 3)) >= prefix) return;
    await k.migrate.up(MIG_CFG);
  }
}

describe('14 migration data', () => {
  const instances: Knex[] = [];
  const subDbs: string[] = [];
  let admin: Knex;

  const open = (url: string) => {
    const k = knex({ client: 'pg', connection: url, pool: { min: 0, max: 2 } });
    instances.push(k);
    return k;
  };
  const subDb = async (suffix: string) => {
    const name = `${DB_NAME}_${suffix}`;
    await admin.raw(`CREATE DATABASE "${name}" TEMPLATE template0`);
    subDbs.push(name);
    return open(urlFor(name));
  };

  before(() => { admin = knex({ client: 'pg', connection: ADMIN_URL, pool: { min: 0, max: 1 } }); });
  after(async () => {
    for (const k of instances) await k.destroy().catch(() => {});
    if (process.env.VERIFY_KEEP_DB !== '1') {
      for (const name of subDbs) await admin.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    }
    await admin.destroy();
  });

  lotIt('UNTRACKED', '14.1 a fresh install can create its first tenant', async () => {
    const k = open(DB_URL);
    await k.migrate.latest(MIG_CFG);
    const [row] = await k('tenants').insert({ name: 'Fresh', slug: 'fresh' }).returning('id') as Array<{ id: number }>;
    assert.ok(row.id > 1);
  });

  lotIt('A4', '14.2 legacy whitelist rows are re-stamped to their scope tenant, never onto a wrong one', async () => {
    const k = await subDb('m2');
    await migrateBelow(k, A4_MIGRATION);
    await k('tenants').insert([{ id: 2, name: 'B', slug: 'b' }, { id: 3, name: 'C', slug: 'c' }]);
    await k('users').insert([
      { id: 1, username: 'admin', password_hash: 'x', role: 'admin' },
      { id: 2, username: 'm3', password_hash: 'x', role: 'user' },
    ]);
    await k('user_tenants').insert({ user_id: 2, tenant_id: 3, role: 'member' });
    await k('monitor_groups').insert({ id: 10, name: 'g10', slug: 'g10', kind: 'agent', tenant_id: 2 });
    await k('group_closure').insert({ ancestor_id: 10, descendant_id: 10, depth: 0 });
    await k('agent_devices').insert({ id: 20, uuid: 'm2-dev-20', hostname: 'h20', status: 'approved', tenant_id: 2 });
    const ins = async (o: Record<string, unknown>, cidr: string) => {
      const [r] = await k('ip_whitelist').insert({ ...o, ip: k.raw('?::cidr', [cidr]) }).returning('id') as Array<{ id: number }>;
      return r.id;
    };
    const a = await ins({ scope: 'group', scope_id: 10, tenant_id: 1, created_by: 1 }, '192.0.2.10/32');
    const b = await ins({ scope: 'agent', scope_id: 20, tenant_id: 1, created_by: 1 }, '192.0.2.11/32');
    const c = await ins({ scope: 'group', scope_id: 10, tenant_id: 3, created_by: 2 }, '192.0.2.12/32');
    await k.migrate.latest(MIG_CFG);
    assert.equal((await k('ip_whitelist').where({ id: a }).first())?.tenant_id, 2);
    assert.equal((await k('ip_whitelist').where({ id: b }).first())?.tenant_id, 2);
    const rc = await k('ip_whitelist').where({ id: c }).first();
    assert.ok(!rc || rc.tenant_id === 3, 'row (c) must never be re-stamped onto tenant 2');
    await ins({ scope: 'tenant', tenant_id: 2 }, '192.0.2.13/32');
    await ins({ scope: 'tenant', tenant_id: 3 }, '192.0.2.13/32');
  });

  lotIt('D4', '14.3 duplicate active bans are deduplicated without losing exclusions', async () => {
    const k = await subDb('m3');
    await migrateBelow(k, D4_MIGRATION);
    await k('tenants').insert([{ id: 2, name: 'B', slug: 'b' }, { id: 3, name: 'C', slug: 'c' }]);
    const ban = (id: number, ip: string, o: Record<string, unknown>) =>
      k('ip_bans').insert({ id, ip: k.raw('?::inet', [ip]), ban_type: 'manual', is_active: true, ...o });
    await ban(100, '192.0.2.20', { scope: 'global', banned_at: new Date(Date.now() - 2 * 3600_000) });
    await ban(101, '192.0.2.20', { scope: 'global', banned_at: new Date(Date.now() - 3600_000) });
    await k('ip_ban_exclusions').insert({ ban_id: 101, tenant_id: 2 });
    await ban(102, '192.0.2.21', { scope: 'tenant', tenant_id: 2 });
    await ban(103, '192.0.2.21', { scope: 'tenant', tenant_id: 2 });
    await ban(104, '192.0.2.21', { scope: 'tenant', tenant_id: 3 });
    const exBefore = await k('ip_ban_exclusions').select('ban_id', 'tenant_id');
    await k.migrate.latest(MIG_CFG);

    const g = await k('ip_bans').whereRaw("host(ip) = '192.0.2.20'").where({ scope: 'global', is_active: true });
    assert.equal(g.length, 1);
    assert.ok(await k('ip_ban_exclusions').where({ ban_id: g[0].id, tenant_id: 2 }).first(), 'exclusion must follow the kept row');
    const t2 = await k('ip_bans').whereRaw("host(ip) = '192.0.2.21'").where({ tenant_id: 2, is_active: true });
    assert.equal(t2.length, 1);
    assert.equal((await k('ip_bans').where({ id: 104 }).first())?.is_active, true);
    const remaining = await k('ip_bans').whereIn('id', [100, 101, 102, 103, 104]).pluck('id');
    if (remaining.length < 5) {
      const exAfter = await k('ip_ban_exclusions').select('tenant_id');
      assert.ok(exAfter.length >= exBefore.length, 'rows were deleted and an exclusion was lost');
    }
    await assert.rejects(ban(105, '192.0.2.20', { scope: 'global' }), (err: any) => err?.code === '23505');
  });
});
