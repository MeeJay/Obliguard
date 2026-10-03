/**
 * 58 — W5-2 UI kit core (client, mirrored from Obliance components/common):
 *   - the kit files exist, compile against Obliguard (no '@obliance/shared'),
 *     and every user-visible string goes through t('common.*', default);
 *   - native/bridge.ts (web stub): the back / Escape stack runs the top-most
 *     Escape-enabled handler only, `false` falls through, unregister pops,
 *     and the native capabilities report unavailable (BackHandler exported);
 *   - overlays (Modal, Drawer, ActionMenu popover, Tip) register for Escape,
 *     MasterDetail does not (page-level, Android back only); Modal and Drawer
 *     trap focus;
 *   - ConfirmDialog with requireText keeps the confirm button disabled (and
 *     Enter inert) until the typed text matches exactly;
 *   - overlay.ts computePopoverPosition flips / clamps inside the viewport;
 *   - tailwind declares the coarse / can-hover variants and the sheet
 *     animations; App.tsx mounts <ConfirmProvider />.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const KIT_FILES = [
  'client/src/hooks/useMediaQuery.ts',
  'client/src/hooks/useClickOutside.ts',
  'client/src/hooks/useNativeBack.ts',
  'client/src/native/overlay.ts',
  'client/src/native/bridge.ts',
  'client/src/components/common/IconButton.tsx',
  'client/src/components/common/Modal.tsx',
  'client/src/components/common/Drawer.tsx',
  'client/src/components/common/ConfirmDialog.tsx',
  'client/src/components/common/Tip.tsx',
  'client/src/components/common/ToggleSwitch.tsx',
  'client/src/components/common/ActionMenu.tsx',
  'client/src/components/common/MasterDetail.tsx',
];

/** Transpile a client module to CommonJS and evaluate it with a fake `window` (imports resolve to {}). */
function loadClientModule(rel: string, fakeWindow: unknown): Record<string, any> {
  const js = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod: { exports: Record<string, any> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', 'window', js)(mod.exports, mod, () => ({}), fakeWindow);
  return mod.exports;
}

interface FakeKey { key: string; defaultPrevented: boolean; isComposing: boolean; preventDefault(): void }

function fakeWindow() {
  const listeners = new Map<string, Array<(e: FakeKey) => void>>();
  return {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener(type: string, fn: (e: FakeKey) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener() { /* unused */ },
    keydown(key: string): FakeKey {
      const e: FakeKey = {
        key,
        defaultPrevented: false,
        isComposing: false,
        preventDefault() { this.defaultPrevented = true; },
      };
      for (const fn of listeners.get('keydown') ?? []) fn(e);
      return e;
    },
    listenerCount: (type: string) => (listeners.get(type) ?? []).length,
  };
}

describe('58 UI kit core (W5-2)', () => {
  lotIt('W5-2', '58.1 kit files exist, Obliguard imports, strings via t(common.*, default)', () => {
    for (const rel of KIT_FILES) {
      assert.ok(fs.existsSync(path.join(REPO, rel)), `${rel} exists`);
      const src = read(rel);
      assert.doesNotMatch(src, /@obliance\/shared/, `${rel} imports @obliview/shared, not @obliance/shared`);
      // Doc-comment usage examples are not rendered strings.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of code.matchAll(/\bt\(\s*'([^']+)'([^)]*)/g)) {
        const [, key, rest] = m;
        assert.match(key, /^common\./, `${rel}: i18n key ${key} lives under common.*`);
        assert.match(rest, /^\s*,\s*('|\{[^}]*defaultValue)/, `${rel}: t('${key}') carries a default value`);
      }
    }
    assert.match(read('client/src/native/bridge.ts'), /export type BackHandler\b/, 'bridge exports type BackHandler (useNativeBack imports it)');
  });

  lotIt('W5-2', '58.2 bridge stub: Escape runs the top-most Escape-enabled handler only', () => {
    const win = fakeWindow();
    const bridge = loadClientModule('client/src/native/bridge.ts', win);
    assert.equal(bridge.canUseNative('saveFile'), false);
    assert.equal(bridge.isAndroidApp(), false);
    assert.deepEqual(Object.keys(bridge.native), []);

    const calls: string[] = [];
    const offPage = bridge.registerBackHandler(() => { calls.push('page'); });
    assert.equal(win.listenerCount('keydown'), 1, 'Escape dispatcher installed lazily');
    const offOuter = bridge.registerBackHandler((s: string) => { calls.push(`outer:${s}`); }, { escape: true });
    const offInner = bridge.registerBackHandler((s: string) => { calls.push(`inner:${s}`); }, { escape: true });
    bridge.registerBackHandler(() => { calls.push('noop'); }); // not Escape-enabled: transparent to Escape
    // Registering more handlers never installs a second dispatcher.
    assert.equal(win.listenerCount('keydown'), 1);

    const e1 = win.keydown('Escape');
    assert.deepEqual([...calls], ['inner:escape'], 'only the top-most Escape-enabled overlay reacts');
    assert.equal(e1.defaultPrevented, true);

    offInner();
    calls.length = 0;
    win.keydown('Escape');
    assert.deepEqual([...calls], ['outer:escape'], 'after the top overlay closes, the next one gets Escape');

    calls.length = 0;
    win.keydown('Enter');
    assert.deepEqual([...calls], [], 'other keys are ignored');

    offOuter();
    calls.length = 0;
    const e2 = win.keydown('Escape');
    assert.deepEqual([...calls], [], 'page-level (non-Escape) handlers never receive Escape');
    assert.equal(e2.defaultPrevented, false, 'unconsumed Escape is not prevented');

    // Back walks every entry; `false` falls through to the previous one.
    const off2 = bridge.registerBackHandler(() => { calls.push('pass'); return false; }, { escape: true });
    calls.length = 0;
    assert.equal(bridge.handleNativeBack(), true);
    assert.deepEqual([...calls], ['pass', 'noop']);
    off2();
    offPage();
    off2(); // idempotent
    assert.equal(bridge.backStackDepth(), 1);
  });

  lotIt('W5-2', '58.3 overlays: Escape registration, focus trap, MasterDetail page-level only', () => {
    for (const name of ['Modal', 'Drawer']) {
      const src = read(`client/src/components/common/${name}.tsx`);
      assert.match(src, /useNativeBack\([\s\S]*?\{ escape: true \}\);/, `${name} closes on Escape`);
      assert.match(src, /useFocusTrap\(panelRef, true\)/, `${name} traps focus`);
      assert.match(src, /useBodyScrollLock\(true\)/, `${name} locks body scroll`);
      assert.match(src, /aria-modal="true"/);
      assert.match(src, /createPortal\(/);
    }
    assert.match(read('client/src/components/common/ActionMenu.tsx'), /popoverOpen, \{ escape: true \}\)/);
    assert.match(read('client/src/components/common/Tip.tsx'), /useNativeBack\(\(\) => setOpen\(false\), active, \{ escape: true \}\)/);
    assert.doesNotMatch(read('client/src/components/common/MasterDetail.tsx'), /escape: true/, 'MasterDetail stack mode is Android-back only');
    assert.match(read('client/src/hooks/useNativeBack.ts'), /import \{ registerBackHandler, type BackHandler \} from '@\/native\/bridge'/);

    // Focus trap wraps Tab / Shift+Tab inside the panel and restores focus.
    const overlay = read('client/src/native/overlay.ts');
    assert.match(overlay, /if \(e\.key !== 'Tab'\) return;/);
    assert.match(overlay, /e\.shiftKey && \(activeEl === first \|\| activeEl === current\)/);
    assert.match(overlay, /prev\.focus\(\{ preventScroll: true \}\)/);
  });

  lotIt('W5-2', '58.4 ConfirmDialog: requireText gates the confirm button', () => {
    const src = read('client/src/components/common/ConfirmDialog.tsx');
    assert.match(src, /:\s*!requireText \|\| value === requireText;/, 'confirm enabled only on an exact match');
    assert.match(src, /disabled=\{!canConfirm\}/, 'confirm button disabled until canConfirm');
    assert.match(src, /const accept = \(\) => \{\s*if \(!canConfirm\) return;/, 'Enter / click cannot bypass the gate');
    for (const api of ['ConfirmProvider', 'useConfirm', 'usePrompt', 'confirmDialog', 'promptDialog']) {
      assert.match(src, new RegExp(`export function ${api}\\b`), `exports ${api}`);
    }
    assert.match(src, /t\('common\.typeToConfirm'/);

    const app = read('client/src/App.tsx');
    assert.match(app, /import \{ ConfirmProvider \} from '@\/components\/common\/ConfirmDialog';/);
    assert.match(app, /<Toaster[\s\S]*?\/>\s*[\s\S]{0,200}<ConfirmProvider \/>/, 'ConfirmProvider mounted next to the Toaster');
  });

  lotIt('W5-2', '58.5 popover positioning flips and clamps inside the viewport', () => {
    const win = fakeWindow();
    const { computePopoverPosition } = loadClientModule('client/src/native/overlay.ts', win);
    const rect = (left: number, top: number, w: number, h: number) =>
      ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top }) as unknown;

    // Room below: stays at the bottom, right edges aligned (align 'end').
    const below = computePopoverPosition(rect(500, 100, 40, 30), 200, 150);
    assert.equal(below.placement, 'bottom');
    assert.equal(below.top, 136);
    assert.equal(below.left, 340);

    // Near the bottom edge: flips above.
    const above = computePopoverPosition(rect(500, 700, 40, 30), 200, 150);
    assert.equal(above.placement, 'top');
    assert.equal(above.top, 700 - 6 - 150);

    // Near the left edge with align 'end': clamped to the margin.
    const clamped = computePopoverPosition(rect(10, 100, 40, 30), 200, 150);
    assert.equal(clamped.left, 8);
    // Near the right edge with align 'start': clamped to vw - margin - width.
    const right = computePopoverPosition(rect(950, 100, 40, 30), 200, 150, { align: 'start' });
    assert.equal(right.left, 1000 - 8 - 200);
  });

  lotIt('W5-2', '58.6 tailwind: coarse / can-hover variants and sheet animations', () => {
    const tw = read('client/tailwind.config.ts');
    assert.match(tw, /import plugin from 'tailwindcss\/plugin';/);
    assert.match(tw, /addVariant\('coarse', '@media \(pointer: coarse\)'\)/);
    assert.match(tw, /addVariant\('can-hover', '@media \(hover: hover\) and \(pointer: fine\)'\)/);
    for (const anim of ['obli-slide-in-left', 'obli-slide-in-right', 'obli-slide-in-up']) {
      assert.match(tw, new RegExp(`'${anim}':\\s+'${anim} `), `animation ${anim}`);
    }

    // hoverOnlyWhenSupported turns `opacity-0 group-hover:opacity-100` row
    // actions into permanently invisible buttons on touch screens: it may only
    // be enabled once no page relies on that hover-reveal pattern any more.
    if (/hoverOnlyWhenSupported\s*:\s*true/.test(tw)) {
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (/\.tsx$/.test(ent.name)) {
            read(path.relative(REPO, p)).split('\n').forEach((line, i) => {
              if (/opacity-0[^"'`]*group-hover:opacity-100/.test(line) && !/can-hover:/.test(line)) {
                offenders.push(`${path.relative(REPO, p)}:${i + 1}`);
              }
            });
          }
        }
      };
      walk(path.join(REPO, 'client/src'));
      assert.deepEqual(offenders, [], 'hover-reveal without a can-hover: fallback under hoverOnlyWhenSupported');
    }
  });
});
