import { create } from 'zustand';

interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarFloating: boolean;
  /** Obli Design v1: sidebar shrinks to 64 px icon-only column instead of
   *  hiding entirely. Persisted under a shared key so the choice survives
   *  cross-app navigation across the Obli* suite. */
  sidebarCollapsed: boolean;
  addAgentModalOpen: boolean;

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  toggleSidebarFloating: () => void;
  toggleSidebarCollapsed: () => void;
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

function loadSavedCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_COLLAPSED) === 'true';
  } catch {
    return false;
  }
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: true,
  sidebarWidth: loadSavedWidth(),
  sidebarFloating: loadSavedFloating(),
  sidebarCollapsed: loadSavedCollapsed(),
  addAgentModalOpen: false,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
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
    return { sidebarFloating: next, sidebarCollapsed: next ? false : s.sidebarCollapsed };
  }),
  toggleSidebarCollapsed: () => set((s) => {
    const next = !s.sidebarCollapsed;
    try {
      localStorage.setItem(STORAGE_KEY_COLLAPSED, String(next));
      if (next) localStorage.setItem(STORAGE_KEY_FLOATING, 'false');
    } catch { /* ignore */ }
    return { sidebarCollapsed: next, sidebarFloating: next ? false : s.sidebarFloating };
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
