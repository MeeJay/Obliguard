/**
 * 61 — W6-1 RBAC core: tenant roles are permission sets, IPS capability
 * catalogue, read-only viewer role, Obligate role-slug mapping.
 *
 *   61.1 the catalogue is served from shared; admin / user / viewer are seeded
 *        with it (user lacks the destructive / admin capabilities)
 *   61.2 viewer: 403 on ban and whitelist writes, 200 on reads; /auth/me
 *        reports the role and its capabilities
 *   61.3 capability resolution: user lacks agents.delete but holds the
 *        monitor_rw alias; viewer is refused on a monitor_rw route; unknown
 *        role = none; platform admin = all
 *   61.4 SSO: unknown / missing role slug → viewer, known slug stored as-is,
 *        'member' → 'user', platform admin gets a Default 'admin' membership;
 *        app-info advertises the permission sets
 *   61.5 migration 035 backfills 'member' → 'user' and the member keeps bans;
 *        custom set keys are rewritten to the catalogue
 *   61.6 membership writes validate the role against the sets ('member'
 *        accepted as 'user')
 *   61.7 built-in sets cannot be renamed / deleted; custom sets validate their
 *        keys, a slug rename moves memberships, a set in use cannot be deleted
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { U, D, G, TEAMS, OBLIGATE_API_KEY } from '../fixtures';
import { createUser, insertWhitelist, nextIp, VIEWER_B } from '../seed';
import { permissionService } from '../../src/services/permission.service';
import { up as migration035 } from '../../src/db/migrations/035_tenant_roles_permission_sets';
import {
  TENANT_CAPABILITIES,
  TENANT_CAPABILITY_KEYS,
  ALL_CAPABILITIES,
  DEFAULT_PERMISSION_SET_CAPABILITIES,
} from '@obliview/shared';

const USER_LACKS = [
  'agents.delete', 'agents.keys', 'firewall.rules.write', 'users.manage', 'settings',
  'notifications.manage', 'bans.promote', 'bans.wipe', 'audit.read',
];

describe('61 RBAC core (W6-1)', () => {
  let h: Harness;
  before(async () => { h = await startHarness({ obligate: true }); });
  after(async () => { await h.close(); });

  const setCaps = async (slug: string): Promise<string[]> => {
    const row = await h.db('permission_sets').where({ slug }).first('capabilities');
    const caps = typeof row?.capabilities === 'string' ? JSON.parse(row.capabilities) : row?.capabilities;
    return [...(caps ?? [])].sort();
  };
  const roleOf = async (userId: number, tenantId: number): Promise<string | undefined> =>
    (await h.db('user_tenants').where({ user_id: userId, tenant_id: tenantId }).first('role'))?.role;
  const userIdOf = async (obligateUserId: number): Promise<number> =>
    Number((await h.db('sso_foreign_users').where({ foreign_source: 'obligate', foreign_user_id: obligateUserId }).first()).local_user_id);

  lotIt('W6-1', '61.1 catalogue served from shared; protected sets seeded', async () => {
    assert.deepEqual(TENANT_CAPABILITIES.map((c) => c.key).sort(), [...TENANT_CAPABILITY_KEYS].sort());
    assert.equal(TENANT_CAPABILITY_KEYS.length, 25);
    const r = await (await h.as('member_b')).get('/api/permission-sets/capabilities');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.map((c: { key: string }) => c.key), TENANT_CAPABILITIES.map((c) => c.key));
    assert.ok(r.json.data.every((c: { category?: string; labelKey?: string }) => c.category && c.labelKey));

    assert.deepEqual(await setCaps('admin'), [...TENANT_CAPABILITY_KEYS].sort());
    assert.deepEqual(await setCaps('viewer'), ['firewall.rules.read', 'ips.view']);
    const user: string[] = await setCaps('user');
    assert.deepEqual([...user], [...DEFAULT_PERMISSION_SET_CAPABILITIES.user].sort());
    for (const c of USER_LACKS) assert.ok(!user.includes(c), `user must not hold ${c}`);
    for (const c of ['bans.create', 'bans.lift', 'whitelist.write', 'agents.manage', 'agents.update', 'ip.labels']) {
      assert.ok(user.includes(c), `user must hold ${c}`);
    }
    const sets = (await (await h.as('member_b')).get('/api/permission-sets')).json.data as Array<{ slug: string; isProtected: boolean }>;
    for (const slug of ['admin', 'user', 'viewer']) assert.equal(sets.find((s) => s.slug === slug)?.isProtected, true, slug);
  });

  lotIt('W6-1', '61.2 viewer: writes refused, reads allowed, /auth/me reports the role', async () => {
    const v = await h.as(VIEWER_B.username);
    const ip = nextIp();
    assert.equal((await v.post('/api/bans', { ip })).status, 403);
    assert.equal((await v.post('/api/bans/bulk-ban', { ips: [ip] })).status, 403);
    assert.equal((await v.post('/api/whitelist', { ip: `${ip}/32` })).status, 403);
    assert.equal((await v.post('/api/bans/bulk-whitelist', { ips: [ip] })).status, 403);
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [ip])).length, 0);
    assert.equal((await h.db('ip_whitelist').whereRaw('host(ip) = ?', [ip])).length, 0);
    const wlId = await insertWhitelist(h.db, { ip: '192.0.2.61/32', scope: 'global', tenantId: 2, createdBy: U.admin });
    assert.equal((await v.del(`/api/whitelist/${wlId}`)).status, 403);
    assert.ok(await h.db('ip_whitelist').where({ id: wlId }).first());

    assert.equal((await v.get('/api/ip-reputation')).status, 200);
    assert.equal((await v.get('/api/bans')).status, 200);
    assert.equal((await v.get('/api/whitelist')).status, 200);

    const me = await v.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.data.currentTenantId, 2);
    assert.equal(me.json.data.tenantRole, 'viewer');
    assert.deepEqual([...me.json.data.tenantCapabilities].sort(), ['firewall.rules.read', 'ips.view']);
    assert.equal(me.json.data.permissions.tenantRole, 'viewer');
    assert.ok(!me.json.data.permissions.capabilities.includes('bans'));
    const perms = await v.get('/api/auth/permissions');
    assert.equal(perms.json.data.tenantRole, 'viewer');

    // A 'user' member keeps the legacy aliases on /auth/me.
    const mb = (await (await h.as('member_b')).get('/api/auth/me')).json.data;
    assert.equal(mb.tenantRole, 'user');
    for (const a of ALL_CAPABILITIES) assert.ok(mb.permissions.capabilities.includes(a), a);
    assert.ok(!mb.tenantCapabilities.includes('agents.delete'));
  });

  lotIt('W6-1', '61.3 capability resolution and an alias-protected route', async () => {
    const userCaps = await permissionService.getTenantCapabilities(U.member_b, false, 2);
    assert.ok(!userCaps.includes('agents.delete'));
    assert.ok(!userCaps.includes('firewall.rules.write'));
    assert.ok(userCaps.includes('agents.manage'));
    assert.equal(await permissionService.hasCapability(U.member_b, false, 2, 'agents.delete'), false);
    assert.equal(await permissionService.hasCapability(U.member_b, false, 2, 'monitor_rw'), true);
    assert.equal(await permissionService.hasCapability(U.member_b, false, 3, 'ips.view'), false, 'not a member of 3');

    assert.deepEqual(await permissionService.getUserCapabilities(VIEWER_B.id, false, 2), []);
    assert.equal(await permissionService.hasCapability(VIEWER_B.id, false, 2, 'ips.view'), true);
    assert.equal(await permissionService.hasCapability(VIEWER_B.id, false, 2, 'bans'), false);

    // monitor_rw-protected route: the viewer is refused before the controller.
    const v = await h.as(VIEWER_B.username);
    assert.equal((await v.patch(`/api/agent/devices/${D.B.id}`, { name: 'viewer-was-here' })).status, 403);
    assert.equal((await v.del(`/api/agent/devices/${D.B.id}`)).status, 403);
    assert.ok(await h.db('agent_devices').where({ id: D.B.id }).first());

    // Group writes need groups.manage on top of the team RW: a viewer in a
    // team with RW on group B is refused, a 'user' in the same team passes.
    const ctl = await createUser(h.db, { tenants: [2] });
    await h.db('team_memberships').insert([
      { team_id: TEAMS.B_TEAM.id, user_id: VIEWER_B.id },
      { team_id: TEAMS.B_TEAM.id, user_id: ctl.id },
    ]);
    try {
      assert.equal((await v.put(`/api/groups/${G.B}`, { description: 'viewer-was-here' })).status, 403);
      assert.equal((await (await h.login(ctl.username)).put(`/api/groups/${G.B}`, { description: null })).status, 200);
      assert.notEqual((await h.db('monitor_groups').where({ id: G.B }).first('description'))?.description, 'viewer-was-here');
    } finally {
      await h.db('team_memberships').where({ team_id: TEAMS.B_TEAM.id }).whereIn('user_id', [VIEWER_B.id, ctl.id]).del();
    }

    // Unknown role ⇒ nothing; tenant 'admin' role ⇒ everything; platform admin ⇒ everything.
    const ghost = await createUser(h.db, { tenants: [2], tenantRole: 'no-such-set' });
    assert.deepEqual(await permissionService.getTenantCapabilities(ghost.id, false, 2), []);
    assert.equal((await (await h.login(ghost.username)).post('/api/bans', { ip: nextIp() })).status, 403);
    const tadmin = await createUser(h.db, { tenants: [2], tenantRole: 'admin' });
    assert.deepEqual(await permissionService.getTenantCapabilities(tadmin.id, false, 2), [...TENANT_CAPABILITY_KEYS]);
    assert.deepEqual(await permissionService.getTenantCapabilities(U.admin, true, null), [...TENANT_CAPABILITY_KEYS]);
  });

  lotIt('W6-1', '61.4 SSO role slugs: unknown → viewer, known kept, member → user', async () => {
    await h.db('permission_sets').insert({ name: 'Ops', slug: 'ops', capabilities: JSON.stringify(['ips.view', 'bans.create']) });
    const r = await h.ssoLogin({
      obligateUserId: 9611, username: 'rbac1', role: 'user',
      tenants: [{ slug: 'tenant-b', role: 'superhero' }, { slug: 'tenant-c', role: 'ops' }, { slug: 'default', role: 'member' }],
    });
    assert.equal(r.callback.status, 200);
    const uid = await userIdOf(9611);
    assert.equal(await roleOf(uid, 2), 'viewer');
    assert.equal(await roleOf(uid, 3), 'ops');
    assert.equal(await roleOf(uid, 1), 'user');

    // A missing role fails closed too; a later assertion re-roles the membership.
    await h.ssoLogin({ obligateUserId: 9611, username: 'rbac1', role: 'user', tenants: [{ slug: 'tenant-b' }] });
    assert.equal(await roleOf(uid, 2), 'viewer');
    await h.ssoLogin({ obligateUserId: 9611, username: 'rbac1', role: 'user', tenants: [{ slug: 'tenant-b', role: 'admin' }] });
    assert.equal(await roleOf(uid, 2), 'admin');

    // Platform admin: Default 'admin' membership.
    await h.ssoLogin({ obligateUserId: 9612, username: 'rbac2', role: 'admin', tenants: [{ slug: 'tenant-b', role: 'viewer' }] });
    const aid = await userIdOf(9612);
    assert.equal(await roleOf(aid, 1), 'admin');
    assert.equal(await roleOf(aid, 2), 'viewer');

    // Demotion: the Default membership the admin role granted goes, even
    // when memberships are not pruned (OBLIGATE_PRUNE_MEMBERSHIPS=false).
    const prevPrune = process.env.OBLIGATE_PRUNE_MEMBERSHIPS;
    process.env.OBLIGATE_PRUNE_MEMBERSHIPS = 'false';
    try {
      await h.ssoLogin({ obligateUserId: 9613, username: 'rbac3', role: 'admin', tenants: [{ slug: 'tenant-b', role: 'user' }] });
      const did = await userIdOf(9613);
      assert.equal(await roleOf(did, 1), 'admin');
      await h.ssoLogin({ obligateUserId: 9613, username: 'rbac3', role: 'user', tenants: [{ slug: 'tenant-b', role: 'user' }] });
      assert.equal(await roleOf(did, 1), undefined, 'demoted: Default membership removed');
      assert.equal(await roleOf(did, 2), 'user');
    } finally {
      if (prevPrune === undefined) delete process.env.OBLIGATE_PRUNE_MEMBERSHIPS;
      else process.env.OBLIGATE_PRUNE_MEMBERSHIPS = prevPrune;
    }

    const info = await h.anon().get('/api/auth/app-info', { headers: { authorization: `Bearer ${OBLIGATE_API_KEY}` } });
    assert.equal(info.status, 200);
    const slugs = (info.json.data.permissionSets as Array<{ slug: string; name: string }>).map((p) => p.slug);
    for (const s of ['admin', 'user', 'viewer', 'ops']) assert.ok(slugs.includes(s), s);
  });

  lotIt('W6-1', '61.5 migration 035: member backfilled to user keeps bans; custom keys rewritten', async () => {
    const legacy = await createUser(h.db, { tenants: [2], tenantRole: 'member' });
    // Read as 'user' even before the backfill.
    assert.equal(await permissionService.hasCapability(legacy.id, false, 2, 'bans.create'), true);
    const [custom] = await h.db('permission_sets')
      .insert({ name: 'Legacy', slug: 'legacy-61', capabilities: JSON.stringify(['monitoring', 'bans', 'service.templates', 'junk', 'ip.labels']) })
      .returning('id') as Array<{ id: number }>;

    await migration035(h.db);
    await migration035(h.db); // idempotent

    assert.equal(await roleOf(legacy.id, 2), 'user');
    assert.equal((await h.db('user_tenants').where({ role: 'member' })).length, 0);
    const c = await h.db('permission_sets').where({ id: custom.id }).first('capabilities');
    const caps = typeof c.capabilities === 'string' ? JSON.parse(c.capabilities) : c.capabilities;
    assert.deepEqual(caps, ['ips.view', 'bans.create', 'bans.lift', 'ip.labels', 'templates.write', 'firewall.rules.read']);
    const col = await h.db.raw(`SELECT character_maximum_length AS n, column_default AS d FROM information_schema.columns
      WHERE table_name = 'user_tenants' AND column_name = 'role'`);
    assert.equal(Number(col.rows[0].n), 64);
    assert.match(String(col.rows[0].d), /'user'/);

    const ip = nextIp();
    const res = await (await h.login(legacy.username)).post('/api/bans', { ip });
    assert.equal(res.status, 201);
    assert.equal((await h.db('ip_bans').whereRaw('host(ip) = ?', [ip])).length, 1);
  });

  lotIt('W6-1', '61.6 membership writes validate the role', async () => {
    const admin = await h.adminIn(1);
    const u = await createUser(h.db, { tenants: [] });
    assert.equal((await admin.post('/api/tenants/2/members', { userId: u.id, role: 'nope' })).status, 400);
    assert.equal(await roleOf(u.id, 2), undefined);
    assert.equal((await admin.post('/api/tenants/2/members', { userId: u.id, role: 'member' })).status, 200);
    assert.equal(await roleOf(u.id, 2), 'user');
    assert.equal((await admin.post('/api/tenants/3/members', { userId: u.id })).status, 200);
    assert.equal(await roleOf(u.id, 3), 'user');
    assert.equal((await admin.put(`/api/tenants/2/members/${u.id}`, { role: 'viewer' })).status, 200);
    assert.equal(await roleOf(u.id, 2), 'viewer');
    assert.equal((await admin.put(`/api/tenants/2/members/${u.id}`, { role: 'bogus' })).status, 400);
    assert.equal(await roleOf(u.id, 2), 'viewer');
    const members = (await admin.get('/api/tenants/2/members')).json.data as Array<{ id: number; tenantRole: string }>;
    assert.equal(members.find((m) => m.id === u.id)?.tenantRole, 'viewer');

    const put = (assignments: unknown) => admin.put(`/api/users/${u.id}/tenants`, { assignments });
    assert.equal((await put([{ tenantId: 2, role: 'bogus' }])).status, 400);
    assert.equal(await roleOf(u.id, 2), 'viewer', 'a refused write changes nothing');
    assert.equal((await put([{ tenantId: 2, role: 'viewer' }, { tenantId: 3, role: 'member' }])).status, 200);
    assert.equal(await roleOf(u.id, 2), 'viewer');
    assert.equal(await roleOf(u.id, 3), 'user');
    const assignments = (await admin.get(`/api/users/${u.id}/tenants`)).json.data as Array<{ tenantId: number; role: string }>;
    assert.equal(assignments.find((a) => a.tenantId === 3)?.role, 'user');
  });

  lotIt('W6-1', '61.7 permission set protection and validation', async () => {
    const admin = await h.adminIn(1);
    const sets = (await admin.get('/api/permission-sets')).json.data as Array<{ id: number; slug: string }>;
    const id = (slug: string) => sets.find((s) => s.slug === slug)!.id;

    assert.equal((await admin.put(`/api/permission-sets/${id('admin')}`, { name: 'Boss' })).status, 400);
    assert.equal((await admin.put(`/api/permission-sets/${id('viewer')}`, { slug: 'readers' })).status, 400);
    assert.equal((await admin.put(`/api/permission-sets/${id('admin')}`, { capabilities: ['ips.view'] })).status, 400);
    for (const slug of ['admin', 'user', 'viewer']) {
      assert.equal((await admin.del(`/api/permission-sets/${id(slug)}`)).status, 400, slug);
    }
    // The content of user / viewer stays editable (owner decision 12).
    const vr = await admin.put(`/api/permission-sets/${id('viewer')}`, { capabilities: ['ips.view', 'firewall.rules.read', 'ip.labels'] });
    assert.equal(vr.status, 200);
    assert.ok(await permissionService.hasCapability(VIEWER_B.id, false, 2, 'ip.labels'));
    await admin.put(`/api/permission-sets/${id('viewer')}`, { capabilities: ['ips.view', 'firewall.rules.read'] });

    assert.equal((await admin.post('/api/permission-sets', { name: 'X', slug: 'x-61', capabilities: ['nope'] })).status, 400);
    assert.equal((await admin.post('/api/permission-sets', { name: 'X', slug: 'member', capabilities: [] })).status, 409);
    assert.equal((await admin.post('/api/permission-sets', { name: 'X', slug: 'Bad Slug', capabilities: [] })).status, 400);
    const created = await admin.post('/api/permission-sets', { name: 'Banners', slug: 'banners-61', capabilities: ['bans', 'ips.view'] });
    assert.equal(created.status, 201);
    assert.deepEqual(created.json.data.capabilities, ['ips.view', 'bans.create', 'bans.lift']);
    assert.equal((await admin.post('/api/permission-sets', { name: 'Dup', slug: 'banners-61', capabilities: [] })).status, 409);
    assert.equal((await (await h.as('member_b')).post('/api/permission-sets', { name: 'Y', slug: 'y-61', capabilities: [] })).status, 403);

    const u = await createUser(h.db, { tenants: [2], tenantRole: 'banners-61' });
    assert.equal(await permissionService.hasCapability(u.id, false, 2, 'bans'), true);
    assert.equal(await permissionService.hasCapability(u.id, false, 2, 'whitelist'), false);
    assert.equal((await admin.del(`/api/permission-sets/${created.json.data.id}`)).status, 409);

    const renamed = await admin.put(`/api/permission-sets/${created.json.data.id}`, { slug: 'banners-61b' });
    assert.equal(renamed.status, 200);
    assert.equal(await roleOf(u.id, 2), 'banners-61b');
    assert.equal(await permissionService.hasCapability(u.id, false, 2, 'bans.create'), true);

    await h.db('user_tenants').where({ user_id: u.id }).del();
    assert.equal((await admin.del(`/api/permission-sets/${created.json.data.id}`)).status, 200);
  });
});
