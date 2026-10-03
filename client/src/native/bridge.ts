/**
 * Native shell bridge — minimal web stub of Obliance's client/src/native/bridge.ts.
 *
 * Obliguard has no Android shell (yet), so every native capability reports
 * "unavailable". What IS implemented is the back-handler stack the UI kit
 * relies on (useNativeBack → Modal, Drawer, ConfirmDialog, ActionMenu, Tip,
 * MasterDetail): overlays register a handler while open, and the Escape key
 * runs the top-most Escape-enabled handler only, so stacked overlays close
 * one at a time. The API mirrors Obliance so a real bridge can replace this
 * file without touching its callers.
 */

// ── Capabilities (always unavailable on the web) ─────────────────────────────

export type NativeCapability =
  | 'saveFile'
  | 'downloadUrl'
  | 'openExternal'
  | 'clipboard'
  | 'share'
  | 'notify'
  | 'settings'
  | 'back'
  | 'systemBars'
  | 'update';

/** True when running inside an Obli native shell — never, in Obliguard. */
export function isAndroidApp(): boolean {
  return false;
}

/** True when the shell advertises capability `c` — always false without a shell. */
export function hasCapability(_c: NativeCapability): boolean {
  return false;
}

/** True when `native.<method>` can be called — always false without a shell. */
export function canUseNative(_method: string): boolean {
  return false;
}

/** True for touch-first devices (primary pointer is coarse). Not reactive — use useIsCoarsePointer() in components. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/** Native method wrappers. Empty: guard every use with canUseNative(). */
export const native = {} as const;

// ── Back / Escape handler stack ──────────────────────────────────────────────

/**
 * A back handler. `source` tells whether the (native) back button or the
 * Escape key triggered it. Return `false` to let the event fall through to
 * the next handler; anything else consumes it.
 */
export type BackHandler = (source: 'back' | 'escape') => boolean | void;

export interface BackHandlerOptions {
  /**
   * Also receive the Escape key. Escape walks the stack from the top but only
   * visits Escape-enabled entries (others are transparent to it), so stacked
   * overlays close one at a time. Default false.
   */
  escape?: boolean;
}

interface BackEntry {
  handler: BackHandler;
  escape: boolean;
}

const backStack: BackEntry[] = [];

/**
 * Push a back handler on the stack (most recent wins). Returns the unregister
 * function. Prefer the `useNativeBack()` hook in components.
 */
export function registerBackHandler(handler: BackHandler, options?: BackHandlerOptions): () => void {
  // Lazy install: the Escape dispatcher exists as soon as anything listens.
  installBackHandler();
  const entry: BackEntry = { handler, escape: !!options?.escape };
  backStack.push(entry);
  return () => {
    const i = backStack.indexOf(entry);
    if (i >= 0) backStack.splice(i, 1);
  };
}

function runStack(source: 'back' | 'escape'): boolean {
  // Snapshot: a handler may unregister itself (closing a modal) while we iterate.
  const entries = backStack.slice().reverse();
  for (const entry of entries) {
    if (source === 'escape' && !entry.escape) continue;
    let result: boolean | void;
    try {
      result = entry.handler(source);
    } catch (err) {
      console.error(`[obli-native] ${source} handler failed`, err);
      result = true;
    }
    if (result !== false) return true;
  }
  return false;
}

/** Run the back stack from the most recent handler down. Returns true when one consumed the press. */
export function handleNativeBack(): boolean {
  return runStack('back');
}

/** Number of registered back handlers. */
export function backStackDepth(): number {
  return backStack.length;
}

function onEscapeKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  if (runStack('escape')) e.preventDefault();
}

let backInstalled = false;

/**
 * Install the global Escape dispatcher for Escape-enabled entries.
 * Idempotent; registerBackHandler() calls it, main.tsx may call it at boot.
 */
export function installBackHandler(): void {
  if (typeof window === 'undefined' || backInstalled) return;
  backInstalled = true;
  // Bubble phase on window: React handlers (and inputs/comboboxes that call
  // preventDefault on Escape) run first.
  window.addEventListener('keydown', onEscapeKey);
}
