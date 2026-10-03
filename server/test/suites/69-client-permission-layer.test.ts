/**
 * 69 — W7-4 client permission layer (client side, static checks):
 *   - hooks/usePermission exports useCan (any-of, alias-aware through
 *     authStore.hasCapability), <Can cap fallback> and useIsPlatformAdmin;
 *     hooks/useIpsPermissions exposes the IPS action flags, the global ones
 *     tied to the master tenant;
 *   - ProtectedRoute takes requiredCapabilities (any-of);
 *   - App.tsx gates each page by its capability (no blanket admin block):
 *     only /manage/tenants and /settings stay platform-admin; every
 *     capability named is a real tenant capability;
 *   - Sidebar: navItems + adminNavItems with predicates matching the route
 *     gates, labelled Administration header with aria-expanded, badgeCount,
 *     the shared AgentStatusBadge (no local Obliview status map);
 *   - DashboardPage / NetMapPage: Lift and Ban gated by useIpsPermissions and
 *     confirmed through useConfirm (no native dialogs).
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { TENANT_CAPABILITY_KEYS } from '@obliview/shared';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

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

/**
 * Route path -> gate of App.tsx, read from the
 * `<Route element={<ProtectedRoute required… />}> … </Route>` blocks.
 */
function routeGates(): Map<string, { role?: string; caps?: string[]; cap?: string }> {
  const src = code('client/src/App.tsx');
  const out = new Map<string, { role?: string; caps?: string[]; cap?: string }>();
  const block = /<Route element=\{<ProtectedRoute\s+(required[\s\S]*?)\/>\}>([\s\S]*?)<\/Route>/g;
  for (const m of src.matchAll(block)) {
    const props = m[1];
    const gate: { role?: string; caps?: string[]; cap?: string } = {};
    const role = /requiredRole="([^"]+)"/.exec(props);
    if (role) gate.role = role[1];
    const caps = /requiredCapabilities=\{\[([^\]]*)\]\}/.exec(props);
    if (caps) gate.caps = literals(caps[1]);
    const cap = /requiredCapability="([^"]+)"/.exec(props);
    if (cap) gate.cap = cap[1];
    for (const p of m[2].matchAll(/<Route path="([^"]+)"/g)) out.set(p[1], gate);
  }
  return out;
}

const EXPECTED_CAPS: Record<string, string[]> = {
  '/manage/agents': ['agents.keys', 'agents.approve', 'agents.manage'],
  '/groups': ['groups.manage'],
  '/group/:id/edit': ['groups.manage'],
  '/notifications': ['notifications.manage'],
  '/manage/users': ['users.manage'],
  '/manage/service-templates': ['templates.write', 'ips.view'],
  '/manage/network-limiting': ['rate_limit.write'],
  // W13: settings rows are tenant-scoped (critic C2 satisfied), so the
  // workspace level of the cascade opens to the 'settings' capability.
  '/settings/workspace': ['settings'],
};
const PLATFORM_ONLY = ['/manage/tenants', '/settings'];

