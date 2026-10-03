/**
 * 76 — W9-3 Policies hub, Settings split and sidebar regrouping (client,
 * static checks):
 *   - /policies is an Obliance-style hub (PageContainer + PageHeader +
 *     SegmentedTabs, ?tab= through useTabParam) embedding Service templates,
 *     Network limits and Remote blocklists, each tab gated by its capability;
 *     no visible 'Ban policy' stub;
 *   - App.tsx: /policies admits any of the tab capabilities; the old
 *     /manage/service-templates and /manage/network-limiting URLs redirect to
 *     the matching tab (same gate as the tab);
 *   - Sidebar: Navigation = Dashboard, NetMap, IP Reputation, Live events,
 *     Agents (/agents, W10), Policies; Administration = Users, Workspaces,
 *     Agent config (/manage/agents, W10), Notifications, Groups, Settings; no link to the old policy pages; the Policies
 *     predicate is the route gate;
 *   - RateLimitPage: `embedded` prop, UI kit (TableScroll, ToggleSwitch,
 *     ActionMenu, Modal, useConfirm), search + grouping by target, writes
 *     gated by rate_limit.write (enforcement switch: platform admin on
 *     Default), strings through t('networkLimiting.*');
 *   - RemoteBlocklistsSection extracted from SettingsPage: every write
 *     control reserved to the platform admin on the Default tenant, server
 *     error text in the toasts, enforce toggle confirmed; SettingsPage keeps
 *     the Obli.tools contribution and the danger zone only.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { TENANT_CAPABILITY_KEYS } from '@obliview/shared';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const HUB = 'client/src/pages/PoliciesPage.tsx';
const LIMITS = 'client/src/pages/RateLimitPage.tsx';
const BLOCKLISTS = 'client/src/components/settings/RemoteBlocklistsSection.tsx';
const SETTINGS = 'client/src/pages/SettingsPage.tsx';
const APP = 'client/src/App.tsx';
const SIDEBAR = 'client/src/components/layout/Sidebar.tsx';

/** Source without line / block comments (a comment may mention confirm()). */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Quoted string literals of a `['a', 'b']` list. */
function literals(list: string): string[] {
  return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Route path -> { caps of its ProtectedRoute block, element source }. */
function routes(): Map<string, { caps?: string[]; role?: string; element: string }> {
  const src = code(APP);
  const out = new Map<string, { caps?: string[]; role?: string; element: string }>();
  const block = /<Route element=\{<ProtectedRoute\s+(required[\s\S]*?)\/>\}>([\s\S]*?)<\/Route>/g;
  for (const m of src.matchAll(block)) {
    const caps = /requiredCapabilities=\{\[([^\]]*)\]\}/.exec(m[1]);
    const role = /requiredRole="([^"]+)"/.exec(m[1]);
    for (const r of m[2].matchAll(/<Route path="([^"]+)" element=\{([\s\S]*?)\} \/>/g)) {
      out.set(r[1], { caps: caps ? literals(caps[1]) : undefined, role: role?.[1], element: r[2] });
    }
  }
  return out;
}

/** The `{ label: …, path: '…', … }` items of one nav list, in order. */
function navPaths(src: string, list: 'navItems' | 'adminNavItems'): string[] {
  const start = src.indexOf(`const ${list}: NavItem[] = [`);
  assert.ok(start >= 0, `Sidebar declares ${list}`);
  const end = src.indexOf('].filter(item => item.visible);', start);
  assert.ok(end > start, `${list} is filtered by its visibility predicates`);
  return [...src.slice(start, end).matchAll(/path: '([^']+)'/g)].map((m) => m[1]);
}

const TEMPLATE_CAPS = ['templates.write', 'ips.view'];
const LIMIT_CAPS = ['rate_limit.write'];
const BLOCKLIST_CAPS = ['remote_blocklists'];
const POLICY_CAPS = [...TEMPLATE_CAPS, ...LIMIT_CAPS, ...BLOCKLIST_CAPS];

