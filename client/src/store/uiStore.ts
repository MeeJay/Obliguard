import { create } from 'zustand';
import { MEDIA, useIsCoarsePointer, useLayoutMode, useMediaQuery } from '@/hooks/useMediaQuery';

interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarFloating: boolean;
  /** Obli Design v1: sidebar shrinks to 64 px icon-only column instead of
   *  hiding entirely. Persisted under a shared key so the choice survives
   *  cross-app navigation across the Obli* suite. */
  sidebarCollapsed: boolean;
  /** True once the user picked collapsed / expanded (the shared key exists).
   *  Without an explicit choice the rail is the default between 1024 and
   *  1279 px (see useEffectiveSidebar). */
  sidebarCollapsedExplicit: boolean;
  /** Off-canvas navigation drawer used below 1024 px. Forced by the layout
   *  mode, so it is NEVER persisted. */
  mobileNavOpen: boolean;
  addAgentModalOpen: boolean;

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  toggleSidebarFloating: () => void;
  /** Flips the collapsed preference. Pass the EFFECTIVE state shown on screen
   *  (useEffectiveSidebar().collapsed) so the default rail of the 1024-1279 px
   *  range expands on the first click. */
  toggleSidebarCollapsed: (current?: boolean) => void;
  setMobileNavOpen: (open: boolean) => void;
  toggleMobileNav: () => void;
  openAddAgentModal: () => void;
  closeAddAgentModal: () => void;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 600;
// Storage keys — Obliguard prefix `og-` for app-specific state.
// `obli:sidebar-collapsed` is shared across the Obli* suite per design spec §6.
const STORAGE_KEY_WIDTH     = 'og-sidebar-width';
const STORAGE_KEY_FLOATING  = 'og-sidebar-floating';
const STORAGE_KEY_COLLAPSED = 'obli:sidebar-collapsed';

function loadSavedWidth(): number {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (saved) {
      const w = parseInt(saved, 10);
      if (!isNaN(w) && w >= MIN_SIDEBAR_WIDTH && w <= MAX_SIDEBAR_WIDTH) return w;
    }
  } catch {
    // localStorage unavailable
  }
  return 280;
}

function loadSavedFloating(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_FLOATING) === 'true';
  } catch {
    return false;
  }
}

/** Stored collapsed preference: null when the user never chose. */
function loadSavedCollapsed(): boolean | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_COLLAPSED);
    return saved === null ? null : saved === 'true';
  } catch {
    return null;
  }
}

const savedCollapsed = loadSavedCollapsed();

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: true,
  sidebarWidth: loadSavedWidth(),
  sidebarFloating: loadSavedFloating(),
  sidebarCollapsed: savedCollapsed === true,
  sidebarCollapsedExplicit: savedCollapsed !== null,
  mobileNavOpen: false,
  addAgentModalOpen: false,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
  toggleMobileNav: () => set((s) => ({ mobileNavOpen: !s.mobileNavOpen })),
  openAddAgentModal: () => set({ addAgentModalOpen: true }),
  closeAddAgentModal: () => set({ addAgentModalOpen: false }),
  // Floating and collapsed are mutually exclusive — toggling one ON forces
  // the other OFF (and persists both).
  toggleSidebarFloating: () => set((s) => {
    const next = !s.sidebarFloating;
    try {
      localStorage.setItem(STORAGE_KEY_FLOATING, String(next));
      if (next) localStorage.setItem(STORAGE_KEY_COLLAPSED, 'false');
    } catch { /* ignore */ }
    return next
      ? { sidebarFloating: true, sidebarCollapsed: false, sidebarCollapsedExplicit: true }
      : { sidebarFloating: false };
  }),
  toggleSidebarCollapsed: (current) => set((s) => {
    const next = !(current ?? s.sidebarCollapsed);
    try {
      localStorage.setItem(STORAGE_KEY_COLLAPSED, String(next));
      if (next) localStorage.setItem(STORAGE_KEY_FLOATING, 'false');
    } catch { /* ignore */ }
    return {
      sidebarCollapsed: next,
      sidebarCollapsedExplicit: true,
      sidebarFloating: next ? false : s.sidebarFloating,
    };
  }),
  setSidebarWidth: (width) => {
    const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
    try {
      localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped));
    } catch {
      // localStorage unavailable
    }
    set({ sidebarWidth: clamped });
  },
}));

