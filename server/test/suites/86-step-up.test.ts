/**
 * 86 — W11-2 step-up confirmation for sensitive actions (owner decision 14):
 *   - a fixed list of actions (STEP_UP_ACTIONS, incl. tenant.delete) needs a
 *     fresh proof in the session: 401 { code: 'TWO_FACTOR_REQUIRED', action,
 *     methods } until POST /profile/2fa/step-up succeeds, then the same
 *     request goes through; the 401 does not end the session;
 *   - the proof is valid 10 minutes (fake clock: stepUpClock);
 *   - an account without any second factor confirms with its password, a
 *     TOTP account with a NEW code (the sign-in code is refused, anti-replay),
 *     an e-mail-code account with a code mailed for it;
 *   - only the sensitive branch is gated (a tenant-local Lift is not), and
 *     the capability check runs first (403, not a prompt);
 *   - Obligate (og_) accounts are exempt and the exemption is audited;
 *   - wrong proofs are throttled per account (5 / 15 min).
 *
 * Harness helpers (other suites' sessions): stepUp(client) confirms a
 * password session once; withAutoStepUp(client) makes a client behave like
 * the browser (api/client.ts): on 401 TWO_FACTOR_REQUIRED it confirms with
 * the password and replays the request once. The W11 integration moves the
 * latter into harness.ts login() so suites that call gated routes keep their
 * checks unchanged (86.10 exercises it).
 */
import { describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { startHarness, totp } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import { PASSWORD, OG } from '../fixtures';
import { createUser, createTotpUser, insertBan, banRow, nextIp, createKey, createDevice } from '../seed';
import { STEP_UP_ACTIONS, STEP_UP_TTL_MS, stepUpClock } from '../../src/services/stepUp.service';

interface SentMail { to: string; subject: string; text: string }

/** Confirms a password account's session (step-up valid 10 minutes). */
async function stepUp(c: Client, password = PASSWORD): Promise<void> {
  const r = await c.post('/api/profile/2fa/step-up', { method: 'password', password });
  assert.equal(r.status, 200, `step-up failed: ${r.status} ${r.text.slice(0, 200)}`);
}

/**
 * The browser behaviour for a harness client: a 401 TWO_FACTOR_REQUIRED is
 * confirmed with the password (accounts without a second factor) and the
 * request replayed once; any other answer is returned as is.
 */
function withAutoStepUp(c: Client, password = PASSWORD): Client {
  const raw = c.request.bind(c);
  c.request = async (method, path, opts = {}) => {
    const res = await raw(method, path, opts);
    if (res.status !== 401 || res.json?.code !== 'TWO_FACTOR_REQUIRED') return res;
    const confirmed = await raw('POST', '/api/profile/2fa/step-up', { body: { method: 'password', password } });
    return confirmed.status === 200 ? raw(method, path, opts) : res;
  };
  return c;
}

describe('86 step-up for sensitive actions (W11-2)', () => {
  let h: Harness;
  const sent: SentMail[] = [];

  before(async () => {
    h = await startHarness({ obligate: true });
    mock.method(nodemailer as unknown as { createTransport: (...a: unknown[]) => unknown }, 'createTransport', () => ({
      sendMail: async (m: { to: string; subject: string; text: string }) => {
        sent.push({ to: String(m.to), subject: String(m.subject), text: String(m.text) });
        return { messageId: `verify-${sent.length}` };
      },
    }));
    const [smtp] = await h.db('smtp_servers').insert({
      name: 'verify-otp', host: 'smtp.verify.invalid', port: 587, secure: false,
      username: 'otp', password: 'otp', from_address: 'otp@verify.test',
    }).returning('id') as Array<{ id: number }>;
    await h.db('app_config').insert({ key: 'otp_smtp_server_id', value: String(smtp.id) })
      .onConflict('key').merge({ value: String(smtp.id) });
  });
  after(async () => {
    mock.restoreAll();
    await h.close();
  });

  const lastCodeTo = (to: string): string => {
    const m = [...sent].reverse().find((x) => x.to === to);
    const code = m?.text.match(/\b(\d{6})\b/)?.[1];
    assert.ok(code, `no code mailed to ${to}`);
    return code;
  };

  /**
   * A fresh password session WITHOUT any step-up. Not h.login(): the harness
   * client may confirm step-ups by itself (like the browser client does).
   */
  const plainLogin = async (username: string): Promise<Client> => {
    const { client, res } = await h.loginStep1(username);
    assert.equal(res.status, 200, `login ${username}: ${res.status} ${res.text.slice(0, 200)}`);
    assert.notEqual(res.json?.data?.requires2fa, true);
    return client;
  };

  /** A fresh platform-admin session operating the Default tenant (no step-up yet). */
  const freshAdmin = async (): Promise<Client> => {
    const c = await plainLogin('admin');
    assert.equal((await c.switchTenant(1)).status, 200);
    return c;
  };

  const assertStepUpRequired = (r: { status: number; json: any; text: string }, action: string): void => {
    assert.equal(r.status, 401, `expected 401, got ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(r.json?.code, 'TWO_FACTOR_REQUIRED');
    assert.equal(r.json?.twoFactorRequired, true);
    assert.equal(r.json?.action, action);
    assert.ok(Array.isArray(r.json?.methods) && r.json.methods.length > 0, 'methods listed');
  };

  lotIt('W11-2', '86.1 the action list is a constant covering the owner decision (incl. tenant.delete)', () => {
    for (const a of [
      'bans.wipe', 'ipReputation.wipe', 'bans.liftGlobal', 'bans.promote', 'whitelist.global', 'tenant.delete',
      'agents.uninstall', 'agents.delete', 'firewall.write', 'appConfig.secrets', 'users.role', 'keys.manage',
    ]) {
      assert.ok((STEP_UP_ACTIONS as readonly string[]).includes(a), `missing ${a}`);
    }
    assert.equal(STEP_UP_TTL_MS, 10 * 60 * 1000);
  });

  lotIt('W11-2', '86.2 wipe without step-up: 401 TWO_FACTOR_REQUIRED, nothing wiped, session kept', async () => {
    const c = await freshAdmin();
    const banId = await insertBan(h.db, { ip: nextIp(), scope: 'global' });
    const r = await c.post('/api/bans/wipe-bans', {});
    assertStepUpRequired(r, 'bans.wipe');
    assert.deepEqual(r.json.methods, ['password'], 'an account without a factor confirms with its password');
    assert.equal((await banRow(h.db, banId))?.is_active, true, 'nothing may be wiped');
    // The 401 is not a lost session.
    assert.equal((await c.get('/api/auth/me')).status, 200);
    const st = await c.get('/api/profile/2fa/step-up');
    assert.equal(st.status, 200);
    assert.equal(st.json?.data?.fresh, false);
    assert.deepEqual(st.json?.data?.methods, ['password']);
  });

  lotIt('W11-2', '86.3 after a password step-up the same request is allowed; a wrong password is refused (400)', async () => {
    const c = await freshAdmin();
    const banId = await insertBan(h.db, { ip: nextIp(), scope: 'global' });
    assertStepUpRequired(await c.post('/api/bans/wipe-bans', {}), 'bans.wipe');

    const bad = await c.post('/api/profile/2fa/step-up', { method: 'password', password: 'not-the-password' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json?.code, 'STEP_UP_INVALID');
    assertStepUpRequired(await c.post('/api/bans/wipe-bans', {}), 'bans.wipe');

    // A method the account does not have is refused.
    const wrongMethod = await c.post('/api/profile/2fa/step-up', { method: 'totp', code: '123456' });
    assert.equal(wrongMethod.status, 400);
    assert.equal(wrongMethod.json?.code, 'STEP_UP_METHOD_UNAVAILABLE');

    await stepUp(c);
    const st = await c.get('/api/profile/2fa/step-up');
    assert.equal(st.json?.data?.fresh, true);
    assert.equal(st.json?.data?.method, 'password');

    const ok = await c.post('/api/bans/wipe-bans', {});
    assert.equal(ok.status, 200, ok.text.slice(0, 200));
    assert.equal((await banRow(h.db, banId))?.is_active, false);

    // The trust is per session: another session of the same account is asked again.
    const other = await freshAdmin();
    assertStepUpRequired(await other.post('/api/bans/wipe-reputation', {}), 'ipReputation.wipe');
  });

  lotIt('W11-2', '86.4 the step-up expires after 10 minutes (fake clock)', async () => {
    const c = await freshAdmin();
    await stepUp(c);
    const real = stepUpClock.now;
    try {
      const t0 = Date.now();
      stepUpClock.now = () => t0 + 9 * 60 * 1000;
      assert.equal((await c.get('/api/profile/2fa/step-up')).json?.data?.fresh, true, 'still fresh at 9 min');
      assert.equal((await c.post('/api/bans/wipe-reputation', {})).status, 200);

      stepUpClock.now = () => t0 + STEP_UP_TTL_MS + 1000;
      assert.equal((await c.get('/api/profile/2fa/step-up')).json?.data?.fresh, false);
      assertStepUpRequired(await c.post('/api/bans/wipe-reputation', {}), 'ipReputation.wipe');
      // A new proof renews it.
      await stepUp(c);
      assert.equal((await c.post('/api/bans/wipe-reputation', {})).status, 200);
    } finally {
      stepUpClock.now = real;
    }
  });

  lotIt('W11-2', '86.5 TOTP account: a NEW code is required (the sign-in code is refused), no password fallback', async () => {
    const u = await createTotpUser(h.db, { tenants: [2] });
    await h.db('user_tenants').where({ user_id: u.id, tenant_id: 2 }).update({ role: 'admin' });
    const { client: c } = await h.loginStep1(u.username);
    const signInCode = totp(u.secret);
    assert.equal((await c.post('/api/profile/2fa/verify', { method: 'totp', code: signInCode })).status, 200);

    const r = await c.post('/api/agent/keys', { name: 'step-up-key' });
    assertStepUpRequired(r, 'keys.manage');
    assert.deepEqual(r.json.methods, ['totp']);

    const replay = await c.post('/api/profile/2fa/step-up', { method: 'totp', code: signInCode });
    assert.equal(replay.status, 400);
    assert.equal(replay.json?.code, 'STEP_UP_CODE_USED');
    const pwd = await c.post('/api/profile/2fa/step-up', { method: 'password', password: PASSWORD });
    assert.equal(pwd.status, 400);
    assert.equal(pwd.json?.code, 'STEP_UP_METHOD_UNAVAILABLE');

    const ok = await c.post('/api/profile/2fa/step-up', { method: 'totp', code: totp(u.secret, 1) });
    assert.equal(ok.status, 200, ok.text.slice(0, 200));
    const created = await c.post('/api/agent/keys', { name: 'step-up-key' });
    assert.ok(created.status === 200 || created.status === 201, `${created.status} ${created.text.slice(0, 200)}`);
  });

  lotIt('W11-2', '86.6 e-mail-code account: a code is mailed for the step-up (30 s cooldown) and checked', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    await h.db('users').where({ id: u.id }).update({ email_otp_enabled: true });
    const email = `${u.username}@verify.test`;
    const { client: c, res } = await h.loginStep1(u.username);
    assert.equal(res.json?.data?.requires2fa, true);
    assert.equal((await c.post('/api/profile/2fa/verify', { method: 'email', code: lastCodeTo(email) })).status, 200);

    const st = await c.get('/api/profile/2fa/step-up');
    assert.deepEqual(st.json?.data?.methods, ['email']);
    const before = sent.length;
    const send = await c.post('/api/profile/2fa/step-up', { method: 'email' });
    assert.equal(send.status, 200, send.text.slice(0, 200));
    assert.equal(send.json?.data?.sent, true);
    assert.equal(sent.length, before + 1);
    const again = await c.post('/api/profile/2fa/step-up', { method: 'email' });
    assert.equal(again.status, 429);
    assert.equal(again.json?.code, 'STEP_UP_EMAIL_COOLDOWN');

    const code = lastCodeTo(email);
    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await c.post('/api/profile/2fa/step-up', { method: 'email', code: wrong })).status, 400);
    const ok = await c.post('/api/profile/2fa/step-up', { method: 'email', code });
    assert.equal(ok.status, 200, ok.text.slice(0, 200));
    assert.equal((await c.get('/api/profile/2fa/step-up')).json?.data?.fresh, true);
  });

  lotIt('W11-2', '86.7 only the sensitive branch is gated, and the capability check comes first', async () => {
    // Default: a global Lift is gated...
    const admin = await freshAdmin();
    const globalBan = await insertBan(h.db, { ip: nextIp(), scope: 'global' });
    assertStepUpRequired(await admin.del(`/api/bans/${globalBan}`), 'bans.liftGlobal');
    assert.equal((await banRow(h.db, globalBan))?.is_active, true);
    // ...a tenant's Lift of the same global ban is a local exclusion: not gated.
    const member = await plainLogin('member_b');
    const local = await member.del(`/api/bans/${globalBan}`);
    assert.equal(local.status, 200, local.text.slice(0, 200));
    // A tenant-scoped whitelist entry is not gated; a global one is.
    const tenantAdmin = await createUser(h.db, { tenants: [2], tenantRole: 'admin' });
    const ta = await plainLogin(tenantAdmin.username);
    const wl = await ta.post('/api/whitelist', { ip: nextIp() });
    assert.equal(wl.status, 201, wl.text.slice(0, 200));
    assertStepUpRequired(await admin.post('/api/whitelist', { ip: nextIp() }), 'whitelist.global');
    // Renaming a key is not gated; disabling it is.
    await stepUp(ta);
    const key = await ta.post('/api/agent/keys', { name: 'gate-key' });
    assert.ok(key.status === 200 || key.status === 201, key.text.slice(0, 200));
    const keyId = key.json?.data?.id;
    assert.ok(keyId, 'key id');
    const ta2 = await plainLogin(tenantAdmin.username);
    assert.equal((await ta2.put(`/api/agent/keys/${keyId}`, { name: 'renamed' })).status, 200);
    assertStepUpRequired(await ta2.put(`/api/agent/keys/${keyId}`, { isActive: false }), 'keys.manage');
    // No capability: 403 before any prompt.
    const denied = await member.post('/api/agent/keys', { name: 'nope' });
    assert.equal(denied.status, 403);
    // Platform role grant and admin password reset are gated.
    assertStepUpRequired(await admin.put(`/api/users/${tenantAdmin.id}`, { role: 'admin' }), 'users.role');
    assertStepUpRequired(await admin.put(`/api/users/${tenantAdmin.id}/password`, { password: 'Another-Pass-2!' }), 'users.credentials');
    assertStepUpRequired(await admin.put('/api/admin/config/oblitools_api_key', { value: 'x' }), 'appConfig.secrets');
    // A harmless config key is not.
    assert.equal((await admin.put('/api/admin/config/oblitools_instance_name', { value: 'verify' })).status, 200);
  });

  lotIt('W11-2', '86.8 Obligate (og_) accounts are exempt, and the exemption is audited', async () => {
    // Tenant admin of tenant 2 (memberships come from the assertion).
    const r = await h.ssoLogin({
      obligateUserId: OG.obligateUserId, username: 'sso', email: 'og_sso@verify.test',
      tenants: [{ slug: 'tenant-b', role: 'admin' }],
    });
    assert.equal(r.callback.status, 200);
    const st = await r.client.get('/api/profile/2fa/step-up');
    assert.equal(st.status, 200);
    assert.equal(st.json?.data?.exempt, true);
    assert.equal((await r.client.switchTenant(2)).status, 200);
    const created = await r.client.post('/api/agent/keys', { name: 'og-key' });
    assert.notEqual(created.json?.code, 'TWO_FACTOR_REQUIRED', created.text.slice(0, 200));
    assert.ok(created.status === 200 || created.status === 201, `${created.status} ${created.text.slice(0, 200)}`);
    const rows = await h.db('audit_logs').where({ action: 'auth.stepUp.exempt', user_id: OG.userId }) as Array<{ target_id: string }>;
    assert.ok(rows.some((x) => x.target_id === 'keys.manage'), 'exemption audited');
  });

  lotIt('W11-2', '86.9 wrong proofs are throttled per account (5 / 15 min)', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const c = await plainLogin(u.username);
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/api/profile/2fa/step-up', { method: 'password', password: `wrong-${i}` });
      assert.equal(r.status, 400, `attempt ${i}`);
    }
    const capped = await c.post('/api/profile/2fa/step-up', { method: 'password', password: PASSWORD });
    assert.equal(capped.status, 429);
    assert.equal((await c.get('/api/profile/2fa/step-up')).json?.data?.fresh, false);
  });

  lotIt('W11-2', '86.11 the gate reads :id like the controllers (no bypass by an odd id spelling); an unchanged role is not a grant', async () => {
    const admin = await freshAdmin();
    // parseInt('<id>x') is the ban for the Lift / promote controllers.
    const globalBan = await insertBan(h.db, { ip: nextIp(), scope: 'global' });
    assertStepUpRequired(await admin.del(`/api/bans/${globalBan}x`), 'bans.liftGlobal');
    assert.equal((await banRow(h.db, globalBan))?.is_active, true, 'not lifted without a step-up');
    assertStepUpRequired(await admin.post(`/api/bans/${globalBan}x/promote-global`, {}), 'bans.promote');
    // Agents are resolved by id OR uuid: deleting by uuid is gated too.
    const key = await createKey(h.db, 1);
    const dev = await createDevice(h.db, { tenantId: 1, keyId: key.id });
    assertStepUpRequired(await admin.del(`/api/agent/devices/${encodeURIComponent(dev.uuid)}`), 'agents.delete');
    assertStepUpRequired(await admin.post(`/api/agent/devices/${encodeURIComponent(dev.uuid)}/command`, { command: 'uninstall' }), 'agents.uninstall');
    assert.ok(await h.db('agent_devices').where({ id: dev.id }).first('id'), 'agent kept');
    // The edit form always sends the role: an unchanged one is not gated, a change is.
    const u = await createUser(h.db, { tenants: [1] });
    const same = await admin.put(`/api/users/${u.id}`, { displayName: 'Renamed', role: 'user' });
    assert.equal(same.status, 200, same.text.slice(0, 200));
    assertStepUpRequired(await admin.put(`/api/users/${u.id}`, { role: 'admin' }), 'users.role');
    assert.equal((await h.db('users').where({ id: u.id }).first('role'))?.role, 'user');
  });

  lotIt('W11-2', '86.10 a client that confirms and replays (browser behaviour) keeps every other answer', async () => {
    const admin = withAutoStepUp(await freshAdmin());
    const banId = await insertBan(h.db, { ip: nextIp(), scope: 'global' });
    // Default: confirmed transparently, the wipe goes through.
    assert.equal((await admin.post('/api/bans/wipe-bans', {})).status, 200);
    assert.equal((await banRow(h.db, banId))?.is_active, false);
    // Outside Default the wipe is refused by its own rule (403), never a prompt.
    const inB = withAutoStepUp(await plainLogin('admin'));
    assert.equal((await inB.switchTenant(2)).status, 200);
    const refused = await inB.post('/api/bans/wipe-bans', {});
    assert.equal(refused.status, 403);
    assert.notEqual(refused.json?.code, 'TWO_FACTOR_REQUIRED');
    // A foreign agent is refused by the agent routes (god view is read-only), no prompt.
    const foreign = await h.db('agent_devices').whereNot({ tenant_id: 1 }).first('id') as { id: number } | undefined;
    if (foreign) {
      const raw = await freshAdmin();
      const del = await raw.del(`/api/agent/devices/${foreign.id}`);
      assert.notEqual(del.json?.code, 'TWO_FACTOR_REQUIRED', 'no prompt for a write that cannot happen');
      assert.ok(del.status === 403 || del.status === 404, `${del.status}`);
    }
  });
});
