/**
 * 20 — A1 tenant access: no Default fallback, per-request revalidation,
 * operating-tenant assertion, input validation, capability source.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { ALL_CAPABILITIES } from '@obliview/shared';
import { startHarness, sleep, totp } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import { U } from '../fixtures';
import { createUser, createTotpUser, insertBan, banRow, exclusions, nextIp } from '../seed';
import { tenantService } from '../../src/services/tenant.service';
import { permissionService } from '../../src/services/permission.service';
import { AppError, errorHandler } from '../../src/middleware/errorHandler';

const HDR = 'x-obliguard-tenant';
const SRC = path.resolve(__dirname, '..', '..', 'src');
const CLIENT_SRC = path.resolve(__dirname, '..', '..', '..', 'client', 'src');

describe('20 tenant access (A1)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const sessionTenant = async (c: Client): Promise<number | null> => {
    const row = await h.db('session').where({ sid: c.sid() }).first('sess');
    const sess = typeof row?.sess === 'string' ? JSON.parse(row.sess) : row?.sess;
    return sess?.currentTenantId ?? null;
  };
  const wlRows = (cidr: string) => h.db('ip_whitelist').whereRaw('ip = ?::cidr', [cidr]);

  lotIt('A1', '20.1 a local user without tenant: noTenantAccess, global routes still work', async () => {
    const u = await createUser(h.db, { tenants: [] });
    const c = await h.login(u.username);
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.data.currentTenantId, null);
    assert.equal(me.json.data.noTenantAccess, true);
    assert.deepEqual(me.json.data.permissions.capabilities, []);
    for (const [method, p, body] of [
      ['GET', '/api/bans', undefined],
      ['GET', '/api/agent/devices', undefined],
      ['PATCH', '/api/agent/devices/1', { name: 'x' }],
      ['POST', '/api/bans/bulk-ban', { ips: [nextIp()] }],
    ] as const) {
      const r = await c.request(method, p, { body });
      assert.equal(r.status, 403, `${method} ${p}`);
      assert.equal(r.json?.code, 'noTenantAccess', `${method} ${p}`);
    }
    assert.equal((await c.get('/api/profile')).status, 200);
    assert.equal((await c.put('/api/profile', { displayName: 'x' })).status, 200);
    assert.equal((await c.get('/api/profile/2fa/status')).status, 200);
    const t = await c.get('/api/tenants');
    assert.equal(t.status, 200);
    assert.deepEqual(t.json.data, []);
  });

  lotIt('A1', '20.2 platform admins keep their landing tenant', async () => {
    const a = await h.login('admin');
    const me = await a.get('/api/auth/me');
    assert.equal(me.json.data.currentTenantId, 1);
    assert.equal(me.json.data.noTenantAccess, false);
    assert.equal((await a.get('/api/bans')).status, 200);
    const pa = await createUser(h.db, { role: 'admin', tenants: [2, 3] });
    const c = await h.login(pa.username);
    assert.equal((await c.get('/api/auth/me')).json.data.currentTenantId, 2);
  });

  lotIt('A1', '20.3 requireTenant is read-only; /auth/me repairs the session', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const c = await h.login(u.username);
    assert.equal((await c.get('/api/bans')).status, 200);
    const admin = await h.as('admin');
    assert.equal((await admin.del(`/api/tenants/2/members/${u.id}`)).status, 200);
    const r = await c.get('/api/bans');
    assert.equal(r.status, 403);
    assert.equal(r.json?.code, 'noTenantAccess');
    assert.equal(r.headers['set-cookie'], undefined);
    assert.equal(await sessionTenant(c), 2);
    const me = await c.get('/api/auth/me');
    assert.equal(me.json.data.currentTenantId, null);
    assert.equal(me.json.data.noTenantAccess, true);
    assert.equal(await sessionTenant(c), null);
  });

  lotIt('A1', '20.4 a membership deleted behind the API is refused within the cache TTL', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const c = await h.login(u.username);
    assert.equal((await c.get('/api/bans')).status, 200);
    await h.db('user_tenants').where({ user_id: u.id }).del();
    const t0 = Date.now();
    let status = 0;
    while (Date.now() - t0 < 5500) {
      status = (await c.get('/api/bans')).status;
      if (status === 403) break;
      await sleep(500);
    }
    assert.equal(status, 403, 'still allowed after 5.5 s');
  });

  lotIt('A1', '20.5 losing the session tenant re-resolves to the remaining membership', async () => {
    const u = await createUser(h.db, { tenants: [2, 3] });
    const c = await h.login(u.username);
    assert.equal((await c.switchTenant(3)).status, 200);
    const admin = await h.as('admin');
    assert.equal((await admin.del(`/api/tenants/3/members/${u.id}`)).status, 200);
    assert.equal((await c.get('/api/bans')).status, 403);
    const me = await c.get('/api/auth/me');
    assert.equal(me.json.data.currentTenantId, 2);
    assert.equal(me.json.data.noTenantAccess, false);
    assert.equal((await c.get('/api/bans')).status, 200);
  });

  lotIt('A1', '20.6 writes from a tab that shows another tenant are refused (409)', async () => {
    const u = await createUser(h.db, { tenants: [2, 3] });
    const c = await h.login(u.username);
    assert.equal((await c.get('/api/auth/me')).json.data.currentTenantId, 2);

    const a = `${nextIp()}/32`;
    const r1 = await c.post('/api/whitelist', { ip: a }, { headers: { [HDR]: '3' } });
    assert.equal(r1.status, 409);
    assert.equal(r1.json?.code, 'tenantChanged');
    assert.equal((await wlRows(a)).length, 0);

    const b = `${nextIp()}/32`;
    const r2 = await c.post('/api/whitelist', { ip: b }, { headers: { [HDR]: '2' } });
    assert.equal(r2.status, 201);
    assert.equal(r2.headers[HDR], '2');

    const d = `${nextIp()}/32`;
    assert.equal((await c.post('/api/whitelist', { ip: d })).status, 201, 'no header = compatibility');

    const e = `${nextIp()}/32`;
    assert.equal((await c.post('/api/whitelist', { ip: e }, { headers: { [HDR]: 'abc' } })).status, 201, 'malformed header = absent');
  });

  lotIt('A1', '20.7 reads with a mismatched header pass and echo the session tenant', async () => {
    const mb = await h.login('member_b');
    const r = await mb.get('/api/bans', { headers: { [HDR]: '3' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers[HDR], '2');
    const nt = await h.login('no_tenant');
    const r2 = await nt.post('/api/whitelist', { ip: `${nextIp()}/32` }, { headers: { [HDR]: '2' } });
    assert.equal(r2.status, 403);
    assert.equal(r2.json?.code, 'noTenantAccess');
  });

  lotIt('A1', '20.8 a stale tab cannot make a global Lift from Default', async () => {
    const a = await h.login('admin');
    assert.equal((await a.switchTenant(1)).status, 200);
    const id = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1 });
    const r = await a.del(`/api/bans/${id}`, undefined, { headers: { [HDR]: '3' } });
    assert.equal(r.status, 409);
    assert.equal(r.json?.code, 'tenantChanged');
    assert.equal((await banRow(h.db, id))!.is_active, true);
    assert.equal((await exclusions(h.db, id)).length, 0);
    const ok = await a.del(`/api/bans/${id}`, undefined, { headers: { [HDR]: '1' } });
    assert.equal(ok.status, 200);
    assert.equal((await banRow(h.db, id))!.is_active, false);
  });

  lotIt('A1', '20.9 /tenant/switch validates its input and invalidates stale negatives', async () => {
    const a = await h.login('admin');
    assert.equal((await a.switchTenant(999999)).status, 404);
    for (const bad of ['2', 0, 2.5, -1, null]) {
      assert.equal((await a.post('/api/tenant/switch', { tenantId: bad })).status, 400, `tenantId ${String(bad)}`);
    }
    const mb = await h.login('member_b');
    assert.equal((await mb.switchTenant(3)).status, 403);
    assert.equal((await mb.switchTenant(2)).status, 200);

    const u = await createUser(h.db, { tenants: [2] });
    const c = await h.login(u.username);
    await h.setSessionTenant(c, 3);
    assert.equal((await c.get('/api/bans')).status, 403); // cached negative for (u, 3)
    await h.db('user_tenants').insert({ user_id: u.id, tenant_id: 3, role: 'member' });
    assert.equal((await c.switchTenant(3)).status, 200);
    assert.equal((await c.get('/api/bans')).status, 200);
  });

  lotIt('A1', '20.10 tenant member routes validate role, user and tenant', async () => {
    const admin = await h.as('admin');
    const u = await createUser(h.db, { tenants: [] });
    assert.equal((await admin.post('/api/tenants/2/members', { userId: u.id, role: 'owner' })).status, 400);
    assert.equal((await admin.post('/api/tenants/2/members', { userId: 999999 })).status, 404);
    assert.equal((await admin.post('/api/tenants/999999/members', { userId: u.id })).status, 404);
    assert.equal((await admin.post('/api/tenants/abc/members', { userId: u.id })).status, 400);
    assert.equal((await admin.put(`/api/tenants/2/members/${u.id}`, { role: 'root' })).status, 400);
    assert.equal((await admin.post('/api/tenants/2/members', { userId: u.id, role: 'member' })).status, 200);
    assert.ok(await h.db('user_tenants').where({ user_id: u.id, tenant_id: 2 }).first());
  });

  lotIt('A1', '20.11 deleting a tenant revokes access of admins and members sitting on it', async () => {
    const admin2 = await h.login('admin2');
    const t = await admin2.post('/api/tenants', { name: 'Doomed', slug: `doomed-${Date.now()}` });
    assert.equal(t.status, 201);
    const tid = t.json.data.id as number;
    const onlyT = await createUser(h.db, { tenants: [tid] });
    const alsoB = await createUser(h.db, { tenants: [2, tid] });
    const a1 = await h.login('admin');
    assert.equal((await a1.switchTenant(tid)).status, 200);
    const c1 = await h.login(onlyT.username);
    const c2 = await h.login(alsoB.username);
    assert.equal((await c2.switchTenant(tid)).status, 200);
    assert.equal((await a1.get('/api/bans')).status, 200);
    assert.equal((await c1.get('/api/bans')).status, 200);

    assert.equal((await admin2.del(`/api/tenants/${tid}`)).status, 200);

    const r = await a1.get('/api/bans');
    assert.equal(r.status, 403);
    assert.equal(r.json?.code, 'noTenantAccess');
    assert.equal((await a1.get('/api/auth/me')).json.data.currentTenantId, 1);
    assert.equal((await c1.get('/api/bans')).status, 403);
    assert.equal((await c1.get('/api/auth/me')).json.data.noTenantAccess, true);
    assert.equal((await c2.get('/api/bans')).status, 403);
    assert.equal((await c2.get('/api/auth/me')).json.data.currentTenantId, 2);
  });

  lotIt('A1', '20.12 PUT /users/:id/tenants validates and revokes at once', async () => {
    const admin = await h.as('admin');
    const u = await createUser(h.db, { tenants: [2, 3] });
    const put = (assignments: unknown, id = u.id) => admin.put(`/api/users/${id}/tenants`, { assignments });
    assert.equal((await put([{ tenantId: 'x', role: 'member' }])).status, 400);
    assert.equal((await put([{ tenantId: 2, role: 'owner' }])).status, 400);
    assert.equal((await put([{ tenantId: 2, role: 'member' }, { tenantId: 2, role: 'admin' }])).status, 400);
    assert.equal((await put([{ tenantId: 999999, role: 'member' }])).status, 404);
    assert.equal((await put([{ tenantId: 2, role: 'member' }], 999999)).status, 404);

    const c = await h.login(u.username);
    assert.equal((await c.switchTenant(3)).status, 200);
    assert.equal((await c.get('/api/bans')).status, 200);
    assert.equal((await put([{ tenantId: 2, role: 'member' }])).status, 200);
    assert.equal((await c.get('/api/bans')).status, 403);
  });

  lotIt('A1', '20.13 2FA verify: no-tenant users land nowhere; disabled users are refused', async () => {
    const u = await createTotpUser(h.db, { tenants: [] });
    const { client } = await h.loginStep1(u.username);
    assert.equal((await client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(u.secret) })).status, 200);
    assert.equal((await client.get('/api/auth/me')).json.data.noTenantAccess, true);

    const d = await createTotpUser(h.db, { tenants: [2] });
    const step = await h.loginStep1(d.username);
    await h.db('users').where({ id: d.id }).update({ is_active: false });
    const v = await step.client.post('/api/profile/2fa/verify', { method: 'totp', code: totp(d.secret) });
    assert.equal(v.status, 400);
    assert.match(String(v.json?.error), /pending/i);
    assert.equal((await step.client.get('/api/auth/me')).status, 401);
  });

  lotIt('A1', '20.14 /auth/me aligns the session role with the DB', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const c = await h.login(u.username);
    assert.equal((await c.get('/api/profile')).status, 200); // warms the account-state cache (role user)
    await h.setSessionTenant(c, 1);
    await h.db('users').where({ id: u.id }).update({ role: 'admin' });
    const me = await c.get('/api/auth/me');
    assert.equal(me.json.data.currentTenantId, 1);
    assert.equal(me.json.data.noTenantAccess, false);
    assert.equal((await c.get('/api/bans')).status, 200);
  });

  lotIt('A1', '20.15 resolveLoginTenant: favourite, first membership, Default for admins only', async () => {
    const none = await createUser(h.db, { tenants: [] });
    assert.equal(await tenantService.resolveLoginTenant(none.id, 'user'), null);
    assert.equal(await tenantService.resolveLoginTenant(none.id, 'admin'), 1);
    const two = await createUser(h.db, { tenants: [3, 2] });
    assert.equal(await tenantService.resolveLoginTenant(two.id, 'user'), 2);
    await tenantService.setPreferredTenant(two.id, 3);
    assert.equal(await tenantService.resolveLoginTenant(two.id, 'user'), 3);
    await tenantService.setPreferredTenant(none.id, 3);
    assert.equal(await tenantService.resolveLoginTenant(none.id, 'user'), null, 'favourite without membership');
    assert.equal(await tenantService.resolveLoginTenant(none.id, 'admin'), 3, 'platform admin favourite');
  });

  lotIt('A1', '20.16 capabilities come only from membership of the given tenant', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const [team] = await h.db('user_teams').insert({ name: `caps-${u.id}`, tenant_id: 2 }).returning('id') as Array<{ id: number }>;
    await h.db('team_memberships').insert({ team_id: team.id, user_id: u.id });
    await h.db('team_permissions').insert({ team_id: team.id, scope: 'group', scope_id: 2, level: 'rw', capabilities: JSON.stringify(['bans', 'whitelist']) });
    const all = [...ALL_CAPABILITIES].sort();
    assert.deepEqual(await permissionService.getUserCapabilities(u.id, false, 1), []);
    assert.deepEqual(await permissionService.getUserCapabilities(u.id, false, undefined), []);
    assert.deepEqual([...await permissionService.getUserCapabilities(u.id, false, 2)].sort(), all);
    // member_b is in C-team (tenant C, pinned 'bans') without being a member of C.
    assert.deepEqual(await permissionService.getUserCapabilities(U.member_b, false, 3), []);
    assert.deepEqual([...await permissionService.getUserCapabilities(U.admin, true, undefined)].sort(), all);
  });

  lotIt('A1', '20.17 AppError codes are emitted only when set', () => {
    const run = (err: Error) => {
      let status = 0;
      let body: any = null;
      const res = { status(s: number) { status = s; return res; }, json(b: unknown) { body = b; return res; } };
      errorHandler(err, {} as any, res as any, () => undefined);
      return { status, body };
    };
    const a = run(new AppError(400, 'x'));
    assert.equal(a.status, 400);
    assert.deepEqual(a.body, { success: false, error: 'x' });
    const b = run(new AppError(403, 'No tenant access', 'noTenantAccess'));
    assert.equal(b.body.code, 'noTenantAccess');
    const c = run(new AppError(409, 'Workspace changed in another tab', 'tenantChanged'));
    assert.equal(c.status, 409);
    assert.equal(c.body.code, 'tenantChanged');
  });

  lotIt('A1', '20.18 static guards', () => {
    const read = (p: string) => fs.readFileSync(p, 'utf8');
    const fallback = /currentTenantId\s*=.*\?\?\s*1|\.id\s*\?\?\s*1/;
    for (const f of ['controllers/auth.controller.ts', 'controllers/twoFactor.controller.ts', 'routes/obligateCallback.routes.ts']) {
      assert.doesNotMatch(read(path.join(SRC, f)), fallback, `${f}: Default tenant fallback`);
    }
    const legacyCaps = /team_permissions[\s\S]{0,200}capabilities/;
    for (const f of ['services/permission.service.ts', 'routes/obligateCallback.routes.ts']) {
      assert.doesNotMatch(read(path.join(SRC, f)), legacyCaps, `${f}: legacy team capabilities`);
    }
    for (const lang of ['en', 'fr']) {
      const text = read(path.join(CLIENT_SRC, 'i18n', 'locales', lang, 'translation.json'));
      assert.equal((text.match(/"tenant": \{/g) ?? []).length, 1, `${lang}: "tenant" object must be unique`);
      const json = JSON.parse(text);
      for (const k of ['title', 'body', 'retry', 'ssoBody', 'ssoRetry']) assert.ok(json.tenant.noAccess[k], `${lang}: tenant.noAccess.${k}`);
    }
    const ipr = read(path.join(CLIENT_SRC, 'pages', 'IPReputationPage.tsx'));
    assert.doesNotMatch(ipr, /(?<![A-Za-z])fetch\(/, 'IPReputationPage: raw fetch(');
  });
});
