/**
 * 84 — W10 integration (W10-6): the followups wired across the W10 lots.
 *   84.1 /agents <-> /manage/agents split: Sidebar 'Agents' -> /agents (every
 *        member), 'Agent config' admin entry -> /manage/agents; the dashboard
 *        agent links target /agents (open to all, ?status= read as chips)
 *   84.2 GroupDetailPage embeds the shared AgentTable (no local fallback)
 *   84.3 key CRUD lives in agentKeys.controller / agentKey.service only; the
 *        listed key shape (AgentKeyView) is shared by client and server
 *   84.4 approval: no groupId keeps the registration group; an approver
 *        without agents.manage approves without choosing a group
 *   84.5 ?tenants= reaches ip-reputation, service templates and rate-limit
 *        policies over HTTP (Default narrows; ignored elsewhere); ban origin
 *        attribution follows the god view, not the platform role
 *   84.6 group writes by a team member need RW on each group (reorder,
 *        agent-config)
 *   84.7 the agent detail page offers "Release API key binding" again
 *   84.8 every literal i18n key of the W10 pages exists in en and fr with
 *        the same {{placeholders}}
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { D } from '../fixtures';
import { createDevice, createGroup, createKey, createUser, insertEvents, nextIp } from '../seed';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const host = (ip: unknown): string => String(ip ?? '').split('/')[0];

type Tree = Record<string, unknown>;
const locale = (lang: string): Tree =>
  JSON.parse(read(`client/src/i18n/locales/${lang}/translation.json`).replace(/^﻿/, '')) as Tree;

function lookup(tree: Tree, key: string): unknown {
  let cur: unknown = tree;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Tree)[part];
  }
  return cur;
}

/** Literal keys passed to t('…') (comments stripped). */
function literalKeys(src: string): string[] {
  const c = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const keys = new Set<string>();
  for (const m of c.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  return [...keys];
}

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');

const dirFiles = (dir: string) => fs.readdirSync(path.join(REPO, dir))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => `${dir}/${f}`);

/** The client files built or rebuilt by W10. */
const W10_CLIENT_FILES = [
  ...dirFiles('client/src/components/agents'),
  'client/src/pages/AgentListPage.tsx',
  'client/src/pages/AdminAgentPage.tsx',
  'client/src/pages/AgentDetailPage.tsx',
  ...dirFiles('client/src/pages/agentDetail'),
  'client/src/pages/GroupDetailPage.tsx',
  'client/src/pages/GroupEditPage.tsx',
  'client/src/components/layout/Sidebar.tsx',
  'client/src/components/layout/GlobalAddAgentModal.tsx',
  'client/src/pages/DashboardPage.tsx',
];

/** Keys built at runtime (`agentUpdate.policy.${p}`, `networkLimiting.types.${t}`). */
const DYNAMIC_KEYS = [
  ...['auto', 'manual', 'off', 'inherit'].map((p) => `agentUpdate.policy.${p}`),
  ...['connection', 'rate', 'volume'].map((t) => `networkLimiting.types.${t}`),
];

function navPaths(src: string, list: string): string[] {
  const start = src.indexOf(`const ${list}: NavItem[] = [`);
  assert.ok(start >= 0, `${list} declared`);
  const end = src.indexOf('].filter(item => item.visible);', start);
  assert.ok(end > start, `${list} is filtered by its visibility predicates`);
  return [...src.slice(start, end).matchAll(/path: '([^']+)'/g)].map((m) => m[1]);
}

