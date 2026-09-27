/**
 * 22 — A1 tenant access through Obligate SSO (fake Obligate) and the
 * tenant-scoped /auth/device-links.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, waitFor } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import { D } from '../fixtures';

describe('22 tenant access — SSO (A1)', () => {
  let h: Harness;
  before(async () => { h = await startHarness({ obligate: true }); });
  after(async () => { await h.close(); });

  const sessionOf = async (c: Client): Promise<Record<string, any> | null> => {
    const row = await h.db('session').where({ sid: c.sid() }).first('sess');
    if (!row) return null;
    return typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
  };
  /** Number of device-link lookups the server made against (fake) Obligate. */
  const linkCalls = () => h.obligate!.requests.filter((r) => r.path === '/api/devices/links' && r.method === 'GET').length;

  lotIt('A1', '22.1 an SSO user whose tenants are unknown locally gets no tenant', async () => {
    const r = await h.ssoLogin({ obligateUserId: 9201, username: 'nope1', role: 'user', tenants: [{ slug: 'nope', role: 'member' }] });
    assert.equal(r.callback.status, 200);
    const sess = await sessionOf(r.client);
    assert.ok(sess?.userId);
    assert.equal(sess?.currentTenantId ?? null, null);
    const me = await r.client.get('/api/auth/me');
    assert.equal(me.json.data.noTenantAccess, true);
    assert.equal(me.json.data.currentTenantId, null);
  });

  lotIt('A1', '22.2 an SSO platform admin without membership lands on Default', async () => {
    const r = await h.ssoLogin({ obligateUserId: 9202, username: 'boss', role: 'admin', tenants: [{ slug: 'nope', role: 'member' }] });
    const me = await r.client.get('/api/auth/me');
    assert.equal(me.json.data.currentTenantId, 1);
    assert.equal(me.json.data.noTenantAccess, false);
  });

  lotIt('A1', '22.3 an assertion without tenants does not crash', async () => {
    const r = await h.ssoLogin({ obligateUserId: 9203, username: 'bare', role: 'user', tenants: undefined });
    assert.equal(r.callback.status, 200);
    assert.equal((await r.client.get('/api/auth/me')).json.data.noTenantAccess, true);
  });

  lotIt('A1', '22.4 asserted capabilities never rewrite team permissions', async () => {
    const before = await h.db('team_permissions').where({ team_id: 2 }).first();
    const r = await h.ssoLogin({
      obligateUserId: 9204, username: 'capper', teams: ['B-team'],
      tenants: [{ slug: 'tenant-b', role: 'member', capabilities: ['bans', 'whitelist', 'monitor_rw'] }],
    });
    assert.equal(r.callback.status, 200);
    const after = await h.db('team_permissions').where({ team_id: 2 }).first();
    assert.deepEqual(after.capabilities, before.capabilities);
  });

  lotIt('A1', '22.5 a fresh SSO grant beats a cached negative decision', async () => {
    const first = await h.ssoLogin({ obligateUserId: 9205, username: 'late', role: 'user', tenants: [] });
    await h.setSessionTenant(first.client, 2);
    const denied = await first.client.get('/api/bans');
    assert.equal(denied.status, 403); // (user, 2) cached as refused
    const second = await h.ssoLogin({ obligateUserId: 9205, username: 'late', role: 'user', tenants: [{ slug: 'tenant-b', role: 'member' }] });
    assert.equal((await second.client.get('/api/bans')).status, 200);
  });

  lotIt('A1', '22.6 an SSO platform-role demotion closes the live admin sockets', async () => {
    const a = await h.ssoLogin({ obligateUserId: 9206, username: 'demoted', role: 'admin', tenants: [{ slug: 'tenant-b', role: 'member' }] });
    const s = await h.socket(a.client);
    assert.ok(s.ok);
    if (!s.ok) return;
    await h.ssoLogin({ obligateUserId: 9206, username: 'demoted', role: 'user', tenants: [{ slug: 'tenant-b', role: 'member' }] });
    await waitFor(() => s.events.some((e) => e.event === 'disconnect' && e.args[0] === 'io server disconnect'), 1000);
  });

  lotIt('A1', '22.7 device-links is tenant-scoped (Default keeps its god-view read)', async () => {
    const nt = await h.login('no_tenant');
    const r0 = await nt.get(`/api/auth/device-links?uuid=${D.B.uuid}`);
    assert.equal(r0.status, 403);
    assert.equal(r0.json?.code, 'noTenantAccess');

    const n0 = linkCalls();
    const mc = await h.login('member_c');
    const r1 = await mc.get(`/api/auth/device-links?uuid=${D.B.uuid}`);
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.json.data, []);
    assert.equal(linkCalls(), n0, 'foreign device must not be resolved');

    const mb = await h.login('member_b');
    assert.equal((await mb.get(`/api/auth/device-links?uuid=${D.B.uuid}`)).status, 200);
    assert.equal(linkCalls(), n0 + 1);

    const admin = await h.login('admin');
    assert.equal((await admin.get(`/api/auth/device-links?uuid=${D.B.uuid}`)).status, 200);
    assert.equal(linkCalls(), n0 + 2);
  });
});
