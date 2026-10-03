/**
 * 58 — W5-3 UI kit, layout and data primitives (client side, static checks):
 *   - the kit files exist with the Obliance API names (PageContainer,
 *     SegmentedTabs, TableScroll, usePersistedState, useSessionState,
 *     utils/download) plus the Obliguard additions (PageHeader, Pagination,
 *     SortableTh, TableSkeleton, EmptyState, useTabParam, useRowSelection,
 *     useSocketRefresh);
 *   - the components carry no page-specific logic (no api / store / page
 *     imports) and their strings go through t('common.…', { defaultValue });
 *   - SegmentedTabs is an accessible tablist (role=tab, aria-selected, roving
 *     tabindex, arrow / Home / End keys, hidden tabs filtered out);
 *   - the pure helpers behave: pagination range, tri-state sort cycle,
 *     header checkbox state on visible rows, ?tab= resolution, CSV escaping
 *     with formula neutralisation;
 *   - index.css ports --c-accent-as-text + the obli-dim remaps, the safe-area
 *     and table-sticky-first utilities; index.html has the mobile viewport
 *     and theme-color metas and keeps the og- FOUC script.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const COMPONENTS = [
  'PageContainer', 'PageHeader', 'SegmentedTabs', 'TableScroll',
  'Pagination', 'SortableTh', 'TableSkeleton', 'EmptyState',
] as const;
const HOOKS = ['useTabParam', 'usePersistedState', 'useSessionState', 'useRowSelection', 'useSocketRefresh'] as const;

/**
 * Transpile a client module and evaluate it with stubbed imports (only the
 * pure, exported helpers are exercised; React components are never rendered).
 */
function loadClientModule(rel: string): Record<string, any> {
  const src = read(rel);
  const js = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: path.basename(rel),
  }).outputText;
  const mod: { exports: Record<string, any> } = { exports: {} };
  const stub = () => new Proxy({}, { get: (_t, key) => (key === '__esModule' ? true : () => null) });
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', js)(mod.exports, mod, stub);
  return mod.exports;
}

