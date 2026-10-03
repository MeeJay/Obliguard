// verify-env: BAN_PROTECTED_IPS=198.18.24.250
/**
 * 24 — A2 manual-ban authority: operating-tenant scope, membership, strict
 * validation and protected set, atomic whitelist/duplicate checks, bulk-ban,
 * promote, visibility (by id, list, stats, lift/exclude), wipe gate, and the
 * other ban paths (engine, external, obli.tools, MikroTik import), plus the
 * banSafetyAudit registry and its delivery skip.
 *
 * Literal block of this suite: 198.18.24.x (PROT = the BAN_PROTECTED_IPS
 * address) and 2001:db8:24::/48.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { startHarness, waitFor } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import {
  insertBan, insertWhitelist, insertEvents, banRow, exclusions, nextIp, createUser, createMikrotikDevice,
} from '../seed';
import { U, D, G } from '../fixtures';
import { banService, banEngine } from '../../src/services/ban.service';
import { mikrotikBanSync } from '../../src/services/mikrotik/mikrotikBanSync.service';
import { batchImportIPs } from '../../src/services/mikrotik/mikrotikImport.service';
import { remoteBlocklistService } from '../../src/services/remoteBlocklist.service';
import { refreshUnsafeBanRegistry, isUnsafeBanId } from '../../src/services/banSafetyAudit';
import { RouterOSClient } from '../../src/services/mikrotik/routerosClient';
import { RESERVED_OR_PROTECTED_MESSAGE } from '../../src/utils/ipValidation';
import { AppError } from '../../src/middleware/errorHandler';
import { logger } from '../../src/utils/logger';

const PROT = '198.18.24.250';

interface PushCall { ip: string; action: string; aud: unknown }

describe('24 bans (A2)', () => {
  let h: Harness;
  const pushes: PushCall[] = [];
  const savedPush = mikrotikBanSync.pushBanToAll;

  before(async () => {
    h = await startHarness();
    (mikrotikBanSync as any).pushBanToAll = async (ip: string, action: string, aud?: unknown) => {
      pushes.push({ ip, action, aud });
    };
  });
  after(async () => {
    (mikrotikBanSync as any).pushBanToAll = savedPush;
    await h.close();
  });

  const rowsFor = (ip: string) => h.db('ip_bans').whereRaw('host(ip) = ?', [ip]).orderBy('id');
  const count = async () => Number((await h.db('ip_bans').count<{ c: string }[]>({ c: '*' }))[0].c);
  const bm = () => h.as('member_b');
  const cm = () => h.as('member_c');
  const dm = () => h.as('default_member');
  // Owner decision 12 (_defaults.txt): the protected 'user' set (default_member)
  // no longer holds bans.promote; promotions run as a Default tenant admin.
  let promoter: string | null = null;
  const dp = async () => {
    promoter ??= (await createUser(h.db, { tenants: [1], tenantRole: 'admin' })).username;
    return h.login(promoter);
  };
  const pushed = (ip: string) => pushes.filter((p) => p.ip === ip);

  const withWarnSpy = async <T>(fn: (warns: Array<{ obj: unknown; msg: unknown }>) => Promise<T>): Promise<T> => {
    const warns: Array<{ obj: unknown; msg: unknown }> = [];
    const saved = logger.warn;
    (logger as any).warn = (obj: unknown, msg?: unknown) => { warns.push({ obj, msg }); };
    try { return await fn(warns); } finally { (logger as any).warn = saved; }
  };

  // ── scope ──────────────────────────────────────────────────────────────────

  lotIt('A2', '24.1 the scope follows the operating tenant, never the platform role', async () => {
    const a = nextIp();
    const r1 = await (await bm()).post('/api/bans', { ip: a });
    assert.equal(r1.status, 201);
    assert.equal(r1.json.data.scope, 'tenant');
    assert.equal(r1.json.data.tenantId, 2);
    const [ra] = await rowsFor(a);
    assert.equal(ra.origin_tenant_id, 2);
    assert.equal(ra.banned_by_user_id, U.member_b);
    assert.equal(ra.cidr_prefix, null);

    const b = nextIp();
    const r2 = await (await dm()).post('/api/bans', { ip: b });
    assert.equal(r2.status, 201);
    assert.equal(r2.json.data.scope, 'global');
    assert.equal(r2.json.data.tenantId, null);

    const c = nextIp();
    const r3 = await (await h.adminIn(2)).post('/api/bans', { ip: c });
    assert.equal(r3.status, 201);
    assert.equal(r3.json.data.scope, 'tenant');
    assert.equal((await rowsFor(c))[0].tenant_id, 2);

    // A platform admin with no user_tenants row for Default still bans globally from Default.
    assert.equal(await h.db('user_tenants').where({ user_id: U.admin, tenant_id: 1 }).first(), undefined);
    const d = nextIp();
    const r4 = await (await h.adminIn(1)).post('/api/bans', { ip: d });
    assert.equal(r4.status, 201);
    assert.equal(r4.json.data.scope, 'global');

    const before = await count();
    assert.equal((await (await bm()).post('/api/bans', { ip: nextIp(), scope: 'global' })).status, 403);
    assert.equal((await (await dm()).post('/api/bans', { ip: nextIp(), scope: 'tenant' })).status, 400);
    assert.equal((await (await bm()).post('/api/bans', { ip: nextIp(), scope: 'foo' })).status, 400);
    assert.equal(await count(), before);
  });

  lotIt('A2', '24.2 a non-member (stale session, legacy team capability) cannot ban', async () => {
    const u = await createUser(h.db, { tenants: [] });
    const [team] = await h.db('user_teams').insert({ name: `legacy-${u.id}`, tenant_id: 1 }).returning('id') as Array<{ id: number }>;
    await h.db('team_memberships').insert({ team_id: team.id, user_id: u.id });
    await h.db('team_permissions').insert({ team_id: team.id, scope: 'group', scope_id: G.DEFAULT, level: 'rw', capabilities: JSON.stringify(['bans']) });
    const c = await h.login(u.username);
    await h.setSessionTenant(c, 1);
    const ip = nextIp();
    const before = await count();
    assert.equal((await c.post('/api/bans', { ip })).status, 403);
    assert.equal((await c.post('/api/bans/bulk-ban', { ips: [nextIp()] })).status, 403);
    assert.equal(await count(), before);
    const g = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1 });
    assert.equal((await c.del(`/api/bans/${g}`)).status, 403);
    assert.equal((await banRow(h.db, g))!.is_active, true);
    // The service-level check itself (defence in depth behind requireTenant).
    await assert.rejects(banService.create({ ip }, u.id, 1, false), (e: any) => e instanceof AppError && e.statusCode === 403);
    assert.equal((await rowsFor(ip)).length, 0);
  });

  lotIt('A2', '24.3 group/agent scope only on a target of the operating tenant', async () => {
    const before = await count();
    assert.equal((await (await bm()).post('/api/bans', { ip: nextIp(), scope: 'agent', scopeId: D.C.id })).status, 404);
    assert.equal((await (await bm()).post('/api/bans', { ip: nextIp(), scope: 'group' })).status, 400);
    assert.equal((await (await dm()).post('/api/bans', { ip: nextIp(), scope: 'agent', scopeId: D.B.id })).status, 404);
    assert.equal((await (await h.adminIn(1)).post('/api/bans', { ip: nextIp(), scope: 'agent', scopeId: D.B.id })).status, 404);
    assert.equal(await count(), before);
    const ip = nextIp();
    const r = await (await bm()).post('/api/bans', { ip, scope: 'agent', scopeId: D.B.id });
    assert.equal(r.status, 201);
    const [row] = await rowsFor(ip);
    assert.equal(row.scope, 'agent');
    assert.equal(row.scope_id, D.B.id);
    assert.equal(row.tenant_id, 2);

    // group scope: owner lookup on monitor_groups (success path, and another tenant's group).
    assert.equal((await (await bm()).post('/api/bans', { ip: nextIp(), scope: 'group', scopeId: G.C })).status, 404);
    const gip = nextIp();
    const rg = await (await bm()).post('/api/bans', { ip: gip, scope: 'group', scopeId: G.B });
    assert.equal(rg.status, 201);
    const [grow] = await rowsFor(gip);
    assert.equal(grow.scope, 'group');
    assert.equal(grow.scope_id, G.B);
    assert.equal(grow.tenant_id, 2);
  });

  // ── validation / protection ────────────────────────────────────────────────

  lotIt('A2', '24.4 validation: floor, protected subnets, strict parsing, expiry', async () => {
    const d = await dm();
    const before = await count();
    const tooBroad = await d.post('/api/bans', { ip: '198.18.24.0', cidrPrefix: 8 });
    assert.equal(tooBroad.status, 400);
    assert.match(String(tooBroad.json?.error), /too broad/i);
    // Amended by D4.1 (owner answer 4): subnets are no longer refused as "not
    // enforced"; these two still are, because they contain PROT.
    for (const body of [{ ip: '198.18.24.3', cidrPrefix: 16 }, { ip: '198.18.24.0/24' }]) {
      const r = await d.post('/api/bans', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json?.error, RESERVED_OR_PROTECTED_MESSAGE);
    }
    assert.equal((await d.post('/api/bans', { ip: '198.18.24.3/24', cidrPrefix: 24 })).status, 400);
    const loop = await d.post('/api/bans', { ip: '::1' });
    assert.equal(loop.status, 400);
    assert.equal(loop.json?.error, RESERVED_OR_PROTECTED_MESSAGE);
    for (const ip of ['host.example', '', 42]) assert.equal((await d.post('/api/bans', { ip })).status, 400, String(ip));
    assert.equal((await d.post('/api/bans', { ip: nextIp(), expiresAt: '2000-01-01T00:00:00Z' })).status, 400);
    assert.equal((await d.post('/api/bans', { ip: nextIp(), expiresAt: 'garbage' })).status, 400);
    assert.equal(await count(), before);

    const host = nextIp();
    const ok = await d.post('/api/bans', { ip: host, cidrPrefix: 32 });
    assert.equal(ok.status, 201);
    assert.equal((await rowsFor(host))[0].cidr_prefix, null);
  });

  lotIt('A2', '24.5 protected addresses: same message as reserved, never echoed', async (t) => {
    const before = await count();
    for (const c of [await bm(), await dm()]) {
      const r = await c.post('/api/bans', { ip: PROT });
      assert.equal(r.status, 400);
      assert.equal(r.json?.error, RESERVED_OR_PROTECTED_MESSAGE);
    }
    const b = await (await bm()).post('/api/bans/bulk-ban', { ips: [PROT] });
    assert.equal(b.status, 200);
    assert.equal(b.json.invalid, 1);
    assert.equal(b.json.invalidEntries[0].reason, RESERVED_OR_PROTECTED_MESSAGE);
    assert.equal(await count(), before);
    const legacy = await insertBan(h.db, { ip: PROT, scope: 'tenant', tenantId: 2, originTenantId: 2 });
    const p = await (await dp()).post(`/api/bans/${legacy}/promote-global`);
    assert.equal(p.status, 400);
    assert.equal((await banRow(h.db, legacy))!.scope, 'tenant');
    await h.db('ip_bans').where({ id: legacy }).update({ is_active: false });

    const x = Object.values(os.networkInterfaces()).flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!x) { t.diagnostic('no non-internal IPv4 interface: interface half skipped'); return; }
    const g = await (await dm()).post('/api/bans', { ip: x });
    assert.equal(g.status, 400);
    assert.equal(g.json?.error, RESERVED_OR_PROTECTED_MESSAGE);
    const l = await (await bm()).post('/api/bans', { ip: x });
    assert.equal(l.status, 201, 'interface addresses are only protected against global bans');
    assert.equal((await rowsFor(x)).filter((r) => r.is_active).length, 1);
  });

  // ── bulk ───────────────────────────────────────────────────────────────────

  lotIt('A2', '24.6 bulk ban: counts, row shape, limits', async () => {
    const i20 = nextIp();
    const r = await (await bm()).post('/api/bans/bulk-ban', { ips: [i20, '10.0.0.0/8', 'x', i20, '127.0.0.1'] });
    assert.equal(r.status, 200);
    assert.equal(r.json.created, 1);
    assert.equal(r.json.skipped, 1);
    assert.equal(r.json.invalid, 3);
    assert.equal(r.json.scope, 'tenant');
    assert.equal(r.json.skippedEntries[0].reason, 'duplicate in request');
    const [row] = await rowsFor(i20);
    assert.equal(row.scope, 'tenant');
    assert.equal(row.tenant_id, 2);
    assert.equal(row.origin_tenant_id, 2);
    assert.equal(row.banned_by_user_id, U.member_b);
    assert.equal(row.ban_type, 'manual');

    const g = nextIp();
    const rg = await (await dm()).post('/api/bans/bulk-ban', { ips: [g] });
    assert.equal(rg.json.scope, 'global');
    assert.equal((await rowsFor(g))[0].scope, 'global');

    const before = await count();
    assert.equal((await (await bm()).post('/api/bans/bulk-ban', { ips: [] })).status, 400);
    assert.equal((await (await bm()).post('/api/bans/bulk-ban', { ips: Array.from({ length: 1001 }, () => 'x') })).status, 400);
    assert.equal((await (await bm()).post('/api/bans/bulk-ban', { ips: 'x' })).status, 400);
    assert.equal(await count(), before);

    const again = await (await bm()).post('/api/bans/bulk-ban', { ips: [i20] });
    assert.equal(again.json.created, 0);
    assert.equal(again.json.skipped, 1);
  });

  lotIt('A2', '24.7 bulk ban contains per-entry failures; MikroTik pushes follow the audience', async () => {
    const [a, b, c] = [nextIp(), nextIp(), nextIp()];
    const savedCreate = banService.create;
    (banService as any).create = function (this: unknown, data: { ip: string }, ...rest: unknown[]) {
      if (data.ip === b) return Promise.reject(new Error('boom'));
      return (savedCreate as any).call(banService, data, ...rest);
    };
    let r;
    try {
      r = await (await bm()).post('/api/bans/bulk-ban', { ips: [a, b, c, 'y'.repeat(200)] });
    } finally {
      (banService as any).create = savedCreate;
    }
    assert.equal(r.status, 200);
    assert.equal(r.json.created, 2);
    assert.equal(r.json.invalid, 2);
    assert.ok(r.json.invalidEntries.some((e: any) => e.ip === b && e.reason === 'internal error'));
    assert.ok(r.json.invalidEntries.every((e: any) => e.ip.length <= 64));
    await waitFor(() => pushed(a).length > 0 && pushed(c).length > 0, 3000);
    assert.deepEqual(pushed(a)[0], { ip: a, action: 'ban', aud: { tenantId: 2 } });
    assert.equal(pushed(b).length, 0);

    const g = nextIp();
    await (await dm()).post('/api/bans/bulk-ban', { ips: [g] });
    await waitFor(() => pushed(g).length > 0, 3000);
    assert.equal(pushed(g)[0].aud, undefined);

    const s = nextIp();
    assert.equal((await (await bm()).post('/api/bans', { ip: s })).status, 201);
    await waitFor(() => pushed(s).length > 0, 3000);
    assert.deepEqual(pushed(s)[0].aud, { tenantId: 2 });
  });

  lotIt('A2', '24.8 concurrent identical bans: one row, one 409', async () => {
    const ip = nextIp();
    const c = await bm();
    const res = await Promise.all([c.post('/api/bans', { ip }), c.post('/api/bans', { ip })]);
    assert.deepEqual(res.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await rowsFor(ip)).filter((r) => r.is_active).length, 1);
  });

  // ── duplicate oracle / whitelist ───────────────────────────────────────────

  lotIt('A2', '24.9 duplicates only against global rows and the caller own scope', async () => {
    const x = nextIp();
    assert.equal((await (await bm()).post('/api/bans', { ip: x })).status, 201);
    assert.equal((await (await cm()).post('/api/bans', { ip: x })).status, 201);
    const again = await (await bm()).post('/api/bans', { ip: x });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'This IP is already banned');

    const y = nextIp();
    const g = await (await dm()).post('/api/bans', { ip: y });
    assert.equal(g.status, 201);
    const dupG = await (await bm()).post('/api/bans', { ip: y });
    assert.equal(dupG.status, 409);
    assert.match(dupG.json.error, /already banned globally/);
    assert.equal((await (await bm()).del(`/api/bans/${g.json.data.id}`)).status, 200);
    const reenable = await (await bm()).post('/api/bans', { ip: y });
    assert.equal(reenable.status, 409);
    assert.match(reenable.json.error, /Re-enable/);
    assert.equal((await rowsFor(y)).length, 1);
  });

  lotIt('A2', '24.10 an applicable whitelist entry refuses the ban', async () => {
    await insertWhitelist(h.db, { ip: '192.0.2.64/27', scope: 'global' });
    const r = await (await bm()).post('/api/bans', { ip: '192.0.2.70' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'This IP is whitelisted');
    await insertWhitelist(h.db, { ip: '192.0.2.5/32', scope: 'tenant', tenantId: 3 });
    assert.equal((await (await bm()).post('/api/bans', { ip: '192.0.2.5' })).status, 201);
    assert.equal((await (await cm()).post('/api/bans', { ip: '192.0.2.5' })).status, 409);
    const rows = await rowsFor('192.0.2.5');
    assert.deepEqual(rows.map((x) => x.tenant_id), [2]);
    assert.equal((await rowsFor('192.0.2.70')).length, 0);
  });

  // ── promote ────────────────────────────────────────────────────────────────

  lotIt('A2', '24.11 promote to global: Default only, guarded, canonical', async () => {
    const bBan = async (ip = nextIp()) => insertBan(h.db, { ip, scope: 'tenant', tenantId: 2, originTenantId: 2 });
    const id = await bBan();
    assert.equal((await (await bm()).post(`/api/bans/${id}/promote-global`)).status, 403);
    assert.equal((await (await h.adminIn(2)).post(`/api/bans/${id}/promote-global`)).status, 403);
    assert.equal((await banRow(h.db, id))!.scope, 'tenant');

    const ok = await (await dp()).post(`/api/bans/${id}/promote-global`);
    assert.equal(ok.status, 200);
    const row = (await banRow(h.db, id))!;
    assert.equal(row.scope, 'global');
    assert.equal(row.tenant_id, null);
    assert.equal(row.origin_tenant_id, 2);
    await waitFor(() => pushed(row.ip).length > 0, 3000);
    assert.equal(pushed(row.ip)[0].aud, undefined);
    assert.equal((await (await dp()).post(`/api/bans/${id}/promote-global`)).status, 409);

    const inactive = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2, isActive: false });
    assert.equal((await (await dp()).post(`/api/bans/${inactive}/promote-global`)).status, 409);
    assert.equal((await (await dp()).post('/api/bans/99999999/promote-global')).status, 404);

    const z = nextIp();
    await insertBan(h.db, { ip: z, scope: 'global', originTenantId: 1 });
    const shadow = await bBan(z);
    assert.equal((await (await dp()).post(`/api/bans/${shadow}/promote-global`)).status, 409);
    assert.equal((await banRow(h.db, shadow))!.scope, 'tenant');

    const wl = nextIp();
    await insertWhitelist(h.db, { ip: `${wl}/32`, scope: 'global' });
    const wlBan = await bBan(wl);
    const wr = await (await dp()).post(`/api/bans/${wlBan}/promote-global`);
    assert.equal(wr.status, 409);
    assert.equal(wr.json.error, 'This IP is whitelisted');
    assert.equal((await banRow(h.db, wlBan))!.scope, 'tenant');

    const m = nextIp();
    const mapped = await bBan(`::ffff:${m}`);
    assert.equal((await (await dp()).post(`/api/bans/${mapped}/promote-global`)).status, 200);
    const mr = (await banRow(h.db, mapped))!;
    assert.equal(mr.ip, m);
    assert.equal(mr.cidr_prefix, null);

    const net = await insertBan(h.db, { ip: '2001:db8:24:1::', cidrPrefix: 64, scope: 'tenant', tenantId: 2, originTenantId: 2 });
    // Amended by D4.1 (owner answer 4): a subnet ban can be promoted, and
    // keeps its prefix.
    const nr = await (await dp()).post(`/api/bans/${net}/promote-global`);
    assert.equal(nr.status, 200, JSON.stringify(nr.json));
    const nrow = (await banRow(h.db, net))!;
    assert.equal(nrow.scope, 'global');
    assert.equal(nrow.cidr_prefix, 64);
  });

  // ── reads / lift / exclude ─────────────────────────────────────────────────

  lotIt('A2', '24.12 read by id: visibility and author', async () => {
    const own = await (await bm()).post('/api/bans', { ip: nextIp() });
    const bId = own.json.data.id as number;
    assert.equal((await (await cm()).get(`/api/bans/${bId}`)).status, 404);
    const g = await (await dm()).post('/api/bans', { ip: nextIp() });
    const cg = await (await cm()).get(`/api/bans/${g.json.data.id}`);
    assert.equal(cg.status, 200);
    assert.equal(cg.json.data.bannedByUserId, null);
    assert.equal(cg.json.data.bannedByUsername, null);
    const mine = await (await bm()).get(`/api/bans/${bId}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.json.data.bannedByUsername, 'member_b');
    assert.equal((await (await dm()).get(`/api/bans/${bId}`)).status, 200);
    assert.equal((await (await bm()).get('/api/bans/abc')).status, 400);
  });

  lotIt('A2', '24.13 lift / exclude of another tenant ban: 404 (not visible)', async () => {
    const id = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2 });
    assert.equal((await (await cm()).del(`/api/bans/${id}`)).status, 404);
    // Adapted for W10-5 (owner default 'decision 5', W10.json W10-5 spec; see
    // audit-2026-09-26/waves/_defaults.txt): the god view exists only on
    // Default, so a platform admin standing on tenant 3 no longer sees tenant
    // 2's local ban (was 403 'This ban belongs to another tenant').
    assert.equal((await (await h.adminIn(3)).del(`/api/bans/${id}`)).status, 404);
    assert.equal((await (await cm()).post(`/api/bans/${id}/exclude`)).status, 404);
    assert.equal((await banRow(h.db, id))!.is_active, true);
    assert.equal((await exclusions(h.db, id)).length, 0);

    const g = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1 });
    assert.equal((await (await cm()).del(`/api/bans/${g}`)).status, 200);
    assert.deepEqual((await exclusions(h.db, g)).map((e) => e.tenant_id), [3]);
    assert.equal((await banRow(h.db, g))!.is_active, true);
    assert.equal((await (await dm()).del(`/api/bans/${id}`)).status, 200);
    assert.equal((await banRow(h.db, id))!.is_active, false);
  });

  lotIt('A2', '24.14 list, stats and pagination', async () => {
    const bLocal = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2 });
    const cLocal = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 3, originTenantId: 3 });
    const g = await (await dm()).post('/api/bans', { ip: nextIp() });
    const gId = g.json.data.id as number;

    const cl = await (await cm()).get('/api/bans?pageSize=1000');
    const cIds = (cl.json.data as Array<{ id: number }>).map((r) => r.id);
    assert.ok(!cIds.includes(bLocal));
    assert.ok(cIds.includes(cLocal));
    const cg = (cl.json.data as Array<{ id: number; bannedByUserId: number | null }>).find((r) => r.id === gId);
    assert.ok(cg);
    assert.equal(cg!.bannedByUserId, null);
    const dl = await (await dm()).get('/api/bans?pageSize=1000');
    const dIds = (dl.json.data as Array<{ id: number }>).map((r) => r.id);
    assert.ok(dIds.includes(bLocal) && dIds.includes(cLocal));
    assert.equal((dl.json.data as Array<{ id: number; bannedByUserId: number | null }>).find((r) => r.id === gId)!.bannedByUserId, U.default_member);

    const activeWhere = (q: any) => q.where('is_active', true).where((w: any) => w.whereNull('expires_at').orWhere('expires_at', '>', h.db.fn.now()));
    const cnt = async (q: any) => Number((await q.count({ c: '*' }))[0].c);
    const cExpected = await cnt(activeWhere(h.db('ip_bans')).where((w: any) => w.where('scope', 'global').orWhere('tenant_id', 3)));
    const allExpected = await cnt(activeWhere(h.db('ip_bans')));
    assert.equal((await (await cm()).get('/api/bans/stats')).json.data.active, cExpected);
    assert.equal((await (await dm()).get('/api/bans/stats')).json.data.active, allExpected);

    const p1 = (await (await dm()).get('/api/bans?page=1')).json.data.map((r: any) => r.id);
    const pNeg = (await (await dm()).get('/api/bans?page=-5')).json.data.map((r: any) => r.id);
    assert.deepEqual(pNeg, p1);

    // Pagination: seed > 1000 C-local rows (visible to Default only), removed afterwards.
    await h.db.raw(`INSERT INTO ip_bans (ip, scope, tenant_id, origin_tenant_id, ban_type, is_active)
      SELECT ('2001:db8:24:2::'::inet + g), 'tenant', 3, 3, 'manual', true FROM generate_series(1, 1005) g`);
    try {
      const d = await dm();
      assert.ok((await d.get('/api/bans?pageSize=abc')).json.data.length <= 25);
      assert.equal((await d.get('/api/bans?pageSize=100000')).json.data.length, 1000);
    } finally {
      await h.db('ip_bans').whereRaw("ip <<= '2001:db8:24:2::/64'::inet").delete();
    }
  });

  // ── other ban paths ────────────────────────────────────────────────────────

  lotIt('A2', '24.15 the engine never auto-bans a reserved or protected address', async () => {
    await withWarnSpy(async (warns) => {
      for (const ip of ['127.0.0.1', PROT]) {
        await insertEvents(h.db, { deviceId: D.B.id, tenantId: 2, ip, service: 'ssh', count: 6 });
      }
      await banEngine.run();
      await banEngine.run();
      assert.equal((await rowsFor('127.0.0.1')).length, 0);
      assert.equal((await rowsFor(PROT)).filter((r) => r.ban_type === 'auto').length, 0);
      const refusals = warns.filter((w) => String(w.msg).includes('refusing to auto-ban'));
      assert.equal(refusals.length, 2, 'one throttled warning per address');
    });
    const ok = nextIp();
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: 2, ip: ok, service: 'ssh', count: 6 });
    await banEngine.run();
    const rows = await rowsFor(ok);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, 'global');
    assert.equal(rows[0].ban_type, 'auto');

    // The same setup on an evaluate-only device: no ban.
    const ev = nextIp();
    await insertEvents(h.db, { deviceId: D.B_EVAL.id, tenantId: 2, ip: ev, service: 'ssh', count: 6 });
    await banEngine.run();
    assert.equal((await rowsFor(ev)).length, 0);
  });

  lotIt('A2', '24.16 external, obli.tools and MikroTik-import paths use the same contract', async () => {
    const master = 1;
    await assert.rejects(
      banService.createFromExternal({ ip: '127.0.0.1', reason: null, sourceApp: 'oblihub', expiresAt: null, masterTenantId: master }),
      (e: any) => e instanceof AppError && e.statusCode === 400,
    );
    await assert.rejects(
      banService.createFromExternal({ ip: PROT, reason: null, sourceApp: 'oblihub', expiresAt: null, masterTenantId: master }),
      (e: any) => e instanceof AppError && e.statusCode === 400 && e.message === RESERVED_OR_PROTECTED_MESSAGE,
    );
    const m = nextIp();
    const ext = await banService.createFromExternal({ ip: `::ffff:${m}`, reason: null, sourceApp: 'oblihub', expiresAt: null, masterTenantId: master });
    assert.equal(ext.isNew, true);
    const [er] = await rowsFor(m);
    assert.equal(er.ip, m);

    const imp = nextIp();
    const impMapped = nextIp();
    await batchImportIPs(['127.0.0.1', '0.0.0.0/4', PROT, imp, `::ffff:${impMapped}`], 'l', {
      deviceId: D.B.id, tenantId: 2, apiHost: 'x', apiPort: 0, apiUseTls: false, apiUsername: 'x', apiPasswordEnc: 'x', importLists: [],
    });
    assert.equal((await rowsFor(imp)).length, 1);
    const im = await rowsFor(impMapped);
    assert.equal(im.length, 1, 'IPv4-mapped entries are stored in canonical form');
    assert.equal(im[0].ip, impMapped);
    assert.equal((await h.db('ip_bans').whereRaw("ip = '0.0.0.0/4'::inet")).length, 0);
    assert.equal((await rowsFor(PROT)).filter((r) => r.ban_type === 'auto').length, 0);

    const [list] = await h.db('remote_blocklists').insert({
      name: 'verify-oblitools', source_type: 'oblitools', url: 'https://oblitools.verify.invalid/api/delta', api_key: 'k', enabled: false, tenant_id: null,
    }).returning('*');
    const good = nextIp();
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ips: {
      '127.0.0.1': { status: 'banned' }, [good]: { status: 'banned' },
    } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      await remoteBlocklistService.syncOblitools(list);
    } finally {
      globalThis.fetch = savedFetch;
    }
    assert.equal((await rowsFor(good)).length, 1);
    assert.equal((await rowsFor('127.0.0.1')).length, 0);
  });

  // ── unsafe legacy rows ─────────────────────────────────────────────────────

  lotIt('A2', '24.17 banSafetyAudit: unsafe rows are logged and never delivered', async () => {
    const legacyOk = nextIp();
    const autoOk = nextIp();
    const u1 = await insertBan(h.db, { ip: '0.0.0.0/1', scope: 'global', banType: 'manual', originTenantId: null });
    const u2 = await insertBan(h.db, { ip: '127.0.0.1', scope: 'global', banType: 'auto', originTenantId: 2 });
    const u3 = await insertBan(h.db, { ip: '10.0.0.0/8', scope: 'global', banType: 'manual', originTenantId: 1 });
    const u4 = await insertBan(h.db, { ip: PROT, scope: 'global', banType: 'manual', originTenantId: 1 });
    const l1 = await insertBan(h.db, { ip: legacyOk, scope: 'global', banType: 'manual', originTenantId: null });
    const a1 = await insertBan(h.db, { ip: autoOk, scope: 'global', banType: 'auto', originTenantId: 2 });

    await withWarnSpy(async (warns) => {
      await refreshUnsafeBanRegistry();
      for (const id of [u1, u2, u3, u4]) assert.equal(isUnsafeBanId(id), true, `id ${id}`);
      assert.equal(isUnsafeBanId(l1), false);
      assert.equal(isUnsafeBanId(a1), false);
      assert.equal(warns.filter((w) => String(w.msg).includes('Refused ban on a protected address')).length, 0,
        'the periodic audit does not log one warning per protected row');
      const audit = warns.filter((w) => String(w.msg).startsWith('BanSafety audit'));
      assert.equal(audit.length, 1);
      const obj = audit[0].obj as { unsafe: Array<{ id: number }>; legacyBulk: number[] };
      const unsafeIds = obj.unsafe.map((u) => u.id);
      for (const id of [u1, u2, u3, u4]) assert.ok(unsafeIds.includes(id), `unsafe id ${id}`);
      for (const id of [l1, u1]) assert.ok(obj.legacyBulk.includes(id), `legacy id ${id}`);
      await refreshUnsafeBanRegistry();
      assert.equal(warns.filter((w) => String(w.msg).startsWith('BanSafety audit')).length, 1, 'same data: nothing new logged');
    });

    const r = await h.push(2, D.B.uuid, { firewallBanned: ['0.0.0.0/1', autoOk] });
    assert.equal(r.status, 200);
    const add = r.json.banList.add as string[];
    const remove = r.json.banList.remove as string[];
    for (const ip of ['0.0.0.0/1', '127.0.0.1', '10.0.0.0/8', PROT, autoOk]) assert.ok(!add.includes(ip), `add ${ip}`);
    assert.ok(add.includes(legacyOk));
    assert.ok(remove.includes('0.0.0.0/1'));

    // MikroTik fullSync: unsafe entries are not added, an existing one is removed.
    const calls: Array<{ action: string; ip: string }> = [];
    const proto = RouterOSClient.prototype as any;
    const saved: Record<string, unknown> = {};
    for (const k of ['connect', 'login', 'banIP', 'unbanIP', 'getBannedIPs', 'close']) saved[k] = proto[k];
    proto.connect = async () => { /* spy */ };
    proto.login = async () => { /* spy */ };
    proto.close = () => { /* spy */ };
    proto.banIP = async (ip: string) => { calls.push({ action: 'ban', ip }); };
    proto.unbanIP = async (ip: string) => { calls.push({ action: 'unban', ip }); };
    proto.getBannedIPs = async () => ['127.0.0.1', legacyOk];
    try {
      const dev = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: 'mt-a2.verify.invalid' });
      const res = await mikrotikBanSync.fullSync(dev.id);
      assert.equal(res.error, undefined);
    } finally {
      for (const [k, fn] of Object.entries(saved)) proto[k] = fn;
    }
    for (const ip of ['0.0.0.0/1', '127.0.0.1', '10.0.0.0/8', PROT]) {
      assert.ok(!calls.some((c) => c.action === 'ban' && c.ip === ip), `fullSync added ${ip}`);
    }
    assert.ok(calls.some((c) => c.action === 'unban' && c.ip === '127.0.0.1'));
    assert.ok(calls.some((c) => c.action === 'ban' && c.ip === autoOk));
  });

  // ── wipe gate (destructive, last) ──────────────────────────────────────────

  lotIt('A2', '24.18 wipes are refused outside Default', async () => {
    await insertEvents(h.db, { deviceId: D.C.id, tenantId: 3, ip: nextIp(), count: 1 });
    const evCount = async () => Number((await h.db('ip_events').count<{ c: string }[]>({ c: '*' }))[0].c);
    const before = await evCount();
    assert.equal((await (await h.adminIn(2)).post('/api/bans/wipe-reputation')).status, 403);
    assert.equal((await (await bm()).post('/api/bans/wipe-reputation')).status, 403);
    assert.equal((await (await bm()).post('/api/bans/wipe-bans')).status, 403);
    const activeCount = async () => Number((await h.db('ip_bans').where('is_active', true).count<{ c: string }[]>({ c: '*' }))[0].c);
    const activeBefore = await activeCount();
    assert.equal((await (await h.adminIn(2)).post('/api/bans/wipe-bans')).status, 403);
    assert.equal(await activeCount(), activeBefore);
    assert.equal(await evCount(), before);
    assert.equal((await (await h.adminIn(1)).post('/api/bans/wipe-reputation')).status, 200);
    assert.equal(await evCount(), 0);
  });
});
