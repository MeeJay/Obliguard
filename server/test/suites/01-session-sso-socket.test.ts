/**
 * 01 — sessions, Obligate SSO, Socket.io authentication, 2FA.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startHarness, waitFor, sleep, totp, wrongTotp, Client } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { OBLIGATE_API_KEY, TOTP_SECRET, U, OG, VERIFY_HOST } from '../fixtures';
import { createUser, createTotpUser } from '../seed';

const CALLBACK = 'http://verify.local/auth/callback';

describe('01 session / SSO / socket / 2FA', () => {
  let h: Harness;
  before(async () => { h = await startHarness({ obligate: true }); });
  after(async () => { await h.close(); });

  const userRow = (id: number) => h.db('users').where({ id }).first();

  it('01.1 password login rotates the session id [BASELINE]', async () => {
    const j = await h.login('member_b');
    const sid1 = j.sid();
    const raw1 = j.jar.get('connect.sid')!;
    assert.ok(sid1);
    const r = await j.post('/api/auth/login', { username: 'member_c', password: 'Verify-Pass-1!' });
    assert.equal(r.status, 200);
    const sid2 = j.sid();
    assert.ok(sid2);
    assert.notEqual(sid2, sid1);
    const old = h.anon();
    old.jar.set('connect.sid', raw1);
    assert.equal((await old.get('/api/auth/me')).status, 401);
  });

  it('01.2 2FA: a pending session is not a login; verify rotates the session [BASELINE]', async () => {
    const { client, res } = await h.loginStep1('totp_user');
    assert.equal(res.status, 200);
    assert.equal(res.json?.data?.requires2fa, true);
    const sidA = client.sid();
    assert.ok(sidA);
    assert.equal((await client.get('/api/auth/me')).status, 401);
    const s = await h.socket(client);
    assert.equal(s.ok, false);
    const v = await client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(TOTP_SECRET) });
    assert.equal(v.status, 200);
    assert.notEqual(client.sid(), sidA);
    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json?.data?.user?.username, 'totp_user');
  });

  it('01.3 disabling a user revokes its session and socket [BASELINE]', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const c = await h.login(u.username);
    const s = await h.socket(c);
    assert.ok(s.ok, 'socket should connect');
    const admin = await h.as('admin');
    const r = await admin.put(`/api/users/${u.id}`, { isActive: false });
    assert.equal(r.status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 401);
    if (s.ok) await waitFor(() => s.events.some((e) => e.event === 'disconnect'), 2000);
    assert.equal((await userRow(u.id)).is_active, false);
  });

  it('01.4 demoting a platform admin revokes its admin session [BASELINE]', async () => {
    const u = await createUser(h.db, { role: 'admin' });
    const c = await h.login(u.username);
    const admin = await h.as('admin');
    const r = await admin.put(`/api/users/${u.id}`, { role: 'user' });
    assert.equal(r.status, 200);
    assert.equal((await userRow(u.id)).role, 'user');
    const after = await c.get('/api/users');
    assert.ok([401, 403].includes(after.status), `got ${after.status}`);
  });

  it('01.5 sessionUserGuard re-reads the account after its cache TTL [BASELINE]', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const c = await h.login(u.username);
    assert.equal((await c.get('/api/auth/me')).status, 200); // warms the 5 s cache
    await h.db('users').where({ id: u.id }).update({ is_active: false });
    await sleep(5500);
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });

  it('01.6 Obligate accounts cannot use local password flows [BASELINE]', async () => {
    const r = await h.anon().post('/api/auth/login', { username: 'og_sso', password: 'Verify-Pass-1!' });
    assert.equal(r.status, 401);
    assert.equal(r.json?.code, 'SSO_ONLY');
    const f = await h.anon().post('/api/auth/forgot-password', { email: 'og_sso@verify.test' });
    assert.equal(f.status, 200);
    const tokens = await h.db('password_reset_tokens').where({ user_id: OG.userId });
    assert.equal(tokens.length, 0);
  });

  it('01.7 sso-redirect uses the public client id and the configured callback [BASELINE]', async () => {
    const r = await h.anon().get('/auth/sso-redirect', { host: VERIFY_HOST });
    assert.equal(r.status, 302);
    assert.ok(r.location?.startsWith(`${h.obligate!.url}/authorize?`), r.location);
    const u = new URL(r.location!);
    assert.equal(u.searchParams.get('client_id'), crypto.createHash('sha256').update(OBLIGATE_API_KEY).digest('hex'));
    assert.equal(u.searchParams.get('redirect_uri'), CALLBACK);
    assert.ok(!r.location!.includes(OBLIGATE_API_KEY));
  });

  it('01.8 forged Host / X-Forwarded-Host never reach the redirect_uri [BASELINE]', async () => {
    const a = await h.anon().get('/auth/sso-redirect', { host: VERIFY_HOST, headers: { 'x-forwarded-host': 'evil.example' } });
    assert.equal(a.status, 302);
    assert.equal(new URL(a.location!).searchParams.get('redirect_uri'), CALLBACK);

    const b = await h.anon().get('/auth/sso-redirect', { host: 'evil.example' });
    assert.equal(b.status, 302);
    assert.ok(b.location?.startsWith('http://verify.local/auth/sso-redirect'), b.location);
    assert.ok(!b.location!.includes('evil.example'));

    const n0 = h.obligate!.requests.length;
    const x1 = await h.ssoLogin({ obligateUserId: 9110, username: 'hx' }, { callbackHeaders: { 'x-forwarded-host': 'evil.example' } });
    const x2 = await h.ssoLogin({ obligateUserId: 9111, username: 'hy' }, { callbackHost: 'evil.example' });
    assert.ok(x1.exchange && x2.exchange, 'both callbacks must exchange their code');
    const later = h.obligate!.requests.slice(n0);
    for (const req of later.filter((q) => q.path === '/api/oauth/token/exchange')) {
      assert.equal(req.body?.redirect_uri, CALLBACK);
    }
    for (const req of later) assert.ok(!JSON.stringify(req.body ?? '').includes('evil.example'));
  });

  let alice: { client: Client; callbackPath: string } | null = null;

  it('01.9 SSO login provisions an og_ account and ignores linkedLocalUserId [BASELINE]', async () => {
    const pre = h.anon();
    const r = await h.ssoLogin(
      { obligateUserId: 9101, username: 'alice', role: 'user', tenants: [{ slug: 'tenant-b', role: 'member' }], linkedLocalUserId: 1 },
      { client: pre },
    );
    assert.equal(r.callback.status, 200);
    assert.match(String(r.callback.headers['content-type']), /text\/html/);
    alice = { client: r.client, callbackPath: r.callbackPath };
    const me = await r.client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.data.user.username, 'og_alice');
    assert.notEqual(me.json.data.user.id, 1);
    assert.equal(me.json.data.user.role, 'user');
    const link = await h.db('sso_foreign_users').where({ foreign_source: 'obligate', foreign_user_id: 9101 }).first();
    assert.equal(link?.local_user_id, me.json.data.user.id);
    const admin = await userRow(1);
    assert.equal(admin.username, 'admin');
    assert.equal(admin.role, 'admin');
    assert.equal(admin.is_active, true);
  });

  it('01.9b the callback issues a session id different from the sso-redirect one [BASELINE]', async () => {
    const c = h.anon();
    await c.get('/auth/sso-redirect', { host: VERIFY_HOST });
    const sidRedirect = c.sid();
    const r = await h.ssoLogin({ obligateUserId: 9112, username: 'rot' }, { client: c });
    assert.equal(r.callback.status, 200);
    assert.ok(c.sid());
    assert.notEqual(c.sid(), sidRedirect);
  });

  it('01.10 a replayed callback fails; /api/auth/callback is not served [BASELINE]', async () => {
    assert.ok(alice, '01.9 must have run');
    const r = await h.anon().get(alice!.callbackPath, { host: VERIFY_HOST });
    assert.equal(r.status, 302);
    assert.equal(r.location, '/login?error=sso_failed');
    const api = await h.anon().get('/api/auth/callback?code=x&state=y');
    assert.equal(api.status, 404);
  });

  it('01.11 sso-user-sync only revokes linked SSO accounts [BASELINE]', async () => {
    assert.ok(alice, '01.9 must have run');
    const wrong = await h.anon().post('/api/auth/sso-user-sync', { obligateUserId: 9101, action: 'delete' }, { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
    const bearer = { authorization: `Bearer ${OBLIGATE_API_KEY}` };
    const a = await h.anon().post('/api/auth/sso-user-sync', { obligateUserId: 777777, remoteUserId: 1, action: 'deactivate' }, { headers: bearer });
    assert.equal(a.status, 200);
    assert.equal((await userRow(1)).is_active, true);
    const aliceId = (await h.db('users').where({ username: 'og_alice' }).first()).id as number;
    const d = await h.anon().post('/api/auth/sso-user-sync', { obligateUserId: 9101, action: 'delete' }, { headers: bearer });
    assert.equal(d.status, 200);
    assert.equal((await userRow(aliceId)).is_active, false);
    assert.equal((await alice!.client.get('/api/auth/me')).status, 401);
    const again = await h.ssoLogin({ obligateUserId: 9101, username: 'alice', tenants: [{ slug: 'tenant-b', role: 'member' }] });
    assert.equal(again.callback.status, 200);
    assert.equal((await userRow(aliceId)).is_active, true);
  });

  it('01.12 update-role demotes at once and revokes the admin session [BASELINE]', async () => {
    const bob = await h.ssoLogin({ obligateUserId: 9102, username: 'bob', role: 'admin' });
    assert.equal((await bob.client.get('/api/users')).status, 200);
    const s = await h.anon().post('/api/auth/sso-user-sync', { obligateUserId: 9102, action: 'update-role', role: 'user' }, { headers: { authorization: `Bearer ${OBLIGATE_API_KEY}` } });
    assert.equal(s.status, 200);
    const after = await bob.client.get('/api/users');
    assert.ok([401, 403].includes(after.status), `got ${after.status}`);
    const row = await h.db('users').where({ username: 'og_bob' }).first();
    assert.equal(row.role, 'user');
  });

  it('01.13 Obligate bearer endpoints [BASELINE]', async () => {
    for (const path of ['/api/auth/app-info', '/api/auth/dashboard-stats']) {
      assert.equal((await h.anon().get(path)).status, 401, `${path} without bearer`);
      assert.equal((await h.anon().get(path, { headers: { authorization: 'Bearer wrong' } })).status, 401, `${path} wrong bearer`);
      assert.equal((await h.anon().get(path, { headers: { authorization: `Bearer ${OBLIGATE_API_KEY}` } })).status, 200, `${path} right bearer`);
    }
  });

  it('01.14 enrollment never rewrites the email of an Obligate account [BASELINE]', async () => {
    const r = await h.ssoLogin({ obligateUserId: OG.obligateUserId, username: 'sso', email: 'og_sso@verify.test' });
    assert.equal(r.callback.status, 200);
    const me = await r.client.get('/api/auth/me');
    assert.equal(me.json?.data?.user?.id, OG.userId);
    const e = await r.client.post('/api/auth/enrollment', { email: 'attacker@evil.test' });
    assert.equal(e.status, 200);
    assert.equal((await userRow(OG.userId)).email, 'og_sso@verify.test');
  });

  lotIt('A1', '01.15 SSO tenant capabilities never overwrite shared team permissions', async () => {
    const r = await h.ssoLogin({
      obligateUserId: 9103, username: 'carol', teams: ['B-team'],
      tenants: [{ slug: 'tenant-b', role: 'member', capabilities: ['bans'] }],
    });
    assert.equal(r.callback.status, 200);
    const perm = await h.db('team_permissions').where({ team_id: 2 }).first();
    const caps = typeof perm.capabilities === 'string' ? JSON.parse(perm.capabilities) : perm.capabilities;
    assert.deepEqual(caps, ['whitelist']);
  });

  lotIt('A1', '01.16 an SSO user with no usable tenant gets noTenantAccess', async () => {
    const r = await h.ssoLogin({ obligateUserId: 9104, username: 'dave', role: 'user', tenants: [{ slug: 'no-such-tenant', role: 'member' }] });
    const me = await r.client.get('/api/auth/me');
    assert.equal(me.json?.data?.noTenantAccess, true);
    assert.equal(me.json?.data?.currentTenantId ?? null, null);
    const bans = await r.client.get('/api/bans');
    assert.equal(bans.status, 403);
    assert.equal(bans.json?.code, 'noTenantAccess');
  });

  lotIt('UNTRACKED', '01.17 enrollment does not rewrite a local account email without re-verification', async () => {
    const u = await createUser(h.db, { tenants: [2], email: 'a@verify.test' });
    const c = await h.login(u.username);
    await c.post('/api/auth/enrollment', { email: 'attacker@evil.test' });
    assert.equal((await userRow(u.id)).email, 'a@verify.test');
  });

  it('01.18 sockets without a session are refused, handshake auth is ignored [BASELINE]', async () => {
    const a = await h.socket(null);
    assert.equal(a.ok, false);
    const b = await h.socket(null, { auth: { userId: 1, tenantId: 1 } });
    assert.equal(b.ok, false);
  });

  it('01.19 cross-origin socket handshakes are refused [BASELINE]', async () => {
    const c = await h.as('member_b');
    const evil = await h.socket(c, { origin: 'http://evil.example' });
    assert.equal(evil.ok, false);
    const same = await h.socket(c, { origin: 'http://verify.local' });
    assert.equal(same.ok, true);
    const none = await h.socket(c, { origin: null });
    assert.equal(none.ok, true);
  });

  it('01.20 socket rooms follow the session tenant and role [BASELINE]', async () => {
    const mb = await h.as('member_b');
    assert.ok((await h.socket(mb)).ok);
    const rb = await h.roomsOf(U.member_b);
    for (const r of ['tenant:2', `user:${U.member_b}`, 'general']) assert.ok(rb.includes(r), `member_b missing ${r}`);
    for (const r of ['tenant:1', 'role:admin']) assert.ok(!rb.includes(r), `member_b must not be in ${r}`);

    const ad = await h.as('admin');
    assert.ok((await h.socket(ad)).ok);
    const ra = await h.roomsOf(U.admin);
    for (const r of ['role:admin', 'tenant:1']) assert.ok(ra.includes(r), `admin missing ${r}`);

    const nt = await h.as('no_tenant');
    const s = await h.socket(nt);
    if (s.ok) {
      const rn = await h.roomsOf(U.no_tenant);
      assert.ok(!rn.some((r) => /^tenant:\d+$/.test(r)), `no_tenant rooms: ${rn.join(',')}`);
    } else {
      assert.match(s.error, /tenant/i);
    }
  });

  lotIt('A8', '01.21 a TOTP code cannot be replayed', async () => {
    const u = await createTotpUser(h.db);
    const a = await h.loginStep1(u.username);
    const code = totp(u.secret);
    assert.equal((await a.client.post('/api/profile/2fa/verify', { method: 'totp', code })).status, 200);
    const b = await h.loginStep1(u.username);
    assert.equal((await b.client.post('/api/profile/2fa/verify', { method: 'totp', code })).status, 401);
    assert.equal((await b.client.get('/api/auth/me')).status, 401);
  });

  lotIt('A8', '01.22 TOTP verification attempts are capped', async () => {
    const u = await createTotpUser(h.db);
    const { client } = await h.loginStep1(u.username);
    for (let i = 0; i < 10; i++) {
      const r = await client.post('/api/profile/2fa/verify', { method: 'totp', code: wrongTotp(u.secret) });
      assert.ok([401, 429].includes(r.status), `attempt ${i}: ${r.status}`);
    }
    const ok = await client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(u.secret) });
    assert.ok([401, 429].includes(ok.status), `capped verify answered ${ok.status}`);
    assert.equal((await client.get('/api/auth/me')).status, 401);
  });

  lotIt('A8', '01.23 disabling TOTP requires a factor proof', async () => {
    const u = await createTotpUser(h.db);
    const { client } = await h.loginStep1(u.username);
    assert.equal((await client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(u.secret) })).status, 200);
    const r = await client.del('/api/profile/2fa/totp', {});
    assert.ok(r.status >= 400 && r.status < 500, `got ${r.status}`);
    assert.equal((await userRow(u.id)).totp_enabled, true);
  });

  lotIt('A8', '01.24 force_2fa is enforced server-side', async () => {
    await h.db('app_config').insert({ key: 'force_2fa', value: 'true' }).onConflict('key').merge({ value: 'true' });
    try {
      const u = await createUser(h.db, { tenants: [2] });
      const c = await h.login(u.username);
      const bans = await c.get('/api/bans');
      assert.equal(bans.status, 403);
      assert.equal(bans.json?.code, 'twoFactorSetupRequired');
      assert.equal((await c.get('/api/profile/2fa/status')).status, 200);
      const me = await c.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.json?.data?.requires2faSetup, true);
    } finally {
      await h.db('app_config').where({ key: 'force_2fa' }).update({ value: 'false' });
    }
  });
});
