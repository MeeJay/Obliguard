import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { DesktopUpdateBanner } from './DesktopUpdateBanner';
import { LiveAlerts } from './LiveAlerts';
import { GlobalAddAgentModal } from './GlobalAddAgentModal';
import { IpDetailDrawer } from '@/components/ip/IpDetailDrawer';
import { TwoFactorGate } from '@/components/common/TwoFactorGate';
import { Drawer } from '@/components/common/Drawer';
import { useUiStore, useEffectiveSidebar } from '@/store/uiStore';
import { useTenantStore } from '@/store/tenantStore';
import { useAgentDevicesPolling } from '@/store/agentStore';
import { useSocket } from '@/hooks/useSocket';
import { cn } from '@/utils/cn';

/**
 * Obli Design v1 — detached topbar + sidebar layout.
 * Spec: D:\Mockup\obli-design-system.md §4 + §12.
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ Header (52px, full width)                   │
 *   ├──────────┬──────────────────────────────────┤
 *   │ Sidebar  │ <Outlet />                       │
 *   │ 260/64px │                                  │
 *   └──────────┴──────────────────────────────────┘
 *
 * Below 1024 px the sidebar leaves the body row and becomes an off-canvas
 * Drawer opened by the Header hamburger (Obliance AppLayout drawer branch).
 */
