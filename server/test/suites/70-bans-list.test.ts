/**
 * 70 — W8-2 Bans / Whitelist tabs (driven by ip_bans / ip_whitelist):
 *
 *   70.1 GET /bans?state= partitions the rows (active / expired / lifted)
 *   70.2 rows carry names instead of ids (createdByUsername, scopeName,
 *        tenantName) and the author stays hidden from unrelated tenants
 *   70.3 POST /bans/bulk-lift from tenant 2: exclusions for global bans, its
 *        own bans deactivated, foreign bans refused
 *   70.4 POST /bans/bulk-lift from Default: authoritative deactivation
 *   70.5 search / scope / sort / god-view tenant filter
 *   70.6 team-restricted users only see the group/agent bans of their agents
 *   70.7 whitelist rows carry scopeName / createdByUsername; bulk delete keeps
 *        global entries locked outside Default
 *   70.8 client contract: self-contained tabs (prefixed URL state, shared
 *        IP drawer, kit table), /bans and /whitelist redirect to the tabs
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import { D, G, U } from '../fixtures';
import { insertBan, banRow, exclusions, insertWhitelist, nextIp, createUser, createGroup, createDevice } from '../seed';
import { whitelistService } from '../../src/services/whitelist.service';
import { TENANT_CAPABILITY_KEYS } from '@obliview/shared';

interface BanItem {
  id: number;
  ip: string;
  scope: string;
  state: string;
  tenantId: number | null;
  createdByUsername: string | null;
  scopeName: string | null;
  tenantName: string | null;
  isExcludedByTenant: boolean;
  liftAction: string | null;
  liftedAt: string | null;
}

const OPERATOR = 'w82-operator';

describe('70 bans / whitelist tabs (W8-2)', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
    await h.db('permission_sets').insert({ name: 'W8-2 operator', slug: OPERATOR, capabilities: JSON.stringify([...TENANT_CAPABILITY_KEYS]) });
  });
  after(async () => { await h.close(); });

  async function list(c: Client, query: string): Promise<BanItem[]> {
    const r = await c.get(`/api/bans?pageSize=1000&${query}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(typeof r.json.total, 'number');
    return r.json.data as BanItem[];
  }
  const ids = (rows: BanItem[]) => rows.map((r) => r.id);
  const past = (ms: number) => new Date(Date.now() - ms);

  lotIt('W8-2', '70.1 state=active|expired|lifted partitions the ban rows', async () => {
    const active = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1 });
    const lifted = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1, isActive: false });
    await h.db('ip_bans').where({ id: lifted }).update({ lifted_at: past(60_000) });
    // Expired, deactivated by the expiry job (lifted_at after expires_at).
    const expiredDone = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1, isActive: false, expiresAt: past(3_600_000) });
    await h.db('ip_bans').where({ id: expiredDone }).update({ lifted_at: past(3_000_000) });
    // Expired, still flagged active (the job has not run yet).
    const expiredPending = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1, expiresAt: past(1_000) });
    // Lifted before its expiry.
    const liftedEarly = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1, isActive: false, expiresAt: past(1_000) });
    await h.db('ip_bans').where({ id: liftedEarly }).update({ lifted_at: past(3_600_000) });

    const dm = await h.as('default_member');
    const a = ids(await list(dm, 'state=active'));
    const e = ids(await list(dm, 'state=expired'));
    const l = await list(dm, 'state=lifted');
    assert.ok(a.includes(active), 'active listed');
    for (const id of [lifted, expiredDone, expiredPending, liftedEarly]) assert.ok(!a.includes(id), `${id} not active`);
    assert.ok(e.includes(expiredDone) && e.includes(expiredPending), 'expired rows listed');
    assert.ok(!e.includes(lifted) && !e.includes(liftedEarly) && !e.includes(active));
    assert.ok(ids(l).includes(lifted) && ids(l).includes(liftedEarly), 'lifted rows listed');
    assert.ok(!ids(l).includes(expiredDone) && !ids(l).includes(active));
    const row = l.find((r) => r.id === lifted)!;
    assert.equal(row.state, 'lifted');
    assert.ok(row.liftedAt, 'liftedAt exposed');
    assert.equal(row.liftAction, null, 'a lifted row offers no Lift');

    // Default (no state) stays the active list; the legacy active=false = all states.
    assert.ok(!ids(await list(dm, '')).includes(lifted));
    const all = ids(await list(dm, 'active=false'));
    assert.ok(all.includes(lifted) && all.includes(active) && all.includes(expiredDone));
    assert.equal((await dm.get('/api/bans?state=bogus')).status, 400);
  });

  lotIt('W8-2', '70.2 createdByUsername / scopeName / tenantName; the author stays hidden from other tenants', async () => {
    const ip = nextIp();
    const dm = await h.as('default_member');
    const created = await dm.post('/api/bans', { ip });
    assert.equal(created.status, 201, created.text);
    const id = created.json.data.id as number;

    const mine = (await list(dm, `search=${ip}`)).find((r) => r.id === id)!;
    assert.equal(mine.createdByUsername, 'default_member');
    assert.equal(mine.scope, 'global');
    assert.equal(mine.liftAction, 'deactivate');

    // Tenant 2 sees the global ban, not who created it; its Lift is an exclusion.
    const other = (await list(await h.as('member_b'), `search=${ip}`)).find((r) => r.id === id)!;
    assert.ok(other, 'global ban visible to tenant 2');
    assert.equal(other.createdByUsername, null);
    assert.equal(other.liftAction, 'exclude');

    // Group / agent / tenant bans are named.
    const g = await insertBan(h.db, { ip: nextIp(), scope: 'group', scopeId: G.B, tenantId: 2, originTenantId: 2 });
    const a = await insertBan(h.db, { ip: nextIp(), scope: 'agent', scopeId: D.B.id, tenantId: 2, originTenantId: 2 });
    const t = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2 });
    await h.db('ip_bans').where({ id: t }).update({ banned_by_user_id: U.member_b });
    const groupName = (await h.db('monitor_groups').where({ id: G.B }).first('name')).name as string;
    const tenantName = (await h.db('tenants').where({ id: 2 }).first('name')).name as string;
    const rows = await list(await h.as('member_b'), 'state=active&pageSize=1000');
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(g)?.scopeName, groupName);
    assert.equal(byId.get(a)?.scopeName, D.B.hostname);
    assert.equal(byId.get(t)?.scopeName, tenantName);
    assert.equal(byId.get(t)?.tenantName, tenantName);
    assert.equal(byId.get(t)?.createdByUsername, 'member_b');
    assert.equal(byId.get(t)?.liftAction, 'deactivate');
  });

  lotIt('W8-2', '70.3 bulk-lift from tenant 2: exclusions for global bans, own bans deactivated, foreign refused', async () => {
    const global1 = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1 });
    const global2 = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 3 });
    const own = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2 });
    const foreign = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 3, originTenantId: 3 });
    const inactive = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 1, isActive: false });

    const mb = await h.as('member_b');
    const r = await mb.post('/api/bans/bulk-lift', { ids: [global1, global2, own, foreign, inactive, 999999] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.excluded, 2);
    assert.equal(r.json.lifted, 1);
    assert.equal(r.json.skipped, 1, 'the inactive row is skipped');
    assert.equal(r.json.refused, 2, 'foreign and unknown rows are refused');

    // Global bans stay active everywhere else: only tenant 2 opted out.
    for (const id of [global1, global2]) {
      assert.equal((await banRow(h.db, id))!.is_active, true);
      assert.deepEqual((await exclusions(h.db, id)).map((e) => e.tenant_id), [2]);
    }
    assert.equal((await banRow(h.db, own))!.is_active, false);
    assert.equal((await banRow(h.db, foreign))!.is_active, true);
    assert.equal((await exclusions(h.db, foreign)).length, 0);

    // Idempotent: a second bulk Lift of the excluded bans is a no-op.
    const again = await mb.post('/api/bans/bulk-lift', { ids: [global1] });
    assert.equal(again.status, 200);
    assert.equal(again.json.excluded, 0);
    assert.equal(again.json.skipped, 1);
    assert.equal((await exclusions(h.db, global1)).length, 1);

    // The excluded flag shows in the list.
    const row = (await list(mb, 'state=active')).find((x) => x.id === global1)!;
    assert.equal(row.isExcludedByTenant, true);

    // Validation.
    assert.equal((await mb.post('/api/bans/bulk-lift', { ids: [] })).status, 400);
    assert.equal((await mb.post('/api/bans/bulk-lift', { ids: ['x'] })).status, 400);
    assert.equal((await mb.post('/api/bans/bulk-lift', { ids: Array.from({ length: 1001 }, (_, i) => i + 1) })).status, 400);
  });

  lotIt('W8-2', '70.4 bulk-lift from Default deactivates (global and tenant bans), no exclusion', async () => {
    const global1 = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: 2 });
    const tenant3 = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 3, originTenantId: 3 });
    const r = await (await h.as('default_member')).post('/api/bans/bulk-lift', { ids: [global1, tenant3] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.lifted, 2);
    assert.equal(r.json.excluded, 0);
    for (const id of [global1, tenant3]) {
      const row = await h.db('ip_bans').where({ id }).first('is_active', 'lifted_at');
      assert.equal(row.is_active, false);
      assert.ok(row.lifted_at, 'lifted_at stamped');
      assert.equal((await exclusions(h.db, id)).length, 0);
    }
    // A member without the capability is refused by the route.
    const viewer = await createUser(h.db, { tenants: [2], tenantRole: 'viewer' });
    const vc = await h.login(viewer.username);
    assert.equal((await vc.post('/api/bans/bulk-lift', { ids: [global1] })).status, 403);
  });

  lotIt('W8-2', '70.5 search, scope filter, sort and the god-view tenant filter', async () => {
    const ipA = nextIp();
    const ipB = nextIp();
    const a = await insertBan(h.db, { ip: ipA, scope: 'tenant', tenantId: 2, originTenantId: 2 });
    const b = await insertBan(h.db, { ip: ipB, scope: 'tenant', tenantId: 3, originTenantId: 3 });
    await h.db('ip_bans').where({ id: a }).update({ reason: 'w82-needle reason' });
    const dm = await h.as('default_member');

    assert.deepEqual(ids(await list(dm, `search=${ipA}`)), [a]);
    assert.deepEqual(ids(await list(dm, 'search=w82-needle')), [a]);
    const scoped = await list(dm, 'scope=tenant');
    assert.ok(scoped.every((r) => r.scope === 'tenant'));
    assert.equal((await dm.get('/api/bans?scope=nope')).status, 400);

    const t3 = ids(await list(dm, 'tenants=3&scope=tenant'));
    assert.ok(t3.includes(b) && !t3.includes(a), 'god view narrowed to tenant 3');
    // Outside Default the tenant filter is ignored (a tenant only sees its own rows).
    const mbRows = ids(await list(await h.as('member_b'), 'tenants=3&scope=tenant'));
    assert.ok(mbRows.includes(a) && !mbRows.includes(b));

    const asc = await list(dm, 'sortBy=ip&sortOrder=asc&scope=tenant');
    const sorted = [...asc].sort((x, y) => {
      const n = (s: string) => s.split('.').map(Number).reduce((acc, o) => acc * 256 + o, 0);
      return n(x.ip) - n(y.ip);
    });
    assert.deepEqual(ids(asc), ids(sorted), 'sorted by ip ascending');
  });

  lotIt('W8-2', '70.6 a team-restricted user only sees the group/agent bans of its agents', async () => {
    const g = await createGroup(h.db, { tenantId: 2 });
    const other = await createGroup(h.db, { tenantId: 2 });
    const inG = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: g });
    const inOther = await createDevice(h.db, { tenantId: 2, keyId: 2, groupId: other });
    const u = await createUser(h.db, { tenants: [2], tenantRole: OPERATOR });
    const [t] = await h.db('user_teams').insert({ name: `t70-${Date.now()}`, tenant_id: 2, can_create: false }).returning('id') as Array<{ id: number }>;
    await h.db('team_memberships').insert({ team_id: t.id, user_id: u.id });
    await h.db('team_permissions').insert({ team_id: t.id, scope: 'group', scope_id: g, level: 'rw' });

    const banG = await insertBan(h.db, { ip: nextIp(), scope: 'group', scopeId: g, tenantId: 2, originTenantId: 2 });
    const banOther = await insertBan(h.db, { ip: nextIp(), scope: 'group', scopeId: other, tenantId: 2, originTenantId: 2 });
    const banAgentIn = await insertBan(h.db, { ip: nextIp(), scope: 'agent', scopeId: inG.id, tenantId: 2, originTenantId: 2 });
    const banAgentOut = await insertBan(h.db, { ip: nextIp(), scope: 'agent', scopeId: inOther.id, tenantId: 2, originTenantId: 2 });
    const banTenant = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', tenantId: 2, originTenantId: 2 });

    const seen = ids(await list(await h.login(u.username), 'state=active'));
    assert.ok(seen.includes(banG) && seen.includes(banAgentIn) && seen.includes(banTenant));
    assert.ok(!seen.includes(banOther) && !seen.includes(banAgentOut), 'rows of ungranted agents hidden');

    // Lifts follow the same team scope: rows of ungranted agents do not exist for the user.
    const uc = await h.login(u.username);
    assert.equal((await uc.del(`/api/bans/${banAgentOut}`)).status, 404, 'single Lift outside the team scope');
    assert.equal((await banRow(h.db, banAgentOut))?.is_active, true);
    const bl = await uc.post('/api/bans/bulk-lift', { ids: [banOther, banAgentIn] });
    assert.equal(bl.status, 200, bl.text);
    assert.equal(bl.json.lifted, 1);
    assert.equal(bl.json.refused, 1);
    assert.equal((await banRow(h.db, banOther))?.is_active, true, 'ungranted group ban untouched');
    assert.equal((await banRow(h.db, banAgentIn))?.is_active, false, 'granted agent ban lifted');

    // A user without team grants keeps the whole tenant.
    const all = ids(await list(await h.as('member_b'), 'state=active'));
    assert.ok(all.includes(banOther) && all.includes(banAgentOut));
  });

  lotIt('W8-2', '70.7 whitelist rows are named; bulk delete keeps global entries locked outside Default', async () => {
    const gl = await insertWhitelist(h.db, { ip: '192.0.2.0/28', scope: 'global', createdBy: U.default_member });
    const own = await insertWhitelist(h.db, { ip: '192.0.2.16/28', scope: 'group', scopeId: G.B, tenantId: 2, createdBy: U.member_b });
    const foreign = await insertWhitelist(h.db, { ip: '192.0.2.32/28', scope: 'tenant', tenantId: 3 });

    const r = await (await h.as('member_b')).get('/api/whitelist?search=192.0.2.20');
    assert.equal(r.status, 200, r.text);
    const row = (r.json.data as Array<{ id: number; scopeName: string | null; createdByUsername: string | null; canDelete: boolean }>)
      .find((e) => e.id === own);
    assert.ok(row, 'the range containing the searched address is found');
    const groupName = (await h.db('monitor_groups').where({ id: G.B }).first('name')).name as string;
    assert.equal(row!.scopeName, groupName);
    assert.equal(row!.createdByUsername, 'member_b');
    assert.equal(row!.canDelete, true);

    const res2 = await whitelistService.bulkDelete([gl, own, foreign, 999999], 2);
    assert.equal(res2.deleted, 1);
    assert.equal(res2.forbidden, 1, 'global entry locked outside Default');
    assert.equal(res2.notFound, 2, 'foreign entry invisible, unknown id');
    assert.ok(await h.db('ip_whitelist').where({ id: gl }).first());
    assert.ok(await h.db('ip_whitelist').where({ id: foreign }).first());
    assert.equal(await h.db('ip_whitelist').where({ id: own }).first(), undefined);

    const res1 = await whitelistService.bulkDelete([gl], 1);
    assert.equal(res1.deleted, 1, 'Default removes a global entry');
  });

  lotIt('W8-2', '70.8 client: self-contained tabs with prefixed URL state, the drawer contract and the legacy redirects', () => {
    const REPO = path.resolve(__dirname, '..', '..', '..');
    const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
    const tabs: Array<[string, string]> = [['BansTab', 'b_'], ['WhitelistTab', 'w_'], ['RemoteTab', 'r_']];
    for (const [name, prefix] of tabs) {
      const src = read(`client/src/pages/ipReputation/${name}.tsx`);
      assert.match(src, new RegExp(`export default function ${name}\\(\\)`), `${name}: default export, no props`);
      assert.match(src, new RegExp(`usePrefixedParams\\('${prefix}'\\)`), `${name}: URL state under ${prefix}`);
      assert.match(src, /const \{ open: openIp \} = useIpDrawer\(\)/, `${name}: IP cells open the shared drawer`);
      for (const kit of ['TableScroll', 'Pagination', 'EmptyState', 'ActionMenu']) {
        assert.match(src, new RegExp(`<${kit}\\b`), `${name} renders ${kit}`);
      }
      assert.match(src, /useRowSelection\(/, `${name}: explicit selection`);
      assert.ok(!/window\.(confirm|prompt)\(/.test(src), `${name}: no native dialogs`);
    }
    const bans = read('client/src/pages/ipReputation/BansTab.tsx');
    assert.match(bans, /bansApi\.bulkLift\(/, 'bulk Lift through POST /bans/bulk-lift');
    assert.match(bans, /<SortableTh field="(createdAt|expiresAt)"/);
    assert.match(read('client/src/pages/ipReputation/WhitelistTab.tsx'), /whitelistApi\.bulkDelete\(/);
    const app = read('client/src/App.tsx');
    assert.match(app, /path="\/bans" element=\{<Navigate to="\/ip-reputation\?tab=bans" replace \/>\}/);
    assert.match(app, /path="\/whitelist" element=\{<Navigate to="\/ip-reputation\?tab=whitelist" replace \/>\}/);
  });
});
