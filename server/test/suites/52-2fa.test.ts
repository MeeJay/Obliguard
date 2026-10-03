/**
 * 52 — W4-1 second-factor hardening (backlog A8 / B6):
 *   - /profile/2fa/verify is capped per ACCOUNT (mfaAccountLimiter, keyed on
 *     the pending user): new pending sessions from other addresses do not buy
 *     more guesses;
 *   - TOTP: ±1 step window, anti-replay step persisted (users.totp_last_step);
 *   - e-mail codes: CSPRNG, only a SHA-256 in the session, constant-time
 *     compare, dropped after 5 wrong codes;
 *   - factor management needs a proof (current TOTP code, else the password);
 *   - the TOTP secret is encrypted at rest ("enc:v1:" envelope), a legacy
 *     plaintext secret is sealed at its next sign-in;
 *   - force_2fa: an account with a factor gets through the server-side gate.
 *
 * Outbound mail: nodemailer.createTransport is mocked for the whole suite
 * (codes and notices are captured, nothing leaves the process).
 */
import { describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { startHarness, totp, drain } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import { PASSWORD } from '../fixtures';
import { createUser, createTotpUser } from '../seed';
import { needs2faSetup } from '../../src/middleware/require2faSetup';
import { twoFactorService } from '../../src/services/twoFactor.service';

interface SentMail { to: string; subject: string; text: string }

describe('52 second-factor hardening (W4-1)', () => {
  let h: Harness;
  const sent: SentMail[] = [];

  before(async () => {
    h = await startHarness();
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

  const userRow = (id: number) => h.db('users').where({ id }).first();
  /** The 6-digit code of the last mail sent to `to`. */
  const lastCodeTo = (to: string): string => {
    const m = [...sent].reverse().find((x) => x.to === to && /login code/i.test(x.subject));
    const code = m?.text.match(/\b(\d{6})\b/)?.[1];
    assert.ok(code, `no code mailed to ${to}`);
    return code;
  };
  /** Sessions currently stored for the session cookie of a client. */
  const storedSession = async (c: Client): Promise<string> => {
    const sid = c.sid();
    assert.ok(sid, 'no session cookie');
    const row = await h.db('session').where({ sid }).first('sess');
    assert.ok(row, 'session row not found');
    return typeof row.sess === 'string' ? row.sess : JSON.stringify(row.sess);
  };

  lotIt('A8', '52.1 verify is capped per account across two IPs (10 wrong codes / 15 min)', async () => {
    const u = await createTotpUser(h.db);
    const wrong = (secret: string): string => {
      const valid = new Set([-1, 0, 1].map((o) => totp(secret, o)));
      for (let i = 0; ; i++) {
        const c = String((123457 + i * 7919) % 1_000_000).padStart(6, '0');
        if (!valid.has(c)) return c;
      }
    };
    const a = await h.loginStep1(u.username);
    const b = await h.loginStep1(u.username);
    assert.notEqual(a.client.xff, b.client.xff, 'the two pending sessions must come from two addresses');
    for (let i = 0; i < 6; i++) {
      const r = await a.client.post('/api/profile/2fa/verify', { method: 'totp', code: wrong(u.secret) });
      assert.equal(r.status, 401, `A attempt ${i}`);
    }
    for (let i = 0; i < 4; i++) {
      const r = await b.client.post('/api/profile/2fa/verify', { method: 'totp', code: wrong(u.secret) });
      assert.equal(r.status, 401, `B attempt ${i}`);
    }
    // The account budget (10) is spent: even the right code from B is refused.
    const capped = await b.client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(u.secret) });
    assert.equal(capped.status, 429);
    assert.equal((await b.client.get('/api/auth/me')).status, 401);
    assert.equal((await userRow(u.id)).totp_last_step, null, 'no step may be accepted while capped');

    // Another account, from a fresh address, is not affected.
    const v = await createTotpUser(h.db);
    const c = await h.loginStep1(v.username);
    assert.equal((await c.client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(v.secret) })).status, 200);
  });

  lotIt('A8', '52.2 TOTP: ±1 step window, the accepted step is persisted and never accepted again', async () => {
    const u = await createTotpUser(h.db);
    const near = new Set([-1, 0, 1].map((o) => totp(u.secret, o)));
    const far = totp(u.secret, -2);
    const s1 = await h.loginStep1(u.username);
    if (!near.has(far)) {
      // 60 s old: inside the former ±2 window, refused now.
      assert.equal((await s1.client.post('/api/profile/2fa/verify', { method: 'totp', code: far })).status, 401);
    }
    const code = totp(u.secret);
    assert.equal((await s1.client.post('/api/profile/2fa/verify', { method: 'totp', code })).status, 200);
    const step = Number((await userRow(u.id)).totp_last_step);
    assert.ok(Math.abs(step - Math.floor(Date.now() / 30_000)) <= 1, `totp_last_step ${step}`);

    // Same code, another pending session: replay refused, nothing changes.
    const s2 = await h.loginStep1(u.username);
    assert.equal((await s2.client.post('/api/profile/2fa/verify', { method: 'totp', code })).status, 401);
    assert.equal((await s2.client.get('/api/auth/me')).status, 401);
    assert.equal(Number((await userRow(u.id)).totp_last_step), step);
    // The next step is a new code: accepted.
    assert.equal((await s2.client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(u.secret, 1) })).status, 200);
    assert.ok(Number((await userRow(u.id)).totp_last_step) > step);
  });

  lotIt('A8', '52.3 e-mail codes: hashed in the session, compared, dropped after 5 wrong codes', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    await h.db('users').where({ id: u.id }).update({ email_otp_enabled: true });
    const email = `${u.username}@verify.test`;

    const s1 = await h.loginStep1(u.username);
    assert.equal(s1.res.json?.data?.requires2fa, true);
    const code = lastCodeTo(email);
    const sess = await storedSession(s1.client);
    assert.ok(!sess.includes(code), 'the e-mail code must not be stored in the session');
    assert.match(sess, /"codeHash":"[0-9a-f]{64}"/);

    const wrongCode = code === '000000' ? '000001' : '000000';
    assert.equal((await s1.client.post('/api/profile/2fa/verify', { method: 'email', code: wrongCode })).status, 401);
    assert.equal((await s1.client.get('/api/auth/me')).status, 401);
    assert.equal((await s1.client.post('/api/profile/2fa/verify', { method: 'email', code })).status, 200);
    assert.equal((await s1.client.get('/api/auth/me')).json?.data?.user?.id, u.id);

    // 5 wrong codes drop the pending code: the right one no longer works.
    const v = await createUser(h.db, { tenants: [2] });
    await h.db('users').where({ id: v.id }).update({ email_otp_enabled: true });
    const s2 = await h.loginStep1(v.username);
    const code2 = lastCodeTo(`${v.username}@verify.test`);
    const wrong2 = code2 === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) {
      assert.equal((await s2.client.post('/api/profile/2fa/verify', { method: 'email', code: wrong2 })).status, 401, `attempt ${i}`);
    }
    assert.equal((await s2.client.post('/api/profile/2fa/verify', { method: 'email', code: code2 })).status, 401);
    assert.equal((await s2.client.get('/api/auth/me')).status, 401);
    // A new code (resend) works again.
    assert.equal((await s2.client.post('/api/profile/2fa/resend-email', {})).status, 200);
    const code3 = lastCodeTo(`${v.username}@verify.test`);
    assert.equal((await s2.client.post('/api/profile/2fa/verify', { method: 'email', code: code3 })).status, 200);
  });

  lotIt('A8', '52.4 TOTP secret encrypted at rest after enable; sign-in still works', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const c = await h.login(u.username);
    const setup = await c.post('/api/profile/2fa/totp/setup', {});
    assert.equal(setup.status, 200, setup.text);
    const secret = String(setup.json?.data?.secret ?? '');
    assert.match(secret, /^[A-Z2-7]{16,}$/);
    const enableCode = totp(secret);
    const en = await c.post('/api/profile/2fa/totp/enable', { code: enableCode });
    assert.equal(en.status, 200, en.text);

    const row = await userRow(u.id);
    assert.equal(row.totp_enabled, true);
    assert.ok(row.totp_secret, 'secret stored');
    assert.notEqual(row.totp_secret, secret);
    assert.ok(!String(row.totp_secret).includes(secret), 'the stored value must not contain the plaintext secret');
    assert.match(String(row.totp_secret), /^enc:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    assert.notEqual(row.totp_last_step, null, 'the enabling step is recorded');

    // The enabling code cannot sign in; the next step can.
    const s1 = await h.loginStep1(u.username);
    assert.equal((await s1.client.post('/api/profile/2fa/verify', { method: 'totp', code: enableCode })).status, 401);
    assert.equal((await s1.client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(secret, 1) })).status, 200);
  });

  lotIt('A8', '52.5 a legacy plaintext secret is accepted and sealed at its next sign-in', async () => {
    const u = await createTotpUser(h.db);
    assert.equal((await userRow(u.id)).totp_secret, u.secret);
    const s = await h.loginStep1(u.username);
    assert.equal((await s.client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(u.secret) })).status, 200);
    const stored = String((await userRow(u.id)).totp_secret);
    assert.match(stored, /^enc:v1:/);
    assert.ok(!stored.includes(u.secret));
  });

  lotIt('A8', '52.6 TOTP management needs a current, unused code', async () => {
    const u = await createTotpUser(h.db);
    const s = await h.loginStep1(u.username);
    const signInCode = totp(u.secret);
    assert.equal((await s.client.post('/api/profile/2fa/verify', { method: 'totp', code: signInCode })).status, 200);
    const c = s.client;

    // Replacing the TOTP: no code, then the (already used) sign-in code.
    const noProof = await c.post('/api/profile/2fa/totp/setup', {});
    assert.equal(noProof.status, 400);
    assert.equal(noProof.json?.proofRequired, 'totp');
    assert.equal((await c.post('/api/profile/2fa/totp/setup', { currentCode: signInCode })).status, 400);
    // Removing it: same rules; the stored secret is untouched until a valid proof.
    assert.equal((await c.del('/api/profile/2fa/totp', {})).status, 400);
    assert.equal((await c.del('/api/profile/2fa/totp', { currentCode: signInCode })).status, 400);
    assert.equal((await userRow(u.id)).totp_enabled, true);
    const ok = await c.del('/api/profile/2fa/totp', { currentCode: totp(u.secret, 1) });
    assert.equal(ok.status, 200, ok.text);
    const row = await userRow(u.id);
    assert.equal(row.totp_enabled, false);
    assert.equal(row.totp_secret, null);
    // The owner is told (OTP SMTP configured).
    // The notice is sent fire-and-forget after the response: wait for it.
    assert.ok(await drain(() => sent.some((m) => m.to === `${u.username}@verify.test` && /removed/i.test(m.subject))), 'factor-change notice');
  });

  lotIt('A8', '52.7 e-mail codes management needs the current password (no TOTP)', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const email = `${u.username}@verify.test`;
    const c = await h.login(u.username);

    const noProof = await c.post('/api/profile/2fa/email/setup', {});
    assert.equal(noProof.status, 400);
    assert.equal(noProof.json?.proofRequired, 'password');
    assert.equal((await c.post('/api/profile/2fa/email/setup', { currentPassword: 'not-the-password' })).status, 400);
    // Codes only go to the profile address (an address change is PUT /profile's job).
    assert.equal((await c.post('/api/profile/2fa/email/setup', { email: 'attacker@evil.test', currentPassword: PASSWORD })).status, 400);
    assert.ok(!sent.some((m) => m.to === 'attacker@evil.test'));

    assert.equal((await c.post('/api/profile/2fa/email/setup', { currentPassword: PASSWORD })).status, 200);
    const code = lastCodeTo(email);
    assert.ok(!(await storedSession(c)).includes(`"${code}"`), 'setup code not stored in clear');
    assert.equal((await c.post('/api/profile/2fa/email/enable', { code })).status, 200);
    let row = await userRow(u.id);
    assert.equal(row.email_otp_enabled, true);
    assert.equal(row.email, email);

    // Disabling: password required.
    assert.equal((await c.del('/api/profile/2fa/email', {})).status, 400);
    assert.equal((await userRow(u.id)).email_otp_enabled, true);
    assert.equal((await c.del('/api/profile/2fa/email', { currentPassword: PASSWORD })).status, 200);
    row = await userRow(u.id);
    assert.equal(row.email_otp_enabled, false);
  });

  lotIt('A8', '52.8 force_2fa: the gate opens once a factor is set up', async () => {
    await h.db('app_config').insert({ key: 'force_2fa', value: 'true' }).onConflict('key').merge({ value: 'true' });
    try {
      const u = await createUser(h.db, { tenants: [2] });
      const c = await h.login(u.username);
      const blocked = await c.get('/api/bans');
      assert.equal(blocked.status, 403);
      assert.equal(blocked.json?.code, 'twoFactorSetupRequired');
      assert.equal((await c.get('/api/profile')).status, 200);
      assert.equal((await c.get('/api/auth/me')).json?.data?.requires2faSetup, true);
      // Obligate (og_) accounts are exempt: their MFA belongs to Obligate.
      const og = await createUser(h.db, { tenants: [2] });
      assert.equal(await needs2faSetup(og.id), true);
      await h.db('users').where({ id: og.id }).update({ foreign_source: 'obligate' });
      assert.equal(await needs2faSetup(og.id), false);
      // First enrolment: no proof needed.
      const setup = await c.post('/api/profile/2fa/totp/setup', {});
      assert.equal(setup.status, 200, setup.text);
      assert.equal((await c.post('/api/profile/2fa/totp/enable', { code: totp(String(setup.json?.data?.secret)) })).status, 200);
      assert.equal((await c.get('/api/auth/me')).json?.data?.requires2faSetup, false);
      assert.equal((await c.get('/api/bans')).status, 200);
    } finally {
      await h.db('app_config').where({ key: 'force_2fa' }).update({ value: 'false' });
    }
  });

  lotIt('A8', '52.9 replacing the TOTP: proof consumed, new secret sealed, owner notified', async () => {
    const u = await createTotpUser(h.db);
    // Sign in with the previous step, prove with the current one: both are
    // claimed in order, and the new app's enabling code must be newer still.
    const s = await h.loginStep1(u.username);
    assert.equal((await s.client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(u.secret, -1) })).status, 200);
    const c = s.client;
    const setup = await c.post('/api/profile/2fa/totp/setup', { currentCode: totp(u.secret) });
    assert.equal(setup.status, 200, setup.text);
    const fresh = String(setup.json?.data?.secret ?? '');
    assert.match(fresh, /^[A-Z2-7]{16,}$/);
    assert.notEqual(fresh, u.secret);
    // Until enabled, the old secret stays in place (sealed at the sign-in).
    assert.equal(twoFactorService.openTotpSecret((await userRow(u.id)).totp_secret), u.secret);
    const en = await c.post('/api/profile/2fa/totp/enable', { code: totp(fresh, 1) });
    assert.equal(en.status, 200, en.text);
    const row = await userRow(u.id);
    assert.equal(row.totp_enabled, true);
    assert.match(String(row.totp_secret), /^enc:v1:/);
    assert.equal(twoFactorService.openTotpSecret(row.totp_secret), fresh);
    assert.ok(await drain(() => sent.some((m) => m.to === `${u.username}@verify.test` && /replaced/i.test(m.subject))), 'replace notice');
  });
});