describe('76 Policies hub, Settings split and navigation (W9-3)', () => {
  lotIt('W9-3', '76.1 PoliciesPage: kit hub with ?tab= and capability-gated embedded tabs', () => {
    const src = code(HUB);
    for (const kit of ['PageContainer', 'PageHeader', 'SegmentedTabs']) {
      assert.match(src, new RegExp(`from '@/components/common/${kit}'`), `hub imports ${kit}`);
      assert.match(src, new RegExp(`<${kit}\\b`), `hub renders ${kit}`);
    }
    assert.match(src, /useTabParam<PolicyTab>\(/, 'active tab in ?tab=');
    assert.match(src, /const POLICY_TABS = \['templates', 'limits', 'blocklists', 'banPolicy'\] as const;/);
    assert.match(src, /<ServiceTemplatesPage embedded \/>/);
    assert.match(src, /<RateLimitPage embedded \/>/);
    assert.match(src, /<RemoteBlocklistsSection \/>/);
    assert.ok(src.includes("useCan(['templates.write', 'ips.view'])"), 'templates tab: templates.write or ips.view');
    assert.ok(src.includes("useCan('rate_limit.write')"), 'limits tab: rate_limit.write');
    assert.ok(src.includes("useCan('remote_blocklists')"), 'blocklists tab: remote_blocklists');
    // Hidden tabs are not part of the URL whitelist.
    assert.match(src, /POLICY_TABS\.filter\(\(id\) => definitions\[id\]\.visible\)/);
    // The Ban policy tab (W12-3) fills the slot W9-3 reserved.
    assert.match(src, /from '@\/components\/policies\/BanPolicyTab'/);
    assert.match(src, /<BanPolicyTab \/>/);
  });

  lotIt('W9-3', '76.2 App.tsx: /policies gated by any tab capability, old URLs redirect to their tab', () => {
    const r = routes();
    const hub = r.get('/policies');
    assert.ok(hub, '/policies is routed behind a ProtectedRoute');
    assert.equal(hub.role, undefined, '/policies is not role-gated');
    assert.deepEqual([...(hub.caps ?? [])].sort(), [...POLICY_CAPS].sort());
    assert.match(hub.element, /^<PoliciesPage \/>$/);
    const known = new Set<string>(TENANT_CAPABILITY_KEYS);
    for (const c of POLICY_CAPS) assert.ok(known.has(c), `'${c}' is a tenant capability`);

    const hubSrc = code(HUB);
    for (const [legacy, tab, caps] of [
      ['/manage/service-templates', 'templates', TEMPLATE_CAPS],
      ['/manage/network-limiting', 'limits', LIMIT_CAPS],
    ] as const) {
      const route = r.get(legacy);
      assert.ok(route, `${legacy} still answers`);
      assert.equal(route.element, `<Navigate to="/policies?tab=${tab}" replace />`, `${legacy} redirects to ?tab=${tab}`);
      assert.deepEqual([...(route.caps ?? [])].sort(), [...caps].sort(), `${legacy}: same gate as the ${tab} tab`);
      assert.ok(hubSrc.includes(`'${tab}'`), `'${tab}' is a hub tab`);
    }
    const app = code(APP);
    assert.doesNotMatch(app, /<ServiceTemplatesPage\b|<RateLimitPage\b/, 'policy pages are reached through the hub only');
  });

  lotIt('W9-3', '76.3 Sidebar: Obliance grouping, Policies entry gated like its route', () => {
    const src = code(SIDEBAR);
    // W10 split: 'Agents' is the fleet list (/agents), 'Agent config' the admin hub (/manage/agents).
    assert.deepEqual(navPaths(src, 'navItems'), ['/', '/netmap', '/ip-reputation', '/live-events', '/agents', '/policies']);
    // W11-1: the audit log entry (audit.read) sits between Groups and Settings.
    // W13-5: the workspace level of the settings cascade follows Settings ('settings' holders).
    assert.deepEqual(navPaths(src, 'adminNavItems'), ['/manage/users', '/manage/tenants', '/manage/agents', '/notifications', '/groups', '/audit-log', '/settings', '/settings/workspace']);
    assert.doesNotMatch(src, /\/manage\/service-templates|\/manage\/network-limiting/, 'no link to the old policy pages');
    assert.ok(src.includes("useCan(['templates.write', 'ips.view'])"));
    assert.ok(src.includes("useCan('rate_limit.write')"));
    assert.ok(src.includes("useCan('remote_blocklists')"));
    assert.match(src, /const canSeePolicies = canSeeTemplates \|\| canRateLimit \|\| canRemoteBlocklists;/);
    assert.match(src, /path: '\/policies', icon: <ShieldCheck size=\{18\} \/>, visible: canSeePolicies/);
    // Predicates and badges kept.
    assert.match(src, /badgeCount: canApproveAgents \? pendingCount : undefined/);
    assert.match(src, /visible: isPlatformAdmin && isMaster/);
    assert.match(src, /path: '\/groups',\s+icon: <FolderTree size=\{18\} \/>, visible: canManageGroups/);
  });

  lotIt('W9-3', '76.4 RateLimitPage: embedded, UI kit, search + grouping, capability gates, i18n', () => {
    const src = code(LIMITS);
    assert.match(src, /export function RateLimitPage\(\{ embedded = false \}: RateLimitPageProps = \{\}\)/);
    assert.match(src, /<PageContainer embedded=\{embedded\}/);
    assert.match(src, /embedded \? \(/, 'no page title when embedded');
    for (const kit of ['TableScroll', 'ToggleSwitch', 'ActionMenu', 'Modal', 'EmptyState', 'TableSkeleton']) {
      assert.match(src, new RegExp(`<${kit}\\b`), `renders ${kit}`);
    }
    assert.match(src, /useConfirm\(\)/);
    assert.match(src, /danger: true/, 'delete is a danger confirm');
    assert.doesNotMatch(src, /role="switch"/, 'no hand-rolled switch');
    assert.ok(!src.includes('fixed inset-0'), 'no hand-rolled overlay');
    assert.doesNotMatch(src, /window\.(?:confirm|prompt|alert)\b/);
    assert.doesNotMatch(src, /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/, 'no silent catch');
    // Search and grouping by target.
    assert.match(src, /type="search"/);
    assert.match(src, /groupByTarget \? \(/);
    assert.match(src, /usePersistedState<boolean>\('og-netlimits-group'/);
    // Capabilities, not the platform role, gate the writes; the instance-wide
    // enforcement switch stays platform admin on Default.
    assert.match(src, /const canWrite = useCan\('rate_limit\.write'\);/);
    assert.match(src, /useCan\('rate_limit\.write'\) && !readOnly/, 'NetworkLimitsPanel gated by rate_limit.write');
    assert.doesNotMatch(src, /role === 'admin'/);
    assert.match(src, /const canSwitch = isPlatformAdmin && isMaster;/);
    assert.match(src, /if \(p\.scope === 'global'\) return isMaster;/, 'global policies owned by Default');
    assert.match(src, /\{editable && <ActionMenu/, 'row actions only for the owner');
    assert.ok((src.match(/t\('networkLimiting\./g) ?? []).length >= 40, 'strings through t(networkLimiting.*)');
    // NetworkLimitsPanel stays exported for the agent and group pages.
    assert.match(src, /export function NetworkLimitsPanel\(/);
  });

  lotIt('W9-3', '76.5 RemoteBlocklistsSection: writes for the platform admin on Default, enforce toggle, error text', () => {
    const src = code(BLOCKLISTS);
    assert.match(src, /export function RemoteBlocklistsSection\(\)/);
    assert.match(src, /const canWrite = isPlatformAdmin && isMaster;/);
    assert.match(src, /\{canWrite && \(\s*<Button size="sm" onClick=\{\(\) => setShowAdd\(true\)\}>/, 'Add only for writers');
    assert.match(src, /open=\{showAdd && canWrite\}/);
    assert.equal((src.match(/disabled=\{!canWrite \|\| busy\.has\(l\.id\)\}/g) ?? []).length, 2, 'enable and enforce toggles locked for readers');
    assert.match(src, /<td className="px-4 py-2">\s*\{canWrite && \(/, 'sync / delete only for writers');
    // Kit, confirms and server error text.
    assert.match(src, /<Modal\b/);
    assert.match(src, /<ToggleSwitch\b/);
    assert.match(src, /<IconButton\b/);
    assert.match(src, /<TableScroll\b/);
    const del = src.slice(src.indexOf('const handleDelete = async (id: number'));
    assert.match(del.slice(0, 600), /danger:\s*true/, 'delete is a danger confirm');
    const enforce = src.slice(src.indexOf('const handleEnforce = async'));
    assert.match(enforce.slice(0, 700), /if \(enforce && !\(await confirmAction\(\{[\s\S]*danger: true/, 'turning enforce on is confirmed');
    assert.match(enforce.slice(0, 900), /update\(l\.id, \{ enforce \}\)/);
    assert.ok((src.match(/apiError\(err\) \?\?/g) ?? []).length >= 4, 'server error text in the add / sync / delete / update toasts');
    assert.doesNotMatch(src, /window\.(?:confirm|prompt|alert)\b/);
    assert.doesNotMatch(src, /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
    assert.doesNotMatch(src, /role="switch"|fixed inset-0/);

    // SettingsPage keeps general settings, the Obli.tools contribution and the danger zone.
    const settings = code(SETTINGS);
    assert.doesNotMatch(settings, /function RemoteBlocklistsSection|<RemoteBlocklistsSection|remoteBlocklistApi/, 'blocklists moved out of Settings');
    assert.match(settings, /<ObliToolsContributionSection isDefaultTenant=\{isDefaultTenant\} \/>/);
    assert.match(settings, /'\/remote-blocklists\/push-now'/);
    assert.match(settings, /pushEnabled && isDefaultTenant && \(/, 'Push now only from the Default tenant');
    for (const route of ['/bans/wipe-bans', '/bans/wipe-reputation']) {
      assert.ok(settings.includes(`'${route}'`), `danger zone keeps ${route}`);
    }
  });
});
