/**
 * 91 — W12-3 auto-ban duration policy (ADMIN-FEATURES-17 / D4): one
 * platform policy in app_config 'banPolicy' = { autoBanTtlSeconds (null =
 * permanent), ladder: [{ priorBans, ttlSeconds }] } read by the BanEngine
 * when it creates a global auto-ban. The ladder step is picked from the
 * number of earlier bans of the address (any scope, type or state).
 *
 *   - nothing stored: auto-bans stay permanent (historical behaviour);
 *   - GET /api/admin/config/ban-policy for every signed-in user (read-only
 *     summary), PUT for the platform admin operating the Default tenant
 *     (403 from another tenant, for tenant admins and members), validated
 *     (ttl >= 300 s, ladder strictly ascending, never shorter) and audited;
 *   - a write applies to the next cycle (the service cache is dropped).
 *
 * Every test starts from the default policy (reset in afterEach).
 */
import { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createUser, insertBan, insertEvents, nextIp } from '../seed';
import { banEngine } from '../../src/services/ban.service';
import { banPolicyService } from '../../src/services/banPolicy.service';

const PATH = '/api/admin/config/ban-policy';
const HOUR = 3600;
const DAY = 86400;

describe('91 auto-ban duration policy', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  afterEach(async () => { await banPolicyService.set(null); });
  after(async () => { await h.close(); });

  /** Auth failures over the fixture threshold, one engine cycle, the address's active global auto-ban. */
  const autoBan = async (ip: string) => {
    await insertEvents(h.db, { deviceId: 2, tenantId: 2, ip, count: 6 });
    await banEngine.run();
    const row = await h.db('ip_bans')
      .whereRaw('host(ip) = ?', [ip])
      .where({ scope: 'global', ban_type: 'auto', is_active: true })
      .first('id', 'expires_at', 'banned_at') as { id: number; expires_at: Date | null; banned_at: Date } | undefined;
    assert.ok(row, `${ip} is auto-banned`);
    return row;
  };

  /** expires_at is `ttl` seconds after now, within the cycle's slack. */
  const assertExpiresIn = (expiresAt: Date | null, ttl: number, at: number) => {
    assert.ok(expiresAt, 'timed ban');
    const delta = new Date(expiresAt).getTime() - at;
    assert.ok(Math.abs(delta - ttl * 1000) < 60_000, `expires in ${Math.round(delta / 1000)} s, expected ~${ttl} s`);
  };

  lotIt('W12-3', '91.1 default policy: auto-bans stay permanent', async () => {
    const admin = await h.adminIn(1);
    const r = await admin.get(PATH);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.source, 'default');
    assert.deepEqual(r.json.data.policy, { autoBanTtlSeconds: null, ladder: [] });
    assert.equal(r.json.data.limits.minTtlSeconds, 300);

    const row = await autoBan(nextIp());
    assert.equal(row.expires_at, null, 'no policy = permanent auto-ban');
  });

  lotIt('W12-3', '91.2 ttl 3600: the next auto-ban expires ~1 h later; the write is audited', async () => {
    const admin = await h.adminIn(1);
    const put = await admin.put(PATH, { autoBanTtlSeconds: HOUR, ladder: [] });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.data.source, 'platform');
    assert.deepEqual(put.json.data.policy, { autoBanTtlSeconds: HOUR, ladder: [] });
    const stored = await h.db('app_config').where({ key: 'banPolicy' }).first('value');
    assert.deepEqual(JSON.parse(stored.value), { autoBanTtlSeconds: HOUR, ladder: [] });

    const at = Date.now();
    const row = await autoBan(nextIp());
    assertExpiresIn(row.expires_at, HOUR, at);

    const audit = await h.db('audit_logs').where({ action: 'app_config.ban_policy_updated' }).orderBy('id', 'desc').first();
    assert.ok(audit, 'audited');
    assert.equal(audit.tenant_id, null, 'instance-level row');
    const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    assert.deepEqual(details.to, { autoBanTtlSeconds: HOUR, ladder: [] });

    // Back to the default: the next auto-ban is permanent again.
    const reset = await admin.put(PATH, { policy: null });
    assert.equal(reset.status, 200, reset.text);
    assert.equal(reset.json.data.source, 'default');
    assert.equal(await h.db('app_config').where({ key: 'banPolicy' }).first(), undefined);
    assert.equal((await autoBan(nextIp())).expires_at, null);
  });

  lotIt('W12-3', '91.3 repeat offenders: the ladder step matching the earlier bans applies', async () => {
    const admin = await h.adminIn(1);
    const put = await admin.put(PATH, {
      autoBanTtlSeconds: HOUR,
      ladder: [{ priorBans: 1, ttlSeconds: DAY }, { priorBans: 2, ttlSeconds: null }],
    });
    assert.equal(put.status, 200, put.text);

    // First offence: base duration.
    const first = nextIp();
    let at = Date.now();
    assertExpiresIn((await autoBan(first)).expires_at, HOUR, at);

    // The same address offends again once its own timed auto-ban ran out
    // (row still flagged active, the expiry job has not run): the engine
    // retires it, counts it as an earlier ban and applies step 1.
    const firstBan = await h.db('ip_bans')
      .whereRaw('host(ip) = ?', [first])
      .where({ scope: 'global', ban_type: 'auto', is_active: true })
      .first('id') as { id: number };
    await h.db('ip_bans').where({ id: firstBan.id }).update({ expires_at: new Date(Date.now() - 1000) });
    at = Date.now();
    const again = await autoBan(first);
    assert.notEqual(again.id, firstBan.id, 'a new auto-ban row');
    assertExpiresIn(again.expires_at, DAY, at);
    const retired = await h.db('ip_bans').where({ id: firstBan.id }).first('is_active') as { is_active: boolean };
    assert.equal(retired.is_active, false, 'the expired ban was deactivated');

    // Second offence (one earlier ban, expired): first ladder step.
    const second = nextIp();
    await insertBan(h.db, { ip: second, scope: 'global', banType: 'auto', originTenantId: 2, isActive: false, expiresAt: new Date(Date.now() - DAY * 1000) });
    at = Date.now();
    assertExpiresIn((await autoBan(second)).expires_at, DAY, at);

    // Third offence (two earlier bans in any state / scope): permanent step.
    const third = nextIp();
    await insertBan(h.db, { ip: third, scope: 'global', banType: 'auto', originTenantId: 2, isActive: false });
    await insertBan(h.db, { ip: third, scope: 'tenant', tenantId: 2, banType: 'manual', originTenantId: 2, isActive: false });
    assert.equal((await autoBan(third)).expires_at, null, 'third offence: permanent');

    // A subnet ban starting at the address (same `ip`, shorter prefix) is
    // not an earlier ban of the address: one host ban + one /31 = step 1.
    let sub = nextIp();
    while (Number(sub.split('.')[3]) % 2 !== 0) sub = nextIp();
    await insertBan(h.db, { ip: sub, cidrPrefix: 32, scope: 'tenant', tenantId: 3, originTenantId: 3, isActive: false });
    await insertBan(h.db, { ip: sub, cidrPrefix: 31, scope: 'tenant', tenantId: 3, originTenantId: 3, isActive: false });
    at = Date.now();
    assertExpiresIn((await autoBan(sub)).expires_at, DAY, at);
  });

  lotIt('W12-3', '91.4 validation: ttl >= 300 s, ladder ascending and never shorter', async () => {
    const admin = await h.adminIn(1);
    const bad: Array<[string, unknown]> = [
      ['ttl below 300 s', { autoBanTtlSeconds: 299, ladder: [] }],
      ['ttl above one year', { autoBanTtlSeconds: 366 * DAY, ladder: [] }],
      ['ttl not an integer', { autoBanTtlSeconds: 3600.5, ladder: [] }],
      ['ttl as a string', { autoBanTtlSeconds: '3600', ladder: [] }],
      ['ttl missing', { ladder: [] }],
      ['ladder not an array', { autoBanTtlSeconds: HOUR, ladder: {} }],
      ['priorBans 0', { autoBanTtlSeconds: HOUR, ladder: [{ priorBans: 0, ttlSeconds: DAY }] }],
      ['ladder not ascending', { autoBanTtlSeconds: HOUR, ladder: [{ priorBans: 2, ttlSeconds: DAY }, { priorBans: 1, ttlSeconds: DAY }] }],
      ['duplicate step', { autoBanTtlSeconds: HOUR, ladder: [{ priorBans: 1, ttlSeconds: DAY }, { priorBans: 1, ttlSeconds: 2 * DAY }] }],
      ['shorter than the base', { autoBanTtlSeconds: DAY, ladder: [{ priorBans: 1, ttlSeconds: HOUR }] }],
      ['timed after permanent', { autoBanTtlSeconds: HOUR, ladder: [{ priorBans: 1, ttlSeconds: null }, { priorBans: 2, ttlSeconds: DAY }] }],
      ['step ttl below 300 s', { autoBanTtlSeconds: null, ladder: [{ priorBans: 1, ttlSeconds: 60 }] }],
      ['too many steps', { autoBanTtlSeconds: HOUR, ladder: Array.from({ length: 11 }, (_, i) => ({ priorBans: i + 1, ttlSeconds: DAY })) }],
    ];
    for (const [what, body] of bad) {
      const r = await admin.put(PATH, body);
      assert.equal(r.status, 400, `${what}: ${r.status} ${r.text.slice(0, 120)}`);
    }
    assert.equal(await h.db('app_config').where({ key: 'banPolicy' }).first(), undefined, 'nothing stored');

    // Equal durations and the 300 s floor are accepted; wrapped under `policy` too.
    const ok = await admin.put(PATH, { policy: { autoBanTtlSeconds: 300, ladder: [{ priorBans: 1, ttlSeconds: 300 }, { priorBans: 3, ttlSeconds: null }] } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.json.data.policy.ladder, [{ priorBans: 1, ttlSeconds: 300 }, { priorBans: 3, ttlSeconds: null }]);
  });

  lotIt('W12-3', '91.5 access: everyone reads, only the platform admin on Default writes', async () => {
    const body = { autoBanTtlSeconds: HOUR, ladder: [] };
    const anon = h.anon();
    assert.equal((await anon.get(PATH)).status, 401);
    assert.equal((await anon.put(PATH, body)).status, 401);

    const member = await h.as('member_b');
    const read = await member.get(PATH);
    assert.equal(read.status, 200, 'read-only summary for members');
    assert.equal(read.json.data.source, 'default');
    assert.equal((await member.put(PATH, body)).status, 403);
    const tenantAdmin = await createUser(h.db, { tenants: [2], tenantRole: 'admin' });
    assert.equal((await (await h.login(tenantAdmin.username)).put(PATH, body)).status, 403, 'tenant admin');
    const platformB = await h.adminIn(2);
    const r = await platformB.put(PATH, body);
    assert.equal(r.status, 403, 'platform admin operating another tenant');
    assert.equal(await h.db('app_config').where({ key: 'banPolicy' }).first(), undefined);

    // The engine follows a direct service write at once (cache dropped).
    await banPolicyService.set({ autoBanTtlSeconds: 2 * HOUR, ladder: [] });
    const at = Date.now();
    assertExpiresIn((await autoBan(nextIp())).expires_at, 2 * HOUR, at);
    assert.equal((await member.get(PATH)).json.data.policy.autoBanTtlSeconds, 2 * HOUR);
  });
});