describe('58 UI kit layout and data primitives (W5-3)', () => {
  lotIt('W5-3', '58.1 kit files exist with the Obliance API names', () => {
    for (const name of COMPONENTS) {
      const src = read(`client/src/components/common/${name}.tsx`);
      assert.match(src, new RegExp(`export (const|function) ${name}\\b`), `${name} exported`);
    }
    for (const name of HOOKS) {
      const src = read(`client/src/hooks/${name}.ts`);
      assert.match(src, new RegExp(`export function ${name}\\b`), `${name} exported`);
    }
    const dl = read('client/src/utils/download.ts');
    for (const fn of ['saveBlob', 'saveText', 'saveJson', 'downloadUrl', 'saveCsv', 'toCsv']) {
      assert.match(dl, new RegExp(`export (async )?function ${fn}\\b`), `download.${fn}`);
    }
    assert.doesNotMatch(dl, /native\/bridge|canUseNative/, 'no native branch in download.ts');
    // PageContainer keeps the Obliance padding scale and the embedded escape hatch.
    const pc = read('client/src/components/common/PageContainer.tsx');
    assert.ok(pc.includes("'p-3 sm:p-4 lg:p-6'"), 'PageContainer padding p-3 sm:p-4 lg:p-6');
    assert.match(pc, /embedded\?: boolean/);
    // One title size on every page.
    assert.ok(read('client/src/components/common/PageHeader.tsx').includes('text-xl font-semibold text-text-primary sm:text-2xl'));
    // TableScroll scrolls instead of clipping, with the sticky-first opt-in.
    const tsx = read('client/src/components/common/TableScroll.tsx');
    assert.ok(tsx.includes('overflow-x-auto overscroll-x-contain'));
    assert.ok(tsx.includes("stickyFirstCol && 'table-sticky-first'"));
  });

  lotIt('W5-3', '58.2 components carry no page logic; strings go through t(common.*, { defaultValue })', () => {
    for (const name of [...COMPONENTS].map((n) => `client/src/components/common/${n}.tsx`)
      .concat([...HOOKS].map((n) => `client/src/hooks/${n}.ts`))) {
      // Comments hold usage examples with page keys: scan the code only.
      const src = read(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const imports = [...src.matchAll(/^import [^;]*? from '([^']+)';/gm)].map((m) => m[1]);
      for (const spec of imports) {
        assert.doesNotMatch(spec, /(^|\/)(api|pages)(\/|$)|\.api$|authStore|tenantStore|agentStore|groupStore/, `${name}: page-specific import ${spec}`);
      }
      for (const call of src.matchAll(/\bt\(\s*'([^']+)'(\s*,\s*\{[^)]*)?\)/g)) {
        assert.match(call[1], /^common\./, `${name}: key ${call[1]} under common.*`);
        assert.match(call[2] ?? '', /defaultValue:/, `${name}: ${call[1]} has a defaultValue`);
      }
    }
    // JSX text nodes: no hard-coded English words in the kit.
    for (const name of COMPONENTS) {
      const src = read(`client/src/components/common/${name}.tsx`);
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(code, />\s*[A-Z][a-z]+(\s+[a-z]+)+\s*</, `${name}: hard-coded UI text`);
    }
  });

  lotIt('W5-3', '58.3 SegmentedTabs is an accessible tablist', () => {
    const src = read('client/src/components/common/SegmentedTabs.tsx');
    assert.ok(src.includes('role="tablist"'));
    assert.ok(src.includes('role="tab"'));
    assert.ok(src.includes('aria-selected={selected}'));
    assert.ok(src.includes('tabIndex={tab.id === focusId ? 0 : -1}'), 'roving tabindex');
    assert.ok(src.includes('visible.find((tab) => !tab.disabled)?.id'), 'a Tab stop remains when the value is not a visible tab');
    assert.ok(src.includes('tabs.filter((tab) => !tab.hidden)'), 'hidden tabs filtered out');
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.ok(src.includes(`'${key}'`), `key ${key}`);
    assert.match(src, /badge\?: ReactNode/);
    const th = read('client/src/components/common/SortableTh.tsx');
    assert.ok(th.includes('aria-sort={ariaSort}'));
    assert.ok(th.includes("'ascending'") && th.includes("'descending'") && th.includes("'none'"));
  });

  lotIt('W5-3', '58.4 pure helpers: pagination, sort cycle, selection, tab param, CSV', () => {
    const { paginationRange } = loadClientModule('client/src/components/common/Pagination.tsx');
    assert.deepEqual(paginationRange(1, 50, 120), { from: 1, to: 50, pageCount: 3, hasPrev: false, hasNext: true });
    assert.deepEqual(paginationRange(3, 50, 120), { from: 101, to: 120, pageCount: 3, hasPrev: true, hasNext: false });
    assert.deepEqual(paginationRange(1, 50, 0), { from: 0, to: 0, pageCount: 1, hasPrev: false, hasNext: false });
    assert.deepEqual(paginationRange(2, 25, undefined, true), { from: 26, to: 50, pageCount: null, hasPrev: true, hasNext: true });
    assert.deepEqual(paginationRange(2, 25, undefined, false, 7), { from: 26, to: 32, pageCount: null, hasPrev: true, hasNext: false });
    // A page past the end (rows deleted meanwhile) shows 0–0, never "0–n".
    assert.deepEqual(paginationRange(4, 50, 120), { from: 0, to: 0, pageCount: 3, hasPrev: true, hasNext: false });
    assert.deepEqual(paginationRange(3, 25, undefined, false, 0), { from: 0, to: 0, pageCount: null, hasPrev: true, hasNext: false });

    const { nextSort } = loadClientModule('client/src/components/common/SortableTh.tsx');
    assert.deepEqual(nextSort(null, 'ip'), { field: 'ip', dir: 'asc' });
    assert.deepEqual(nextSort({ field: 'ip', dir: 'asc' }, 'ip'), { field: 'ip', dir: 'desc' });
    assert.equal(nextSort({ field: 'ip', dir: 'desc' }, 'ip'), null);
    assert.deepEqual(nextSort({ field: 'ip', dir: 'desc' }, 'count'), { field: 'count', dir: 'asc' });

    const sel = loadClientModule('client/src/hooks/useRowSelection.ts');
    assert.equal(sel.selectionHeaderState(new Set(), []), 'unchecked');
    assert.equal(sel.selectionHeaderState(new Set(['a']), ['a', 'b']), 'indeterminate');
    assert.equal(sel.selectionHeaderState(new Set(['a', 'b', 'z']), ['a', 'b']), 'checked');
    assert.equal(sel.selectionHeaderState(new Set(['z']), ['a', 'b']), 'unchecked', 'computed on visible rows only');
    assert.deepEqual([...sel.toggleVisibleSelection(new Set(['z', 'a']), ['a', 'b'])].sort(), ['a', 'b', 'z']);
    assert.deepEqual([...sel.toggleVisibleSelection(new Set(['z', 'a', 'b']), ['a', 'b'])], ['z'], 'hidden rows untouched');
    // The reset key sees Set-based filters (plain JSON.stringify makes every Set "{}").
    assert.notEqual(sel.selectionResetKey([{ status: new Set(['banned']) }, 1]), sel.selectionResetKey([{ status: new Set(['clean']) }, 1]));
    assert.equal(sel.selectionResetKey([new Set(['b', 'a'])]), sel.selectionResetKey([new Set(['a', 'b'])]));
    assert.notEqual(sel.selectionResetKey([{ q: 'x' }, 1]), sel.selectionResetKey([{ q: 'x' }, 2]), 'page change resets');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    assert.equal(typeof sel.selectionResetKey(cyclic), 'string', 'never throws');

    const { resolveTab } = loadClientModule('client/src/hooks/useTabParam.ts');
    const tabs = ['activity', 'bans', 'whitelist'];
    assert.equal(resolveTab('bans', tabs, 'activity'), 'bans');
    assert.equal(resolveTab(null, tabs, 'activity'), 'activity');
    assert.equal(resolveTab('remote', tabs, 'activity'), 'activity', 'a tab outside the allowed list falls back');
    const hook = read('client/src/hooks/useTabParam.ts');
    assert.ok(hook.includes('useSearchParams'), 'synced through useSearchParams');

    const { csvField, toCsv } = loadClientModule('client/src/utils/download.ts');
    assert.equal(csvField('plain'), 'plain');
    assert.equal(csvField('a,b'), '"a,b"');
    assert.equal(csvField('say "hi"'), '"say ""hi"""');
    assert.equal(csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`, 'formula neutralised');
    assert.equal(csvField('@admin'), "'@admin");
    assert.equal(csvField('-1+2'), "'-1+2");
    assert.equal(csvField(-5), '-5', 'numbers are not formulas');
    assert.equal(csvField(null), '');
    assert.equal(csvField(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z');
    assert.equal(toCsv(['ip', 'count'], [['1.2.3.4', 3], ['line\nbreak', null]]), 'ip,count\r\n1.2.3.4,3\r\n"line\nbreak",\r\n');
  });

  lotIt('W5-3', '58.5 hooks: persisted / session state, row selection reset, socket refresh', () => {
    const persisted = read('client/src/hooks/usePersistedState.ts');
    assert.ok(persisted.includes('localStorage.getItem(key)') && persisted.includes('localStorage.setItem(key'));
    const session = read('client/src/hooks/useSessionState.ts');
    assert.ok(session.includes('sessionStorage') && session.includes('__set'), 'Sets round-trip');
    const rows = read('client/src/hooks/useRowSelection.ts');
    assert.match(rows, /resetKey\?: unknown/, 'auto-clear on a deps key');
    const refresh = read('client/src/hooks/useSocketRefresh.ts');
    assert.ok(refresh.includes('s.generation'), 're-binds on a new socket instance');
    assert.ok(refresh.includes('SOCKET_RESYNC_EVENT'), 'refetches after a reconnect');
    assert.ok(refresh.includes('socket.off(name, schedule)'), 'removes only its own handlers');
    assert.ok(refresh.includes('clearTimeout(timer)'), 'debounced, cancelled on unmount');
  });

  lotIt('W5-3', '58.6 theme tokens, utilities layer and index.html metas', () => {
    const css = read('client/src/index.css').replace(/\r\n/g, '\n');
    assert.match(css, /:root \{\n\s+--c-accent-as-text:\s+var\(--c-accent\);/, ':root accent-as-text');
    assert.match(css, /\[data-theme="obli-dim"\] \{\n\s+--c-accent-as-text:\s+\d+ \d+ \d+;/, 'obli-dim accent-as-text');
    assert.ok(css.includes('[data-theme="obli-dim"] .text-accent,'), 'obli-dim text-accent remap');
    const utilities = /@layer utilities \{([\s\S]*?)\n\}/.exec(css);
    assert.ok(utilities, '@layer utilities');
    for (const cls of ['.px-safe', '.pb-safe', '.pt-safe', '.scrollbar-none']) assert.ok(utilities[1].includes(cls), `utility ${cls}`);
    assert.match(css, /--safe-bottom:\s+env\(safe-area-inset-bottom, 0px\);/);
    assert.match(css, /\.table-sticky-first tr > :first-child \{[^}]*position: sticky;[^}]*var\(--table-sticky-bg, rgb\(var\(--c-bg-secondary\)\)\)/);

    const html = read('client/index.html');
    assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*interactive-widget=resizes-content[^"]*" \/>/);
    assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" \/>/i);
    assert.ok(html.includes("localStorage.getItem('og-theme')"), 'og- storage key and FOUC script kept');
  });
});
