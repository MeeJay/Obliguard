/**
 * 101 — W14-2 phone / tablet shell (client, static checks + the pure sidebar
 * resolution and the ui store transpiled and evaluated):
 *   - useEffectiveSidebar: drawer below lg, the 64 px rail by default between
 *     lg and xl, the stored preference from xl; no floating / mouse resize on
 *     a touch screen; forced states are never persisted;
 *   - uiStore: mobileNavOpen (never persisted), the collapse toggle flips the
 *     EFFECTIVE state, floating and collapsed stay mutually exclusive;
 *   - AppLayout: h-dvh (vh fallback), the Sidebar inside <Drawer side="left">
 *     below lg, closed on navigation and when leaving drawer mode, safe-area
 *     padded main that never widens the page;
 *   - Sidebar: 'drawer' variant (always expanded, close button, touch
 *     long-press drag, coarse targets);
 *   - Header: hamburger slot below lg, safe-area insets, the app switcher and
 *     security chips logic untouched;
 *   - TenantSwitcher: bottom sheet on phones, pointer / Escape dismissal.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const STORE = 'client/src/store/uiStore.ts';
const LAYOUT = 'client/src/components/layout/AppLayout.tsx';
const SIDEBAR = 'client/src/components/layout/Sidebar.tsx';
const HEADER = 'client/src/components/layout/Header.tsx';
const TENANT = 'client/src/components/layout/TenantSwitcher.tsx';

/** Source without line / block comments. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Minimal zustand: create(init) → hook with getState(). */
function zustandStub() {
  return {
    create: (init: (set: (p: any) => void, get: () => any) => any) => {
      let state: any;
      const set = (p: any) => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; };
      state = init(set, () => state);
      const hook: any = (sel: (s: any) => any) => sel(state);
      hook.getState = () => state;
      return hook;
    },
  };
}

/** uiStore transpiled to CommonJS, with a Map-backed localStorage. */
function loadStore(initial: Record<string, string> = {}) {
  const js = ts.transpileModule(read(STORE), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const data = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
  };
  const mod: { exports: Record<string, any> } = { exports: {} };
  const req = (name: string) => (name === 'zustand' ? zustandStub() : {});
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', 'localStorage', js)(mod.exports, mod, req, localStorage);
  return { mod: mod.exports, data };
}