// ── Effective sidebar presentation (Obliance uiStore) ───────────────────────

export type SidebarPresentation = 'drawer' | 'pinned' | 'collapsed' | 'floating';

export interface EffectiveSidebar {
  presentation: SidebarPresentation;
  /** Below 1024 px: the sidebar lives in an off-canvas Drawer (hamburger). */
  isDrawer: boolean;
  /** Auto-hide (hover strip) mode actually in use. */
  floating: boolean;
  /** 64 px icon rail actually in use. */
  collapsed: boolean;
  /** Mouse resize handles are offered. */
  resizable: boolean;
  /** The Float / Pin toggle is offered (it needs a hovering pointer). */
  canFloat: boolean;
}

/** Inputs of resolveEffectiveSidebar (the device + the stored preferences). */
export interface EffectiveSidebarInput {
  /** ≥ 1024 px. */
  lg: boolean;
  /** ≥ 1280 px. */
  xl: boolean;
  /** Touch-first pointer. */
  coarse: boolean;
  floatingPref: boolean;
  collapsedPref: boolean;
  /** The collapsed preference was set by the user (else: width default). */
  collapsedExplicit: boolean;
}

/**
 * Pure resolution of the shell's sidebar mode:
 *  - below 1024 px: off-canvas drawer (hamburger in the Header);
 *  - 1024-1279 px: the 64 px rail unless the user chose otherwise;
 *  - 1280 px and up: the stored preference (pinned by default).
 * Floating opens on mouse-enter of an 8 px edge strip: unusable (and in the
 * Android back-gesture zone) on a touch screen, so it falls back to pinned
 * there, and the mouse resize handle is not offered either.
 */
export function resolveEffectiveSidebar(input: EffectiveSidebarInput): EffectiveSidebar {
  if (!input.lg) {
    return {
      presentation: 'drawer',
      isDrawer: true,
      floating: false,
      collapsed: false,
      resizable: false,
      canFloat: false,
    };
  }
  const floating = input.floatingPref && !input.coarse;
  const collapsedWanted = input.collapsedExplicit ? input.collapsedPref : !input.xl;
  const collapsed = collapsedWanted && !floating;
  return {
    presentation: floating ? 'floating' : collapsed ? 'collapsed' : 'pinned',
    isDrawer: false,
    floating,
    collapsed,
    resizable: !input.coarse && !collapsed,
    canFloat: !input.coarse,
  };
}

/**
 * The sidebar mode the shell must render, derived from the persisted desktop
 * preferences AND the current device. Forced states (drawer below lg, rail
 * default below xl, no floating / resizing on a touch screen) are computed
 * here and never written back to localStorage — the stored preferences are
 * shared across Obli apps and must survive a visit from a phone or a tablet
 * untouched.
 */
export function useEffectiveSidebar(): EffectiveSidebar {
  const mode = useLayoutMode();
  const xl = useMediaQuery(MEDIA.xl);
  const coarse = useIsCoarsePointer();
  const floatingPref = useUiStore((s) => s.sidebarFloating);
  const collapsedPref = useUiStore((s) => s.sidebarCollapsed);
  const collapsedExplicit = useUiStore((s) => s.sidebarCollapsedExplicit);
  // useLayoutMode() reports 'desktop' without matchMedia (tests / SSR): keep
  // the historic pinned layout there instead of the < xl rail default.
  const hasMatchMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  return resolveEffectiveSidebar({
    lg: mode === 'desktop',
    xl: xl || !hasMatchMedia,
    coarse,
    floatingPref,
    collapsedPref,
    collapsedExplicit,
  });
}
