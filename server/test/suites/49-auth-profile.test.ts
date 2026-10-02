/**
 * 49 — W2-5 auth, profile and enrollment repair:
 *   - login: unknown and SSO-only accounts burn a bcrypt compare and get the
 *     same answer as a wrong password (no SSO_ONLY hint);
 *   - enrollment runs once (409 after), never rewrites an address on file,
 *     merges the preferences;
 *   - PUT /profile: an e-mail change needs the current password (local
 *     accounts), preferences are merged (NetMap tabs keep the toast prefs),
 *     netmapTabs is bounded;
 *   - password change: per-account throttle on wrong current passwords
 *     (5 / 15 min then 429), other sessions revoked, this one regenerated;
 *   - admin: PUT /users/:id/password refuses self and revokes the target's
 *     sessions; DELETE /users/:id/2fa clears the factors and the sessions.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { startHarness, totp } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { PASSWORD, U } from '../fixtures';
import { createUser, createTotpUser } from '../seed';

describe('49 auth, profile and enrollment (W2-5)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const userRow = (id: number) => h.db('users').where({ id }).first();
  const prefsOf = async (id: number): Promise<Record<string, unknown>> => {
    const p = (await userRow(id)).preferences;
    return (typeof p === 'string' ? JSON.parse(p) : p) ?? {};
  };

  lotIt('W2-5', '49.1 unknown and SSO-only logins burn a bcrypt compare and answer like a wrong password', async (t) => {
    const u = await createUser(h.db, { tenants: [2] });
    const wrong = await h.anon().post('/api/auth/login', { username: u.username, password: 'not-the-password' });
    assert.equal(wrong.status, 401);

    const spy = t.mock.method(bcrypt, 'compare');
    const unknown = await h.anon().post('/api/auth/login', { username: `nobody-${Date.now()}`, password: 'not-the-password' });
    assert.ok(spy.mock.callCount() >= 1, 'an unknown user must still cost a bcrypt compare');
    assert.equal(unknown.status, wrong.status);
    assert.deepEqual(unknown.json, wrong.json);

    const before = spy.mock.callCount();
    const sso = await h.anon().post('/api/auth/login', { username: 'og_sso', password: PASSWORD });
    assert.ok(spy.mock.callCount() > before, 'an SSO-only account must still cost a bcrypt compare');
    assert.equal(sso.status, wrong.status);
    assert.deepEqual(sso.json, wrong.json);
    assert.equal(sso.json?.code, undefined);
  });

  lotIt('W2-5', '49.2 enrollment runs once, keeps an address on file and merges preferences', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const tabs = [{ id: 't1', name: 'Edge', agentIds: [1, 2], sortOrder: 0 }];
    await h.db('users').where({ id: u.id }).update({
      enrollment_version: 0, email: null, preferences: JSON.stringify({ netmapTabs: tabs }),
    });
    const c = await h.login(u.username);
    const body = { email: `${u.username}-new@verify.test`, toastEnabled: false, toastPosition: 'top-center', preferredTheme: 'neon' };

    const first = await c.post('/api/auth/enrollment', body);
    assert.equal(first.status, 200, first.text);
    const row = await userRow(u.id);
    assert.equal(row.enrollment_version, 2);
    assert.equal(row.email, body.email);
    const prefs = await prefsOf(u.id);
    assert.deepEqual(prefs.netmapTabs, tabs);
    assert.equal(prefs.toastEnabled, false);
    assert.equal(prefs.preferredTheme, 'neon');

    const second = await c.post('/api/auth/enrollment', { ...body, email: 'attacker@evil.test' });
    assert.equal(second.status, 409);
    assert.equal((await userRow(u.id)).email, body.email);

    // A pending enrollment (older wizard version) never rewrites an address on file.
    const v = await createUser(h.db, { tenants: [2], email: `${u.username}-kept@verify.test` });
    await h.db('users').where({ id: v.id }).update({ enrollment_version: 1 });
    const cv = await h.login(v.username);
    const r = await cv.post('/api/auth/enrollment', { ...body, email: 'attacker@evil.test' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await userRow(v.id)).email, `${u.username}-kept@verify.test`);

    // An empty address is "none", not an invalid one: kept on file when there
    // is one, refused (required) when the local account has none.
    const w = await createUser(h.db, { tenants: [2], email: `${u.username}-w@verify.test` });
    await h.db('users').where({ id: w.id }).update({ enrollment_version: 1 });
    const cw = await h.login(w.username);
    const empty = await cw.post('/api/auth/enrollment', { ...body, email: '' });
    assert.equal(empty.status, 200, empty.text);
    assert.equal((await userRow(w.id)).email, `${u.username}-w@verify.test`);
    const x = await createUser(h.db, { tenants: [2] });
    await h.db('users').where({ id: x.id }).update({ enrollment_version: 1, email: null });
    const cx = await h.login(x.username);
    assert.equal((await cx.post('/api/auth/enrollment', { ...body, email: '' })).status, 400);
  });

  lotIt('W2-5', '49.3 an e-mail change needs the current password; e-mail OTP is kept', async () => {
    const u = await createUser(h.db, { tenants: [2], email: 'before-49@verify.test' });
    const c = await h.login(u.username);
    await h.db('users').where({ id: u.id }).update({ email_otp_enabled: true });

    const none = await c.put('/api/profile', { email: 'after-49@verify.test' });
    assert.equal(none.status, 400);
    assert.equal((await userRow(u.id)).email, 'before-49@verify.test');

    const bad = await c.put('/api/profile', { email: 'after-49@verify.test', currentPassword: 'wrong-password' });
    assert.equal(bad.status, 400);
    assert.equal((await userRow(u.id)).email, 'before-49@verify.test');

    // Re-sending the stored address is not a change.
    assert.equal((await c.put('/api/profile', { email: 'before-49@verify.test', displayName: 'x' })).status, 200);

    const ok = await c.put('/api/profile', { email: 'after-49@verify.test', currentPassword: PASSWORD });
    assert.equal(ok.status, 200, ok.text);
    const row = await userRow(u.id);
    assert.equal(row.email, 'after-49@verify.test');
    assert.equal(row.email_otp_enabled, true);
  });

  lotIt('W2-5', '49.4 PUT /profile merges netmapTabs into the stored preferences (bounded)', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    await h.db('users').where({ id: u.id }).update({
      preferences: JSON.stringify({ toastEnabled: false, toastPosition: 'top-center', preferredTheme: 'obli-dim' }),
    });
    const c = await h.login(u.username);
    const tabs = [{ id: 'a1', name: 'DMZ', agentIds: [3], sortOrder: 0 }];

    const r = await c.put('/api/profile', { preferences: { netmapTabs: tabs } });
    assert.equal(r.status, 200, r.text);
    let prefs = await prefsOf(u.id);
    assert.deepEqual(prefs.netmapTabs, tabs);
    assert.equal(prefs.toastEnabled, false);
    assert.equal(prefs.toastPosition, 'top-center');
    assert.equal(prefs.preferredTheme, 'obli-dim');

    // The NetMap tab store uses PATCH: same merge.
    const p = await c.patch('/api/profile', { preferences: { toastEnabled: true } });
    assert.equal(p.status, 200, p.text);
    prefs = await prefsOf(u.id);
    assert.equal(prefs.toastEnabled, true);
    assert.deepEqual(prefs.netmapTabs, tabs);

    const tooMany = Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, agentIds: [], sortOrder: i }));
    assert.equal((await c.put('/api/profile', { preferences: { netmapTabs: tooMany } })).status, 400);
    const badTab = await c.put('/api/profile', { preferences: { netmapTabs: [{ id: 'x', name: 'X', agentIds: ['1; drop'], sortOrder: 0 }] } });
    assert.equal(badTab.status, 400);
    assert.deepEqual((await prefsOf(u.id)).netmapTabs, tabs);
  });

  lotIt('W2-5', '49.5 PUT /users/:id/password refuses self and signs the target out', async () => {
    const admin = await h.login('admin');
    const self = await admin.put(`/api/users/${U.admin}/password`, { password: 'Another-Pass-9!' });
    assert.equal(self.status, 400);

    const u = await createUser(h.db, { tenants: [2] });
    const target = await h.login(u.username);
    assert.equal((await target.get('/api/auth/me')).status, 200);
    const r = await admin.put(`/api/users/${u.id}/password`, { password: 'Reset-Pass-9!' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await target.get('/api/auth/me')).status, 401);
    await h.login(u.username, 'Reset-Pass-9!');
  });

  lotIt('W2-5', '49.6 DELETE /users/:id/2fa clears the factors and kills the target sessions', async () => {
    const u = await createTotpUser(h.db, { tenants: [2] });
    await h.db('users').where({ id: u.id }).update({ email_otp_enabled: true });
    const { client } = await h.loginStep1(u.username);
    assert.equal((await client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(u.secret) })).status, 200);
    assert.equal((await client.get('/api/auth/me')).status, 200);

    const admin = await h.login('admin');
    assert.equal((await admin.del(`/api/users/${U.admin}/2fa`)).status, 400);
    assert.equal((await admin.del('/api/users/987654/2fa')).status, 404);

    const r = await admin.del(`/api/users/${u.id}/2fa`);
    assert.equal(r.status, 200, r.text);
    const row = await userRow(u.id);
    assert.equal(row.totp_enabled, false);
    assert.equal(row.totp_secret, null);
    assert.equal(row.email_otp_enabled, false);
    assert.equal((await client.get('/api/auth/me')).status, 401);

    // Signs in again with the password alone.
    const again = await h.loginStep1(u.username);
    assert.equal(again.res.status, 200);
    assert.notEqual(again.res.json?.data?.requires2fa, true);
  });

  lotIt('W2-5', '49.7 the 6th wrong current password answers 429 (per account)', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const c = await h.login(u.username);
    for (let i = 1; i <= 5; i++) {
      const r = await c.put('/api/profile/password', { currentPassword: `wrong-${i}`, newPassword: 'Brand-New-Pass-1' });
      assert.equal(r.status, 400, `attempt ${i}`);
    }
    const sixth = await c.put('/api/profile/password', { currentPassword: 'wrong-6', newPassword: 'Brand-New-Pass-1' });
    assert.equal(sixth.status, 429);
    // The e-mail change shares the budget.
    const email = await c.put('/api/profile', { email: `${u.username}-x@verify.test`, currentPassword: PASSWORD });
    assert.equal(email.status, 429);
    // Writes without a current password are not throttled.
    assert.equal((await c.put('/api/profile', { displayName: 'still ok' })).status, 200);
    // Another account has its own budget.
    const other = await createUser(h.db, { tenants: [2] });
    const co = await h.login(other.username);
    assert.equal((await co.put('/api/profile/password', { currentPassword: 'wrong', newPassword: 'Brand-New-Pass-1' })).status, 400);
  });

  lotIt('W2-5', '49.8 a password change revokes the other sessions and regenerates this one', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const c1 = await h.login(u.username);
    const c2 = await h.login(u.username);
    const sidBefore = c1.sid();
    const r = await c1.put('/api/profile/password', { currentPassword: PASSWORD, newPassword: 'Changed-Pass-77' });
    assert.equal(r.status, 200, r.text);
    assert.ok(c1.sid());
    assert.notEqual(c1.sid(), sidBefore);
    const me = await c1.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json?.data?.user?.id, u.id);
    assert.equal((await c2.get('/api/auth/me')).status, 401);
    const old = await h.db('session').where({ sid: sidBefore }).first();
    assert.equal(old, undefined);
  });
});