describe('69 client permission layer (W7-4)', () => {
  lotIt('W7-4', '69.1 usePermission: useCan (any-of via hasCapability), <Can>, useIsPlatformAdmin', () => {
    const src = code('client/src/hooks/usePermission.ts');
    assert.match(src, /export function useCan\(/);
    assert.match(src, /export function Can\(/);
    assert.match(src, /export function useIsPlatformAdmin\(/);
    // Alias-aware: delegates to authStore.hasCapability, any-of over a list.
    assert.match(src, /\.some\(\(c\) => s\.hasCapability\(c\)\)/);
    assert.match(src, /fallback/);
  });

  lotIt('W7-4', '69.2 useIpsPermissions: capability flags, global ones tied to the master tenant', () => {
    const src = code('client/src/hooks/useIpsPermissions.ts');
    for (const flag of ['canBan', 'canLift', 'canLiftGlobally', 'canPromote', 'canWhitelist', 'canWhitelistGlobally', 'canLabel', 'canClear', 'isGodView']) {
      assert.match(src, new RegExp(`\\b${flag}\\b`), `useIpsPermissions exposes ${flag}`);
    }
    assert.match(src, /useIsMasterTenant\(\)/);
    assert.match(src, /canLiftGlobally: canLift && isMaster/);
    assert.match(src, /canWhitelistGlobally: canWhitelist && isMaster/);
    assert.match(src, /canPromote: \w+ && isMaster/);
    for (const cap of ['bans.create', 'bans.lift', 'bans.promote', 'whitelist.write', 'ip.labels', 'ip.reputation.clear']) {
      assert.ok(src.includes(`useCan('${cap}')`), `useIpsPermissions reads ${cap}`);
    }
  });

  lotIt('W7-4', '69.3 ProtectedRoute: requiredCapabilities any-of', () => {
    const src = code('client/src/components/layout/ProtectedRoute.tsx');
    assert.match(src, /requiredCapabilities\?: readonly CapabilityKey\[\]/);
    assert.match(src, /requiredCapabilities\.some\(\(c\) => hasCapability\(c\)\)/);
  });

  lotIt('W7-4', '69.4 App.tsx: each page gated by its capability, only workspaces and settings platform-only', () => {
    const gates = routeGates();
    for (const [route, caps] of Object.entries(EXPECTED_CAPS)) {
      const gate = gates.get(route);
      assert.ok(gate, `${route} is behind a ProtectedRoute gate`);
      assert.equal(gate.role, undefined, `${route} is not role-gated`);
      assert.deepEqual([...(gate.caps ?? [])].sort(), [...caps].sort(), `${route} capability gate`);
    }
    for (const route of PLATFORM_ONLY) {
      assert.equal(gates.get(route)?.role, 'admin', `${route} stays platform-admin`);
    }
    const adminRoutes = [...gates.entries()].filter(([, g]) => g.role === 'admin').map(([p]) => p).sort();
    assert.deepEqual(adminRoutes, [...PLATFORM_ONLY].sort(), 'no other route behind requiredRole="admin"');
    const known = new Set<string>(TENANT_CAPABILITY_KEYS);
    for (const [route, g] of gates) {
      for (const c of [...(g.caps ?? []), ...(g.cap ? [g.cap] : [])]) {
        assert.ok(known.has(c), `${route}: '${c}' is a tenant capability`);
      }
    }
  });

  lotIt('W7-4', '69.5 Sidebar: predicate nav lists matching the routes, labelled admin section, badge, shared status badge', () => {
    const src = code('client/src/components/layout/Sidebar.tsx');
    assert.match(src, /const navItems: NavItem\[\]/);
    assert.match(src, /const adminNavItems: NavItem\[\]/);
    assert.match(src, /visible: boolean/);
    assert.doesNotMatch(src, /adminOnly/, 'no adminOnly flag (capability predicates instead)');
    assert.doesNotMatch(src, /CAPABILITIES\.(MONITOR_RW|GROUP_RW)/, 'no legacy alias gates');
    // Same any-of sets as the route guards.
    for (const caps of Object.values(EXPECTED_CAPS)) {
      const call = caps.length === 1 ? `useCan('${caps[0]}')` : `useCan([${caps.map((c) => `'${c}'`).join(', ')}])`;
      assert.ok(src.includes(call), `Sidebar gates with ${call}`);
    }
    assert.match(src, /visible: isPlatformAdmin && isMaster/, 'Workspaces: platform admin on the master tenant');
    // Labelled, accessible Administration header shown only when it has items.
    assert.match(src, /adminNavItems\.length > 0 &&/);
    assert.match(src, /aria-expanded=\{adminMenuOpen\}/);
    assert.match(src, /t\('nav\.administration', 'Administration'\)/);
    // Pending agents badge.
    assert.match(src, /badgeCount: canApproveAgents \? pendingCount : undefined/);
    assert.match(src, /d\.status === 'pending'/);
    // Shared status badge, problem agents first.
    assert.match(src, /from '@\/components\/status\/AgentStatusBadge'/);
    assert.doesNotMatch(src, /function AgentStatusBadge\b/, 'no local Obliview status map');
    assert.doesNotMatch(src, /label: 'UP'|label: 'DOWN'/);
    assert.match(src, /STATUS_TIER/);
    // Add agent needs the enrolment-key capability, not the platform role.
    assert.match(src, /canAddAgent = useCan\('agents\.keys'\)/);
  });

  lotIt('W7-4', '69.6 Dashboard / NetMap: Lift and Ban gated by useIpsPermissions, confirmed via useConfirm', () => {
    for (const rel of ['client/src/pages/DashboardPage.tsx', 'client/src/pages/NetMapPage.tsx']) {
      const src = code(rel);
      assert.doesNotMatch(src, /window\.(?:confirm|prompt|alert)\b/, `${rel}: native dialog`);
      assert.match(src, /useConfirm\(\)/, `${rel} uses useConfirm`);
      assert.match(src, /useIpsPermissions\(\)/, `${rel} uses useIpsPermissions`);
    }
    const dash = code('client/src/pages/DashboardPage.tsx');
    assert.match(dash, /\{canLiftBan\(ban\) && \(/, 'Lift button rendered only when allowed');
    assert.match(dash, /canLift && \(canLiftGlobally \|\|/);
    const netmap = code('client/src/pages/NetMapPage.tsx');
    assert.match(netmap, /if \(!canBan\) return;/);
    assert.match(netmap, /\{canBan && clickedIp\.status !== 'banned'/, 'IP panel Ban button gated');
    assert.match(netmap, /\{!isBan && canBan && \(/, 'live-event quick ban gated');
  });
});