export function AppLayout() {
  const { t } = useTranslation();
  // Global socket subscriptions — always active regardless of which page is open
  useSocket();
  // Agent devices of the operating tenant (sidebar tree, group pages): 30 s
  // visibility-aware poll on top of the socket deltas.
  useAgentDevicesPolling();

  // ── Tenant-switch safety net ──────────────────────────────────────────────
  // Tenant-scoped pages (agent detail, group detail...) hold an ID in the URL
  // that only resolves under the active tenant. After a switch that ID is a
  // dead end, so go back to the dashboard. The first transition (null → first
  // tenant on app boot) is skipped to keep a deep link hit while logging in.
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const previousTenantIdRef = useRef<number | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const previous = previousTenantIdRef.current;
    previousTenantIdRef.current = currentTenantId;
    if (previous == null) return;                  // app boot — keep deep link
    if (currentTenantId == null) return;           // logout / mid-fetch
    if (previous === currentTenantId) return;      // unchanged — no-op
    // A caller that wants the URL to survive the switch sets this flag right
    // before switching. Honour it once and clear it.
    try {
      if (sessionStorage.getItem('skipTenantSwitchRedirect') === '1') {
        sessionStorage.removeItem('skipTenantSwitchRedirect');
        return;
      }
    } catch { /* storage unavailable: redirect */ }
    navigate('/', { replace: true });
  }, [currentTenantId, navigate]);

  const {
    sidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    mobileNavOpen,
    setMobileNavOpen,
  } = useUiStore();
  // Effective mode: drawer below 1024 px, rail by default below 1280 px, no
  // floating / mouse resize on a touch screen. Never persisted.
  const sidebar = useEffectiveSidebar();
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // ── Off-canvas drawer (phone / tablet) ────────────────────────────────────
  // Closes on every navigation (location.key changes even when the same link
  // is tapped again) and whenever the layout leaves drawer mode, so it never
  // pops back open after a resize / rotation.
  const location = useLocation();
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.key, setMobileNavOpen]);
  useEffect(() => {
    if (!sidebar.isDrawer) setMobileNavOpen(false);
  }, [sidebar.isDrawer, setMobileNavOpen]);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), [setMobileNavOpen]);

  // ── Body row top offset (for floating sidebar anchor) ─────────────────────
  // The floating sidebar is `position: fixed` and must drop down from BELOW
  // the topbar — not from y=0. We measure where the body row (header excluded)
  // actually starts and use that as the floating sidebar's top anchor.
  const bodyRowRef = useRef<HTMLDivElement>(null);
  const [topOffset, setTopOffset] = useState(0);

  useEffect(() => {
    const measure = () => {
      if (bodyRowRef.current) {
        setTopOffset(bodyRowRef.current.getBoundingClientRect().top);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // ── Floating sidebar visibility ───────────────────────────────────────────
  const [floatVisible, setFloatVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset floating visibility whenever the (effective) mode is toggled off
  useEffect(() => {
    if (!sidebar.floating) setFloatVisible(false);
  }, [sidebar.floating]);

  const showFloat = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setFloatVisible(true);
  }, []);

  const hideFloat = useCallback(() => {
    hideTimer.current = setTimeout(() => setFloatVisible(false), 150);
  }, []);

  // ── Resize handle ─────────────────────────────────────────────────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = sidebarWidth;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = ev.clientX - startX.current;
        setSidebarWidth(startWidth.current + delta);
      };

      const handleMouseUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [sidebarWidth, setSidebarWidth],
  );

  return (
    // h-screen fallback only where dvh is unsupported (WebView < 108): a plain
    // 'h-screen h-dvh' pair would let vh win (Tailwind orders same-property
    // utilities alphabetically).
    <div className="flex h-dvh supports-[not(height:100dvh)]:h-screen flex-col overflow-hidden bg-bg-primary">

      {/* Full-width topbar — always on top of the sidebar so logo + tenant
          selector stay visible regardless of sidebar state (collapsed,
          floating, hidden). */}
      <Header />
      <DesktopUpdateBanner />

      {/* Body row — sidebar + main content side by side, below the topbar */}
      <div ref={bodyRowRef} className="flex flex-1 overflow-hidden">

        {sidebar.isDrawer ? null : sidebar.floating ? (
          <>
            {/* Invisible hover-trigger strip on the far left edge of the body
                row (topbar excluded so logo/tenant remain clickable). */}
            <div
              className="fixed left-0 z-[51]"
              style={{ top: topOffset, height: `calc(100% - ${topOffset}px)`, width: '8px' }}
              onMouseEnter={showFloat}
            />

            {/* Floating sidebar panel — slides in from left on hover, anchored
                to the body row top so it never overlaps the topbar. */}
            <div
              className={cn(
                'fixed left-0 z-50',
                'transition-transform duration-200 ease-in-out',
                'shadow-[4px_0_24px_0_rgba(0,0,0,0.35)]',
                floatVisible ? 'translate-x-0' : '-translate-x-full',
              )}
              style={{ width: `${sidebarWidth}px`, top: topOffset, height: `calc(100% - ${topOffset}px)` }}
              onMouseEnter={showFloat}
              onMouseLeave={hideFloat}
            >
              <Sidebar />

              {/* Resize handle — still usable in floating mode */}
              {sidebar.resizable && (
                <div
                  onMouseDown={handleMouseDown}
                  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-10"
                />
              )}
            </div>
          </>
        ) : (
          /* ── Normal pinned sidebar (260 px expanded / 64 px collapsed) ── */
          <div
            className={cn(
              'flex-shrink-0 transition-all duration-200 relative',
              !sidebarOpen && 'w-0 overflow-hidden',
            )}
            style={sidebarOpen
              ? { width: sidebar.collapsed ? '64px' : `${sidebarWidth}px` }
              : undefined}
          >
            <Sidebar />

            {/* Resize handle — disabled while collapsed (fixed 64 px width)
                and on touch screens (no mouse to drag it with). */}
            {sidebarOpen && sidebar.resizable && (
              <div
                onMouseDown={handleMouseDown}
                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-10"
              />
            )}
          </div>
        )}

        {/* Main content — min-w-0 so a wide page (tables, toolbars) scrolls
            inside itself instead of widening the whole layout; safe-area
            padding keeps content clear of the gesture bar / notch (0 on
            desktop). */}
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-safe pb-safe">
          {/* Keyed on the tenant: every page remounts after a switch, so no
              state or listener of the previous tenant survives. */}
          <Outlet key={currentTenantId ?? 'none'} />
        </main>

      </div>

      {/* Phone / tablet navigation: the sidebar as an off-canvas drawer,
          opened by the hamburger in the Header. The Drawer closes itself on
          backdrop tap, Escape and Android back. */}
      {sidebar.isDrawer && (
        <Drawer
          open={mobileNavOpen}
          onClose={closeMobileNav}
          side="left"
          ariaLabel={t('nav.navigation', 'Navigation')}
          bodyClassName="flex flex-col overflow-hidden p-0"
        >
          <Sidebar variant="drawer" onRequestClose={closeMobileNav} />
        </Drawer>
      )}

      {/* Live alert toasts */}
      <LiveAlerts />

      {/* Global Add Agent modal (triggered from sidebar / dashboard) */}
      <GlobalAddAgentModal />

      {/* The single IP detail drawer: opened by ?ip= on any page (useIpDrawer) */}
      <IpDetailDrawer />

      {/* Step-up prompt of sensitive actions (401 TWO_FACTOR_REQUIRED, api/client.ts) */}
      <TwoFactorGate />
    </div>
  );
}
