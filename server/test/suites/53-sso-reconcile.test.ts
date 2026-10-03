/**
 * 53 — A10 / W4-2: SSO reconciles tenant and team memberships from the
 * Obligate assertion (owner decision 9: Obligate is the source of truth of
 * og_ accounts). What an assertion no longer grants is removed at sign-in,
 * unless OBLIGATE_PRUNE_MEMBERSHIPS=false; accounts linked to a local account
 * are never pruned.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, waitFor } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { TEAMS } from '../fixtures';
import { createUser } from '../seed';

describe('53 SSO membership reconcile (A10)', () => {
  let h: Harness;
  before(async () => { h = await startHarness({ obligate: true }); });
  after(async () => { await h.close(); });

  const tenantsOf = async (userId: number): Promise<number[]> =>
    (await h.db('user_tenants').where({ user_id: userId }).orderBy('tenant_id').pluck('tenant_id')).map(Number);
  const teamsOf = async (userId: number): Promise<number[]> =>
    (await h.db('team_memberships').where({ user_id: userId }).orderBy('team_id').pluck('team_id')).map(Number);
  const userIdOf = async (obligateUserId: number): Promise<number> =>
    Number((await h.db('sso_foreign_users').where({ foreign_source: 'obligate', foreign_user_id: obligateUserId }).first()).local_user_id);

  /** Runs `fn` with OBLIGATE_PRUNE_MEMBERSHIPS set, then restores the previous value. */
  const withPruneEnv = async (value: string, fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.OBLIGATE_PRUNE_MEMBERSHIPS;
    process.env.OBLIGATE_PRUNE_MEMBERSHIPS = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.OBLIGATE_PRUNE_MEMBERSHIPS;
      else process.env.OBLIGATE_PRUNE_MEMBERSHIPS = prev;
    }
  };

  lotIt('A10', '53.1 a tenant no longer asserted is removed and refused at once', async () => {
    const first = await h.ssoLogin({
      obligateUserId: 9301, username: 'rev1', role: 'user',
      tenants: [{ slug: 'default', role: 'member' }, { slug: 'tenant-b', role: 'member' }],
    });
    assert.equal(first.callback.status, 200);
    const uid = await userIdOf(9301);
    assert.deepEqual(await tenantsOf(uid), [1, 2]);

    // The first session works in tenant 1 (its access decision is now cached).
    await h.setSessionTenant(first.client, 1);
    assert.equal((await first.client.get('/api/bans')).status, 200);

    const second = await h.ssoLogin({
      obligateUserId: 9301, username: 'rev1', role: 'user',
      tenants: [{ slug: 'tenant-b', role: 'member' }],
    });
    assert.equal(second.callback.status, 200);
    assert.deepEqual(await tenantsOf(uid), [2]);

    // The older session sitting on tenant 1 is refused without waiting for the cache TTL.
    const refused = await first.client.get('/api/bans');
    assert.equal(refused.status, 403);
    assert.equal(refused.json?.code, 'noTenantAccess');

    // The new session lands on the remaining tenant.
    const me = await second.client.get('/api/auth/me');
    assert.equal(me.json?.data?.currentTenantId, 2);
    assert.equal((await second.client.get('/api/bans')).status, 200);

    // /auth/me moves the old session onto the remaining tenant too.
    const meOld = await first.client.get('/api/auth/me');
    assert.equal(meOld.json?.data?.currentTenantId, 2);
  });

  lotIt('A10', '53.2 the last tenant revoked leaves the new session without tenant', async () => {
    await h.ssoLogin({ obligateUserId: 9302, username: 'rev2', role: 'user', tenants: [{ slug: 'tenant-c', role: 'member' }] });
    const uid = await userIdOf(9302);
    assert.deepEqual(await tenantsOf(uid), [3]);
    const r = await h.ssoLogin({ obligateUserId: 9302, username: 'rev2', role: 'user', tenants: [] });
    assert.equal(r.callback.status, 200);
    assert.deepEqual(await tenantsOf(uid), []);
    const me = await r.client.get('/api/auth/me');
    assert.equal(me.json?.data?.noTenantAccess, true);
    assert.equal(me.json?.data?.currentTenantId ?? null, null);
    assert.equal((await r.client.get('/api/bans')).status, 403);
  });

  lotIt('A10', '53.3 team memberships follow the assertion (by name, per tenant)', async () => {
    await h.ssoLogin({
      obligateUserId: 9303, username: 'rev3', role: 'user', teams: [TEAMS.B_TEAM.name, TEAMS.C_TEAM.name],
      tenants: [{ slug: 'tenant-b', role: 'member' }, { slug: 'tenant-c', role: 'member' }],
    });
    const uid = await userIdOf(9303);
    assert.deepEqual(await teamsOf(uid), [TEAMS.C_TEAM.id, TEAMS.B_TEAM.id].sort((a, b) => a - b));

    // B-team no longer asserted inside an asserted tenant: removed.
    await h.ssoLogin({
      obligateUserId: 9303, username: 'rev3', role: 'user', teams: [TEAMS.C_TEAM.name],
      tenants: [{ slug: 'tenant-b', role: 'member' }, { slug: 'tenant-c', role: 'member' }],
    });
    assert.deepEqual(await teamsOf(uid), [TEAMS.C_TEAM.id]);
    assert.deepEqual(await tenantsOf(uid), [2, 3]);

    // Tenant C no longer asserted: its team memberships go with it, even
    // though the team name is still asserted.
    await h.ssoLogin({
      obligateUserId: 9303, username: 'rev3', role: 'user', teams: [TEAMS.C_TEAM.name],
      tenants: [{ slug: 'tenant-b', role: 'member' }],
    });
    assert.deepEqual(await teamsOf(uid), []);
    assert.deepEqual(await tenantsOf(uid), [2]);
  });

  lotIt('A10', '53.4 a team name of another tenant grants nothing', async () => {
    // C-team lives in tenant C: asserting its name with tenant B only grants nothing.
    await h.ssoLogin({
      obligateUserId: 9304, username: 'rev4', role: 'user', teams: [TEAMS.C_TEAM.name],
      tenants: [{ slug: 'tenant-b', role: 'member' }],
    });
    const uid = await userIdOf(9304);
    assert.deepEqual(await teamsOf(uid), []);
  });

  lotIt('A10', '53.5 a local (non og_) account is never pruned', async () => {
    // Even with a (stale or forged) link row pointing at it, an SSO sign-in
    // never resolves to a local account: a separate og_ account is
    // provisioned and only that one is reconciled.
    const local = await createUser(h.db, { tenants: [2, 3] });
    await h.db('team_memberships').insert({ team_id: TEAMS.B_TEAM.id, user_id: local.id });
    await h.db('sso_foreign_users').insert({ foreign_source: 'obligate', foreign_user_id: 9305, local_user_id: local.id });

    const r = await h.ssoLogin({ obligateUserId: 9305, username: 'linked', role: 'user', tenants: [], teams: [] });
    assert.equal(r.callback.status, 200);
    const me = await r.client.get('/api/auth/me');
    assert.notEqual(me.json?.data?.user?.id, local.id);
    assert.equal(me.json?.data?.user?.username, 'og_linked');
    assert.deepEqual(await tenantsOf(local.id), [2, 3]);
    assert.deepEqual(await teamsOf(local.id), [TEAMS.B_TEAM.id]);

    // The local account keeps working in its tenants.
    const c = await h.login(local.username);
    await h.setSessionTenant(c, 3);
    assert.equal((await c.get('/api/bans')).status, 200);
  });

  lotIt('A10', '53.6 OBLIGATE_PRUNE_MEMBERSHIPS=false keeps memberships', async () => {
    await withPruneEnv('false', async () => {
      await h.ssoLogin({
        obligateUserId: 9306, username: 'rev6', role: 'user', teams: [TEAMS.B_TEAM.name],
        tenants: [{ slug: 'tenant-b', role: 'member' }, { slug: 'tenant-c', role: 'member' }],
      });
      const uid = await userIdOf(9306);
      const r = await h.ssoLogin({ obligateUserId: 9306, username: 'rev6', role: 'user', tenants: [], teams: [] });
      assert.equal(r.callback.status, 200);
      assert.deepEqual(await tenantsOf(uid), [2, 3]);
      assert.deepEqual(await teamsOf(uid), [TEAMS.B_TEAM.id]);
    });
    // Unset (the default) prunes again.
    const uid = await userIdOf(9306);
    await h.ssoLogin({ obligateUserId: 9306, username: 'rev6', role: 'user', tenants: [{ slug: 'tenant-b', role: 'member' }], teams: [] });
    assert.deepEqual(await tenantsOf(uid), [2]);
    assert.deepEqual(await teamsOf(uid), []);
  });

  lotIt('A10', '53.7 a revocation closes the live sockets of the user', async () => {
    const a = await h.ssoLogin({
      obligateUserId: 9307, username: 'rev7', role: 'user',
      tenants: [{ slug: 'tenant-b', role: 'member' }, { slug: 'tenant-c', role: 'member' }],
    });
    await h.setSessionTenant(a.client, 3);
    const s = await h.socket(a.client);
    assert.ok(s.ok, 'socket should connect');
    if (!s.ok) return;
    await h.ssoLogin({ obligateUserId: 9307, username: 'rev7', role: 'user', tenants: [{ slug: 'tenant-b', role: 'member' }] });
    await waitFor(() => s.events.some((e) => e.event === 'disconnect' && e.args[0] === 'io server disconnect'), 1000);
  });

  lotIt('A10', '53.8 an og_ platform admin keeps implicit access when no tenant is asserted', async () => {
    // Obligate sends tenants: [] for an "Admin on All tenants" mapping: the
    // stale user_tenants rows go, but the platform role still opens tenants.
    // Since W6-1 (Obliance parity, owner decision 16) a platform admin also
    // gets a Default-tenant 'admin' membership that pruning keeps.
    await h.ssoLogin({ obligateUserId: 9308, username: 'rev8', role: 'admin', tenants: [{ slug: 'tenant-b', role: 'admin' }] });
    const uid = await userIdOf(9308);
    assert.deepEqual(await tenantsOf(uid), [1, 2]);
    const r = await h.ssoLogin({ obligateUserId: 9308, username: 'rev8', role: 'admin', tenants: [] });
    assert.equal(r.callback.status, 200);
    assert.deepEqual(await tenantsOf(uid), [1]);
    assert.equal((await h.db('user_tenants').where({ user_id: uid, tenant_id: 1 }).first()).role, 'admin');
    const me = await r.client.get('/api/auth/me');
    assert.equal(me.json?.data?.currentTenantId, 1);
    assert.equal((await r.client.get('/api/bans')).status, 200);
    await h.setSessionTenant(r.client, 2);
    assert.equal((await r.client.get('/api/bans')).status, 200);
  });
});