describe('84 W10 integration (W10-6)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  lotIt('W10-6', '84.1 /agents is the fleet list, /manage/agents the Agent config hub', () => {
    const sidebar = code('client/src/components/layout/Sidebar.tsx');
    assert.ok(navPaths(sidebar, 'navItems').includes('/agents'));
    assert.ok(!navPaths(sidebar, 'navItems').includes('/manage/agents'));
    assert.ok(navPaths(sidebar, 'adminNavItems').includes('/manage/agents'));
    assert.match(sidebar, /t\('nav\.agentConfig', 'Agent config'\), path: '\/manage\/agents'[^\n]*visible: canSeeAgentAdmin/);

    const app = code('client/src/App.tsx');
    assert.match(app, /<Route path="\/agents" element=\{<AgentListPage \/>\} \/>/);
    assert.match(app, /<Route path="\/manage\/agents" element=\{<AdminAgentPage \/>\} \/>/);

    // The connected-agents hero sends every member to the fleet list; the
    // update chips keep opening the hub (Update policy tab: Retry / Update now).
    const dash = code('client/src/pages/DashboardPage.tsx');
    assert.match(dash, /to=\{agentsOffline > 0 \? '\/agents\?status=offline' : '\/agents'\}/);
    assert.doesNotMatch(dash, /\/manage\/agents\?status=/, 'no fleet filter deep link to the admin hub');
    assert.ok(read('client/src/api/agent.api.ts').includes("'offline'"), 'the offline chip is known to the client');
  });

  lotIt('W10-6', '84.2 GroupDetailPage embeds the shared AgentTable', () => {
    const page = code('client/src/pages/GroupDetailPage.tsx');
    assert.match(page, /import \{ AgentTable \} from '@\/components\/agents\/AgentTable';/);
    assert.match(page, /<AgentTable groupId=\{groupId\} recursive embedded \/>/);
    const table = code('client/src/components/agents/AgentTable.tsx');
    assert.match(table, /export function AgentTable\b/);
    for (const prop of ['groupId', 'recursive', 'embedded']) {
      assert.match(table, new RegExp(`\\b${prop}\\?:`), `AgentTable prop ${prop}`);
    }
  });

  lotIt('W10-6', '84.3 key CRUD only in agentKeys.controller; shared AgentKeyView', () => {
    const ctrl = code('server/src/controllers/agent.controller.ts');
    assert.doesNotMatch(ctrl, /export async function (listKeys|createKey|deleteKey)\b/);
    const svc = code('server/src/services/agent.service.ts');
    assert.doesNotMatch(svc, /async (listKeys|createKey|deleteKey)\(/);
    assert.doesNotMatch(code('client/src/api/agent.api.ts'), /\/agent\/keys/);
    const routes = code('server/src/routes/agent.routes.ts');
    assert.match(routes, /from '\.\.\/controllers\/agentKeys\.controller'/);

    const shared = read('shared/src/types.ts');
    assert.match(shared, /export interface AgentKeyView \{[^}]*keyMasked: string;[^}]*pendingCount: number;/);
    assert.match(shared, /export interface AgentKeyCreated extends AgentKeyView \{\s*key: string;/);
    assert.match(code('server/src/services/agentKey.service.ts'), /import type \{ AgentKeyView, AgentKeyCreated \} from '@obliview\/shared';/);
    assert.match(code('client/src/api/agentKeys.api.ts'), /export type AgentKey = AgentKeyView;/);
  });

  lotIt('W10-6', '84.4 approval keeps the registration group; approver-only approves without a group', async () => {
    const admin = await h.adminIn(2);
    const g = await createGroup(h.db, { tenantId: 2 });
    const k = await createKey(h.db, 2);

    // PATCH {status} without groupId keeps the registration group.
    const d1 = await createDevice(h.db, { tenantId: 2, keyId: k.id, status: 'pending', groupId: g });
    const r1 = await admin.patch(`/api/agent/devices/${d1.id}`, { status: 'approved' });
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r1.json.data.groupId, g);
    // An explicit null still means "no group".
    const d2 = await createDevice(h.db, { tenantId: 2, keyId: k.id, status: 'pending', groupId: g });
    const r2 = await admin.patch(`/api/agent/devices/${d2.id}`, { status: 'approved', groupId: null });
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r2.json.data.groupId, null);

    // An approver without agents.manage: status alone is accepted, a group is not.
    const [set] = await h.db('permission_sets')
      .insert({ name: 'W10 approver', slug: `w10-approver-${Date.now()}`, capabilities: JSON.stringify(['ips.view', 'agents.approve']) })
      .returning('slug') as Array<{ slug: string }>;
    const approver = await createUser(h.db, { tenants: [2], tenantRole: set.slug });
    const ac = await h.login(approver.username);
    assert.equal((await ac.switchTenant(2)).status, 200);
    const d3 = await createDevice(h.db, { tenantId: 2, keyId: k.id, status: 'pending', groupId: g });
    assert.equal((await ac.patch(`/api/agent/devices/${d3.id}`, { status: 'approved', groupId: g })).status, 403);
    const r3 = await ac.patch(`/api/agent/devices/${d3.id}`, { status: 'approved' });
    assert.equal(r3.status, 200, r3.text);
    assert.equal(r3.json.data.groupId, g);

    // The client sends no groupId without agents.manage (hub and agent detail).
    const hub = code('client/src/pages/AdminAgentPage.tsx');
    assert.match(hub, /canPickGroup=\{canManageAgents\}/);
    assert.match(hub, /groupId === undefined \? \{ status: 'approved' \} : \{ status: 'approved', groupId \}/);
    assert.match(code('server/src/controllers/agent.controller.ts'), /'groupId' in req\.body \? \(groupId \?\? null\) : undefined/);
  });

  lotIt('W10-6', '84.5 ?tenants= over HTTP; ban origin attribution follows the god view', async () => {
    // IP reputation chips.
    const ip = nextIp();
    await insertEvents(h.db, { deviceId: D.B.id, tenantId: 2, ip, count: 1 });
    await insertEvents(h.db, { deviceId: D.C.id, tenantId: 3, ip, count: 4 });
    const now = new Date();
    await h.db('ip_reputation').insert({
      ip, total_failures: 5, total_successes: 0, affected_agents_count: 2,
      affected_services: ['ssh'], attempted_usernames: ['root'], first_seen: now, last_seen: now, updated_at: now,
    });
    const rep = async (tenant: number, chips: string) => {
      const r = await (await h.adminIn(tenant)).get(`/api/ip-reputation?search=${ip}${chips}`);
      assert.equal(r.status, 200, r.text);
      return (r.json.data as Array<Record<string, any>>).find((x) => host(x.ip) === ip);
    };
    assert.equal((await rep(1, ''))?.totalFailures, 5);
    const narrowed = await rep(1, '&tenants=3');
    assert.equal(narrowed?.totalFailures, 4, 'Default narrowed to tenant 3');
    assert.deepEqual(narrowed?.tenantIds, [3]);
    assert.equal((await rep(2, '&tenants=3'))?.totalFailures, 1, 'chips ignored outside Default');

    // Rate-limit policies and service templates.
    const maxValue = 84_000 + Math.floor(Math.random() * 900);
    const pol = await (await h.adminIn(3)).post('/api/rate-limit-policies', { type: 'connection', scope: 'tenant', maxValue });
    assert.equal(pol.status, 201, pol.text);
    const polIds = async (q: string) => ((await (await h.adminIn(1)).get(`/api/rate-limit-policies${q}`)).json.data as any[]).map((p) => p.id);
    assert.ok((await polIds('')).includes(pol.json.data.id));
    assert.ok(!(await polIds('?tenants=2')).includes(pol.json.data.id));
    assert.ok((await polIds('?tenants=3')).includes(pol.json.data.id));
    assert.ok(!(await polIds('?scope=tenant&tenants=2')).includes(pol.json.data.id));

    const tpl = await (await h.adminIn(3)).post('/api/service-templates', { name: `t84-${maxValue}`, serviceType: 'ssh' });
    assert.equal(tpl.status, 201, tpl.text);
    const tplIds = async (q: string) => ((await (await h.adminIn(1)).get(`/api/service-templates${q}`)).json.data as any[]).map((t) => t.id);
    assert.ok((await tplIds('')).includes(tpl.json.data.id));
    assert.ok(!(await tplIds('?tenants=2')).includes(tpl.json.data.id));
    assert.ok((await tplIds('?tenants=3')).includes(tpl.json.data.id));

    // Ban origin attribution: a platform admin on tenant 2 gets no origin
    // tenant on the created ban; the Default god view does.
    const b2 = await (await h.adminIn(2)).post('/api/bans', { ip: nextIp() });
    assert.equal(b2.status, 201, b2.text);
    assert.equal(b2.json.data.originTenantId, null);
    assert.equal(b2.json.data.originTenantName, undefined);
    assert.equal(b2.json.data.isOriginTenant, true);
    const b1 = await (await h.adminIn(1)).post('/api/bans', { ip: nextIp() });
    assert.equal(b1.status, 201, b1.text);
    assert.equal(b1.json.data.originTenantId, 1);
  });

  lotIt('W10-6', '84.6 group reorder and agent-config need RW on each group', async () => {
    const tenant = 2;
    const gRw = await createGroup(h.db, { tenantId: tenant });
    const gRo = await createGroup(h.db, { tenantId: tenant });
    const [set] = await h.db('permission_sets')
      .insert({ name: 'W10 groups', slug: `w10-groups-${Date.now()}`, capabilities: JSON.stringify(['ips.view', 'groups.manage']) })
      .returning('slug') as Array<{ slug: string }>;
    const member = await createUser(h.db, { tenants: [tenant], tenantRole: set.slug });
    const [tm] = await h.db('user_teams')
      .insert({ name: `t84-${Date.now()}`, tenant_id: tenant, can_create: false })
      .returning('id') as Array<{ id: number }>;
    await h.db('team_memberships').insert({ team_id: tm.id, user_id: member.id });
    await h.db('team_permissions').insert([
      { team_id: tm.id, scope: 'group', scope_id: gRw, level: 'rw' },
      { team_id: tm.id, scope: 'group', scope_id: gRo, level: 'ro' },
    ]);
    const mc = await h.login(member.username);
    assert.equal((await mc.switchTenant(tenant)).status, 200);

    assert.equal((await mc.post('/api/groups/reorder', { items: [{ id: gRw, sortOrder: 5 }] })).status, 200);
    const refused = await mc.post('/api/groups/reorder', { items: [{ id: gRw, sortOrder: 1 }, { id: gRo, sortOrder: 2 }] });
    assert.equal(refused.status, 403, refused.text);
    assert.equal((await h.db('monitor_groups').where({ id: gRw }).first('sort_order')).sort_order, 5, 'nothing reordered');

    const cfg = { agentGroupConfig: { pushIntervalSeconds: 90 } };
    assert.equal((await mc.patch(`/api/groups/${gRw}/agent-config`, cfg)).status, 200);
    assert.equal((await mc.patch(`/api/groups/${gRo}/agent-config`, cfg)).status, 403);
    // A tenant admin (team scope bypass) is not restricted.
    assert.equal((await (await h.adminIn(tenant)).post('/api/groups/reorder', { items: [{ id: gRo, sortOrder: 3 }] })).status, 200);
  });

  lotIt('W10-6', '84.7 agent detail: Release API key binding (agents.manage, Go agents only)', () => {
    const tab = code('client/src/pages/agentDetail/SettingsTab.tsx');
    assert.match(tab, /const canRelease = !settingsReadOnly && device\.deviceType === 'agent' && device\.apiKeyId != null;/);
    assert.match(tab, /agentApi\.updateDevice\(device\.id, \{ apiKeyId: null \}\)/);
    assert.match(tab, /t\('agents\.releaseKeyBinding'\)/);
    assert.match(tab, /danger: true/);
  });

  lotIt('W10-6', '84.8 every W10 i18n key exists in en and fr with the same placeholders', () => {
    const en = locale('en');
    const fr = locale('fr');
    const keys = new Set<string>(DYNAMIC_KEYS);
    for (const f of W10_CLIENT_FILES) for (const k of literalKeys(read(f))) keys.add(k);
    assert.ok(keys.size > 500, `expected the W10 pages to use many keys, found ${keys.size}`);
    const missing: string[] = [];
    for (const key of keys) {
      const e = lookup(en, key);
      const r = lookup(fr, key);
      if (typeof e !== 'string') { missing.push(`en:${key}`); continue; }
      if (typeof r !== 'string') { missing.push(`fr:${key}`); continue; }
      if (placeholders(e) !== placeholders(r)) missing.push(`placeholders differ: ${key}`);
    }
    assert.deepEqual(missing, []);
  });
});
