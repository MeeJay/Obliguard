/**
 * 70a — W8-1 IP Reputation hub, Activity tab and the unified IP drawer
 * (client, static checks + the pure helpers transpiled and evaluated):
 *   - /ip-reputation is a thin hub (PageContainer + PageHeader +
 *     SegmentedTabs, ?tab= through useTabParam, lazy self-contained tabs);
 *     the old in-file tabs / drawer and the unrouted BansPage / WhitelistPage
 *     are gone;
 *   - the Activity tab keeps filters, page and sort in the URL, sorts on the
 *     server, uses the kit table pieces, clears the selection on filter /
 *     page changes and gates every action with useIpsPermissions;
 *   - one IpDetailDrawer, driven by ?ip= (useIpDrawer), mounted once in
 *     AppLayout, with the owner model (single Lift, promote from Default);
 *   - no isAdmin / role gates, native dialogs or silent catches.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(REPO, rel));

const HUB = 'client/src/pages/IPReputationPage.tsx';
const ACTIVITY = 'client/src/pages/ipReputation/ActivityTab.tsx';
const DRAWER = 'client/src/components/ip/IpDetailDrawer.tsx';
const HOOK = 'client/src/hooks/useIpDrawer.ts';
const LAYOUT = 'client/src/components/layout/AppLayout.tsx';
const API = 'client/src/api/ipReputation.api.ts';
const OWNED = [HUB, ACTIVITY, DRAWER, HOOK, API];

/** Source without line / block comments (a comment may mention confirm()). */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** A client module transpiled to CommonJS; its runtime imports resolve to empty stubs. */
function load(rel: string): Record<string, any> {
  const js = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod: { exports: Record<string, any> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', js)(mod.exports, mod, () => ({}));
  return mod.exports;
}

describe('70a IP Reputation hub + IP drawer (W8-1)', () => {
  lotIt('W8-1', '70a.1 the hub is thin: kit shell, ?tab= and lazy self-contained tabs', () => {
    const src = code(HUB);
    for (const kit of ['PageContainer', 'PageHeader', 'SegmentedTabs']) {
      assert.match(src, new RegExp(`from '@/components/common/${kit}'`), `hub imports ${kit}`);
      assert.match(src, new RegExp(`<${kit}\\b`), `hub renders ${kit}`);
    }
    assert.match(src, /useTabParam<HubTab>\([^)]*'activity'\)/, 'tab in ?tab= with activity as default');
    assert.match(src, /lazy\(\(\) => import\('\.\/ipReputation\/ActivityTab'\)\)/, 'Activity tab is lazy');
    assert.match(src, /<Suspense\b/);
    assert.match(src, /export function IPReputationPage\(/, 'App.tsx keeps its named import');
    // The old in-file tab / drawer code is gone (the file was 2.7k lines).
    for (const dead of ['function ActivityTab', 'function BansTab', 'function WhitelistTab', 'function RemoteTab', 'IPDetailDrawer', 'AddBanModal']) {
      assert.ok(!src.includes(dead), `hub still holds ${dead}`);
    }
    assert.ok(read(HUB).split('\n').length < 150, 'hub stays thin');
    assert.ok(!exists('client/src/pages/BansPage.tsx'), 'unrouted BansPage deleted');
    assert.ok(!exists('client/src/pages/WhitelistPage.tsx'), 'unrouted WhitelistPage deleted');
    // Tab contract: default export, no props.
    assert.match(code(ACTIVITY), /export default function ActivityTab\(\)/);
  });

  lotIt('W8-1', '70a.2 Activity: URL state, server sort, kit table, explicit selection', () => {
    const src = code(ACTIVITY);
    for (const param of ['status', 'search', 'page', 'sortBy', 'sortOrder']) {
      assert.match(src, new RegExp(`searchParams\\.get\\('${param}'\\)`), `?${param}= read from the URL`);
    }
    assert.match(src, /useTenantFilter\(\)/, 'tenant chips in ?tenants=');
    assert.match(src, /<TenantFilterChips\b/);
    assert.match(src, /perms\.isGodView \? \[\.\.\.tenantFilter\.value\]/, 'a stray ?tenants= is ignored outside the god view');
    assert.match(src, /SOCKET_EVENTS\.WHITELIST_CHANGED|'whitelist:changed'/, 'the list reloads on whitelist changes');
    assert.match(src, /'lastSeen', 'failures', 'agents', 'country', 'firstSeen'/, 'server sort keys');
    assert.match(src, /sortBy: sort\?\.field/, 'the sort is sent to the server');
    for (const kit of ['SortableTh', 'TableScroll', 'Pagination', 'TableSkeleton', 'EmptyState', 'ActionMenu', 'IpStatusBadge', 'TenantBadge']) {
      assert.match(src, new RegExp(`<${kit}\\b`), `Activity renders ${kit}`);
    }
    assert.match(src, /<TableScroll[^>]*stickyFirstCol/, 'sticky IP column');
    assert.match(src, /variant="filtered"/, 'filtered empty state');
    assert.match(src, /useRowSelection\(visibleIps, \[status, urlSearch, tenantsKey, page, pageSize, sort\]\)/,
      'selection cleared on every filter / page / sort change');
    assert.match(src, /indeterminate = selection\.headerState === 'indeterminate'/, 'header checkbox from the visible rows');
    for (const bulk of ['bulkBan', 'bulkWhitelist', 'bulkLift', 'bulkClear', 'bulkLabel']) {
      assert.match(src, new RegExp(`const ${bulk} = async`), `bulk action ${bulk}`);
    }
    assert.match(src, /useConfirm\(\)/);
    assert.match(src, /usePrompt\(\)/);
    assert.match(src, /openIp\(row\.ip\)/, 'rows open the shared drawer');
  });

  lotIt('W8-1', '70a.3 one deep-linkable drawer: ?ip=, mounted once in AppLayout, owner model', () => {
    const hook = code(HOOK);
    assert.match(hook, /export const IP_DRAWER_PARAM = 'ip'/);
    assert.match(hook, /export function useIpDrawer\(\)/);
    assert.match(hook, /export function notifyIpChanged\(/);

    const layout = read(LAYOUT);
    assert.match(layout, /import \{ IpDetailDrawer \} from '@\/components\/ip\/IpDetailDrawer'/);
    assert.equal((layout.match(/<IpDetailDrawer \/>/g) ?? []).length, 1, 'mounted exactly once');

    const drawer = code(DRAWER);
    assert.match(drawer, /<Drawer\b/, 'built on the kit Drawer');
    assert.match(drawer, /useIpDrawer\(\)/);
    for (const call of ['getDetail', 'eventsByIp', 'banHistory', 'whitelistEntries']) {
      assert.match(drawer, new RegExp(`ipReputationApi\\.${call}\\(ip\\)`), `drawer loads ${call}`);
    }
    // One Lift (server decides global vs local exclusion); promote gated to Default.
    assert.match(drawer, /perms\.canLiftGlobally/);
    assert.match(drawer, /perms\.canPromote/);
    assert.match(read('client/src/hooks/useIpsPermissions.ts'), /canPromote: canPromoteCap && isMaster/);
    assert.match(drawer, /export function useIpActions\(\)/, 'actions shared with the hub rows');

    const api = code(API);
    assert.match(api, /'\/ip-events\/\$\{encodeURIComponent\(ip\)\}'|`\/ip-events\/\$\{encodeURIComponent\(ip\)\}`/, 'events timeline from GET /ip-events/:ip');
    assert.match(api, /from '@obliview\/shared'/, 'typed with the shared types');
    // Ban / whitelist writes never send a scope: it follows the operating tenant.
    assert.match(api, /apiClient\.post<ApiResponse<IpBan>>\('\/bans', \{ ip, reason \}\)/);
    assert.match(api, /apiClient\.post<ApiResponse<IpWhitelist>>\('\/whitelist', \{ ip, label \}\)/);
  });

  lotIt('W8-1', '70a.4 no role gates, native dialogs, raw fetch or silent catches', () => {
    for (const rel of OWNED) {
      const src = code(rel);
      assert.doesNotMatch(src, /(?<![\w.])(?:window\.)?(?:confirm|prompt|alert)\(/, `${rel}: native confirm/prompt/alert`);
      assert.doesNotMatch(src, /\bisAdmin\b|user\?\.role|role === 'admin'/, `${rel}: role gate (use useIpsPermissions)`);
      assert.doesNotMatch(src, /(?<![A-Za-z.])fetch\(|tenantFetch/, `${rel}: raw fetch`);
      assert.doesNotMatch(src, /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/, `${rel}: silent .catch(() => {})`);
      assert.ok(!src.includes('fixed inset-0'), `${rel}: hand-rolled overlay`);
    }
    for (const rel of [ACTIVITY, DRAWER]) assert.match(code(rel), /useIpsPermissions\(\)/, `${rel}: capability gates`);
  });

  lotIt('W8-1', '70a.5 pure helpers: ?ip= parsing, ban target containment, event rows', () => {
    const hook = load(HOOK);
    assert.equal(hook.readIpParam(' 1.2.3.4 '), '1.2.3.4');
    assert.equal(hook.readIpParam(''), null);
    assert.equal(hook.readIpParam(null), null);
    assert.equal(hook.readIpParam('x'.repeat(65)), null);

    const api = load(API);
    assert.equal(api.targetHost('10.0.0.1/32'), '10.0.0.1');
    assert.equal(api.targetCovers('1.2.3.4', '1.2.3.4'), true);
    assert.equal(api.targetCovers('11.2.3.45', '1.2.3.4'), false, 'a substring never matches');
    assert.equal(api.targetCovers('1.2.3.0', '1.2.3.77', 24), true, 'CIDR via cidrPrefix');
    assert.equal(api.targetCovers('1.2.3.0/24', '1.2.4.1'), false);
    assert.equal(api.targetCovers('10.0.0.0/8', '10.200.1.1'), true);
    assert.equal(api.targetCovers('2001:db8::1', '2001:DB8::1'), true, 'IPv6 compares case-insensitively');

    const ev = api.normaliseEvent({ id: '7', ip: '1.2.3.4', service: 'ssh', event_type: 'auth_failure', raw_log: 'Failed password', hostname: 'web-1', timestamp: '2026-10-01T00:00:00Z', device_id: 3 });
    assert.equal(ev.id, 7);
    assert.equal(ev.eventType, 'auth_failure');
    assert.equal(ev.rawLog, 'Failed password');
    assert.equal(ev.deviceHostname, 'web-1');
    assert.equal(ev.deviceId, 3);
    const camel = api.normaliseEvent({ id: 8, ip: '1.2.3.4', service: 'rdp', eventType: 'auth_success', rawLog: null, deviceHostname: 'dc', timestamp: 't', createdAt: 't' });
    assert.equal(camel.eventType, 'auth_success');
    assert.equal(camel.deviceHostname, 'dc');
  });
});