describe('101 phone / tablet shell (W14-2)', () => {
  lotIt('W14-2', '101.1 resolveEffectiveSidebar: drawer < lg, rail default lg-xl, preference from xl, touch rules', () => {
    const { resolveEffectiveSidebar: r } = loadStore().mod;
    const base = { lg: true, xl: true, coarse: false, floatingPref: false, collapsedPref: false, collapsedExplicit: false };

    // Below lg: the drawer, whatever the stored preferences say.
    for (const prefs of [{}, { floatingPref: true }, { collapsedPref: true, collapsedExplicit: true }]) {
      const d = r({ ...base, lg: false, xl: false, ...prefs });
      assert.equal(d.presentation, 'drawer');
      assert.equal(d.isDrawer, true);
      assert.equal(d.floating || d.collapsed || d.resizable || d.canFloat, false);
    }
    // lg..xl: the rail unless the user chose otherwise.
    assert.equal(r({ ...base, xl: false }).presentation, 'collapsed');
    assert.equal(r({ ...base, xl: false }).resizable, false, 'no resize handle on the 64 px rail');
    assert.equal(r({ ...base, xl: false, collapsedExplicit: true, collapsedPref: false }).presentation, 'pinned');
    // xl+: the stored preference (pinned by default).
    assert.equal(r(base).presentation, 'pinned');
    assert.equal(r(base).resizable, true);
    assert.equal(r({ ...base, collapsedExplicit: true, collapsedPref: true }).presentation, 'collapsed');
    assert.equal(r({ ...base, floatingPref: true }).presentation, 'floating');
    assert.equal(r({ ...base, xl: false, floatingPref: true }).presentation, 'floating', 'floating wins over the rail default');
    // Touch: no floating, no mouse resize, no Float toggle.
    const touch = r({ ...base, coarse: true, floatingPref: true });
    assert.equal(touch.presentation, 'pinned');
    assert.equal(touch.floating, false);
    assert.equal(touch.resizable, false);
    assert.equal(touch.canFloat, false);
  });

  lotIt('W14-2', '101.2 uiStore: mobile nav never persisted, collapse toggles the effective state, exclusive modes', () => {
    // No stored choice: the rail is a width default, not a preference.
    let { mod, data } = loadStore();
    let s = mod.useUiStore.getState();
    assert.equal(s.mobileNavOpen, false);
    assert.equal(s.sidebarCollapsedExplicit, false);
    s.toggleMobileNav();
    assert.equal(mod.useUiStore.getState().mobileNavOpen, true);
    mod.useUiStore.getState().setMobileNavOpen(false);
    assert.equal(mod.useUiStore.getState().mobileNavOpen, false);
    assert.ok(![...data.keys()].some((k) => /mobile|nav/i.test(k)), 'the drawer state is never written to storage');

    // Expanding the default rail (effective collapsed = true) stores "false".
    mod.useUiStore.getState().toggleSidebarCollapsed(true);
    s = mod.useUiStore.getState();
    assert.equal(s.sidebarCollapsed, false);
    assert.equal(s.sidebarCollapsedExplicit, true);
    assert.equal(data.get('obli:sidebar-collapsed'), 'false');

    // Collapsing turns floating off (and the reverse).
    ({ mod, data } = loadStore({ 'og-sidebar-floating': 'true', 'obli:sidebar-collapsed': 'false' }));
    assert.equal(mod.useUiStore.getState().sidebarFloating, true);
    assert.equal(mod.useUiStore.getState().sidebarCollapsedExplicit, true);
    mod.useUiStore.getState().toggleSidebarCollapsed(false);
    s = mod.useUiStore.getState();
    assert.equal(s.sidebarCollapsed, true);
    assert.equal(s.sidebarFloating, false);
    assert.equal(data.get('og-sidebar-floating'), 'false');
    s.toggleSidebarFloating();
    s = mod.useUiStore.getState();
    assert.equal(s.sidebarFloating, true);
    assert.equal(s.sidebarCollapsed, false);
    assert.equal(data.get('obli:sidebar-collapsed'), 'false');

    // The hook reads the device through the shared media hooks.
    const src = code(STORE);
    assert.match(src, /export function useEffectiveSidebar\(\): EffectiveSidebar/);
    assert.match(src, /useLayoutMode\(\)/);
    assert.match(src, /useIsCoarsePointer\(\)/);
    assert.match(src, /useMediaQuery\(MEDIA\.xl\)/);
  });

  lotIt('W14-2', '101.3 AppLayout: dvh shell, Sidebar in a left Drawer below lg, closed on navigation', () => {
    const src = code(LAYOUT);
    assert.match(src, /className="flex h-dvh supports-\[not\(height:100dvh\)\]:h-screen flex-col overflow-hidden bg-bg-primary"/);
    assert.doesNotMatch(src, /"flex h-screen /, 'no bare h-screen shell');
    assert.match(src, /const sidebar = useEffectiveSidebar\(\);/);
    assert.match(src, /\{sidebar\.isDrawer \? null : sidebar\.floating \? \(/, 'no inline sidebar in drawer mode');
    assert.match(src, /width: sidebar\.collapsed \? '64px'/);
    assert.match(src, /sidebarOpen && sidebar\.resizable && \(/);
    // The drawer branch.
    assert.match(src, /import \{ Drawer \} from '@\/components\/common\/Drawer'/);
    const drawer = /\{sidebar\.isDrawer && \(\s*<Drawer([\s\S]*?)<\/Drawer>/.exec(src);
    assert.ok(drawer, 'Drawer rendered in drawer mode');
    assert.match(drawer[1], /open=\{mobileNavOpen\}/);
    assert.match(drawer[1], /onClose=\{closeMobileNav\}/);
    assert.match(drawer[1], /side="left"/);
    assert.match(drawer[1], /ariaLabel=\{t\(/);
    assert.match(drawer[1], /<Sidebar variant="drawer" onRequestClose=\{closeMobileNav\} \/>/);
    // Closes on every navigation and when the layout leaves drawer mode.
    assert.match(src, /useEffect\(\(\) => \{\s*setMobileNavOpen\(false\);\s*\}, \[location\.key, setMobileNavOpen\]\);/);
    assert.match(src, /if \(!sidebar\.isDrawer\) setMobileNavOpen\(false\);/);
    // Wide pages scroll inside main; safe-area padding.
    assert.match(src, /<main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-safe pb-safe">/);
    // Still exactly one IP drawer.
    assert.equal((src.match(/<IpDetailDrawer \/>/g) ?? []).length, 1);
  });

  lotIt('W14-2', '101.4 Sidebar: drawer variant, effective modes, touch drag and targets', () => {
    const src = code(SIDEBAR);
    assert.match(src, /export function Sidebar\(\{ variant = 'default', onRequestClose \}: SidebarProps = \{\}\)/);
    assert.match(src, /variant\?: 'default' \| 'drawer';/);
    assert.match(src, /const sidebarCollapsed = !inDrawer && effective\.collapsed;/, 'the drawer is always expanded');
    assert.match(src, /const sidebarFloating = !inDrawer && effective\.floating;/);
    assert.match(src, /const canFloat = !inDrawer && effective\.canFloat;/);
    assert.match(src, /toggleSidebarCollapsed\(sidebarCollapsed\)/, 'the toggle flips the effective state');
    assert.doesNotMatch(src, /onClick=\{toggleSidebarCollapsed\}/);
    // Close button in the drawer, Add agent closes the drawer first.
    assert.match(src, /\{inDrawer \? \(\s*<IconButton[\s\S]*?onClick=\{onRequestClose\}/);
    assert.match(src, /onRequestClose\?\.\(\);\s*openAddAgentModal\(\);/);
    assert.doesNotMatch(src, /onClick=\{openAddAgentModal\}/);
    assert.match(src, /\{canFloat && \(/, 'Float toggle only with a hovering pointer');
    // Touch: long-press drag so a swipe scrolls the drawer.
    assert.match(src, /useSensor\(TouchSensor, \{ activationConstraint: \{ delay: 250, tolerance: 5 \} \}\)/);
    assert.doesNotMatch(src, /PointerSensor/);
    assert.ok((src.match(/coarse:py-2\.5/g) ?? []).length >= 6, 'coarse targets on nav, agents, groups and the user block');
    // Drawer: search + tree scroll survive the close-on-navigation remount.
    assert.match(src, /let drawerUiCache: \{ key: string; search: string; scrollTop: number \} \| null = null;/);
    assert.match(src, /if \(inDrawer\) rememberDrawerUi\(drawerCacheKey, \{ search: value \}\);/);
    assert.match(src, /ref=\{treeScrollRef\} onScroll=\{handleTreeScroll\}/);
    // Desktop column clear of the tablet home indicator.
    assert.match(src, /<aside className="flex h-full w-16 shrink-0 flex-col bg-bg-secondary pb-safe">/);
    assert.match(src, /!inDrawer && 'pb-safe'/);
    // The drawer reuses existing i18n keys only.
    assert.match(src, /label=\{t\('common\.close', 'Close'\)\}/);
  });

  lotIt('W14-2', '101.5 Header: hamburger slot below lg, safe areas, app switcher and chips untouched', () => {
    const src = code(HEADER);
    assert.match(src, /const toggleMobileNav = useUiStore\(\(s\) => s\.toggleMobileNav\);/);
    const ham = /\{!isDesktop && \(\s*<IconButton([\s\S]*?)\/>\s*\)\}/.exec(src);
    assert.ok(ham, 'hamburger rendered below lg');
    assert.match(ham[1], /onClick=\{toggleMobileNav\}/);
    assert.match(ham[1], /aria-expanded=\{mobileNavOpen\}/);
    assert.match(ham[1], /aria-haspopup="dialog"/);
    assert.ok(src.indexOf('{!isDesktop && (') < src.indexOf('<Link to="/"'), 'the hamburger leads the topbar');
    assert.match(src, /pt-safe pl-\[max\(1rem,var\(--safe-left\)\)\] pr-\[max\(1rem,var\(--safe-right\)\)\]/);
    assert.match(src, /height: 'calc\(52px \+ var\(--safe-top, 0px\)\)'/);
    // App switcher (Obligate connected apps) and security chips logic intact.
    assert.match(src, /const CURRENT_APP = 'obliguard';/);
    assert.match(src, /fetch\('\/api\/auth\/connected-apps', \{ credentials: 'include' \}\)/);
    assert.match(src, /const hasSelf = connectedApps\.some\(a => a\.self === true \|\| a\.appType === CURRENT_APP\);/);
    assert.match(src, /new URL\(`\$\{target\.baseUrl\}\/auth\/sso-redirect`\)/);
    assert.match(src, /\{switcherApps\.map\(\(app\) => \{/);
    assert.match(src, /'\/bans\/stats'/);
    assert.match(src, /params: \{ status: 'suspicious', limit: 1 \}/);
    assert.match(src, /setInterval\(\(\) => \{ void fetchChipData\(\); \}, 60_000\)/);
  });

  lotIt('W14-2', '101.6 TenantSwitcher: phone bottom sheet, pointer and Escape dismissal, favourite kept', () => {
    const src = code(TENANT);
    assert.match(src, /const isPhone = useLayoutMode\(\) === 'phone';/);
    assert.match(src, /const dropdownOpen = open && !isPhone;/);
    assert.match(src, /useClickOutside\(\[panelRef, buttonRef\], \(\) => setOpen\(false\), dropdownOpen\);/);
    assert.match(src, /useNativeBack\([\s\S]*?, dropdownOpen, \{ escape: true \}\);/);
    assert.doesNotMatch(src, /addEventListener\('mousedown'/, 'no mouse-only outside listener');
    const sheet = /<Drawer([\s\S]*?)<\/Drawer>/.exec(src);
    assert.ok(sheet, 'phone sheet');
    assert.match(sheet[1], /open=\{open && isPhone\}/);
    assert.match(sheet[1], /side="bottom"/);
    assert.match(sheet[1], /renderRows\(true\)/);
    assert.match(src, /\{dropdownOpen && \(/);
    assert.match(src, /setDefaultTenant\(preferredTenantId === tenantId \? null : tenantId\)/, 'favourite workspace kept');
    assert.match(src, /coarse:opacity-100/, 'favourite star visible without hover');
    assert.match(src, /if \(tenantId === currentTenantId\) \{ setOpen\(false\); return; \}/, 're-picking the current workspace closes the sheet');
  });
});
