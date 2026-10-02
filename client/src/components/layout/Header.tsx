import { useEffect, useState } from 'react';
import { LogOut, Download, ShieldOff, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useSocketStore } from '@/store/socketStore';
import apiClient from '@/api/client';
import type { ApiResponse } from '@obliview/shared';
import { anonUsername } from '@/utils/anonymize';
import { NotificationCenter } from './NotificationCenter';
import { TenantSwitcher } from './TenantSwitcher';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Logo } from '@/components/common/Logo';
import { cn } from '@/utils/cn';

/** True when running inside the native desktop app overlay. */
const isNativeApp = typeof window !== 'undefined' &&
  !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

// ── App switcher data ───────────────────────────────────────────────────────
//
// Per D:\Mockup\obli-design-system.md §1 + §4.1 — pills, current app glowing
// with its own brand colour. The set of apps, their label, colour and order
// come entirely from Obligate (GET /api/auth/connected-apps, already sorted
// by its admin-controlled sort_order): a new app registered in Obligate
// appears here with zero code change. Obliguard only needs to know its own
// identity (CURRENT_APP) to find itself in that list — never the others.

const CURRENT_APP = 'obliguard';

/** Fallback dot colour for an app Obligate hasn't been given a brand colour for yet. */
const FALLBACK_COLOR = '#8B949E';

interface ConnectedAppEntry {
  appType: string;
  name: string;
  baseUrl: string;
  icon: string;
  color: string | null;
  self?: boolean;
}

export function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const { status: socketStatus } = useSocketStore();
  const [connectedApps, setConnectedApps] = useState<ConnectedAppEntry[]>([]);

  // Security chips data — Obliguard-specific (shows active bans + suspicious IPs)
  const [activeBans, setActiveBans] = useState<number | null>(null);
  const [suspicious, setSuspicious] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/auth/connected-apps', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { success: boolean; data?: ConnectedAppEntry[] }) => {
        if (d.success && d.data) setConnectedApps(d.data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    async function fetchChipData() {
      try {
        const [bansRes, susRes] = await Promise.allSettled([
          apiClient.get<ApiResponse<{ active: number; today: number }>>('/bans/stats'),
          apiClient.get<ApiResponse<never[]> & { total: number }>('/ip-reputation', {
            params: { status: 'suspicious', limit: 1 },
          }),
        ]);
        if (bansRes.status === 'fulfilled') {
          setActiveBans(bansRes.value.data.data?.active ?? 0);
        }
        if (susRes.status === 'fulfilled') {
          setSuspicious(susRes.value.data.total ?? 0);
        }
      } catch {
        // silent — chips just don't show
      }
    }
    void fetchChipData();
    const interval = setInterval(() => { void fetchChipData(); }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // The pills to render: Obligate's list as-is (already sorted by its
  // admin-controlled sort_order), self-marked entry (or a fallback match on
  // CURRENT_APP for an Obligate that predates the `self` field) treated as
  // current. If Obligate is unreachable / hasn't listed us yet, synthesize a
  // minimal self entry so the current app's own pill never disappears.
  const hasSelf = connectedApps.some(a => a.self === true || a.appType === CURRENT_APP);
  const switcherApps: ConnectedAppEntry[] = hasSelf
    ? connectedApps
    : [{ appType: CURRENT_APP, name: 'Obliguard', baseUrl: '', icon: '', color: null, self: true }, ...connectedApps];

  const goApp = (app: ConnectedAppEntry) => {
    const isCurrent = app.self === true || app.appType === CURRENT_APP;
    if (isCurrent) return;
    const target = connectedApps.find(c => c.appType === app.appType);
    if (!target) return;
    // Cross-app tenant handoff: forward the current tenant slug so the target
    // app can re-select the same tenant after Obligate SSO completes. Falls
    // back to the user's first available tenant on the target side if the
    // slug does not exist there.
    const ts = useTenantStore.getState();
    const tenantSlug = ts.tenants.find(t => t.id === ts.currentTenantId)?.slug;
    const url = new URL(`${target.baseUrl}/auth/sso-redirect`);
    if (tenantSlug) url.searchParams.set('tenant', tenantSlug);
    window.location.href = url.toString();
  };

  const username = user?.username ?? '';
  const rawName = user?.displayName?.trim() || (username.startsWith('og_') ? username.slice(3) : username);
  const displayedUsername = anonUsername(rawName);

  return (
    <header className="flex h-13 shrink-0 items-center gap-3 bg-bg-secondary px-4" style={{ height: 52 }}>
      {/* Logo — always visible in the topbar so it stays accessible regardless
          of sidebar state (pinned, collapsed, floating). */}
      <Link to="/" className="flex items-center gap-2 shrink-0">
        <Logo className="h-8 w-auto max-w-[160px] object-contain" />
      </Link>

      {/* Tenant selector — sits left of the app switcher, preserving the
          context that gets carried across apps. */}
      <TenantSwitcher />

      {/* App switcher pills — only show the current app + apps the user can
          actually reach (returned by /api/auth/connected-apps). Unreachable
          apps are hidden entirely rather than greyed out. */}
      {!isNativeApp && (
        <nav className="flex items-center gap-1 rounded-lg bg-bg-hover p-1 ml-1">
          {switcherApps.map((app) => {
            const isCurrent = app.self === true || app.appType === CURRENT_APP;
            return (
              <button
                key={app.appType}
                type="button"
                onClick={() => goApp(app)}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 rounded-md text-[12.5px] font-medium transition-colors',
                  isCurrent
                    ? 'bg-bg-secondary text-text-primary font-semibold shadow-[0_1px_3px_rgb(46_52_64_/_0.1)]'
                    : 'text-text-secondary hover:bg-bg-active hover:text-text-primary',
                )}
                title={app.name}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: app.color ?? FALLBACK_COLOR }}
                />
                {app.name}
              </button>
            );
          })}
        </nav>
      )}

      <div className="ml-auto flex items-center gap-3">
        {/* Security chips — Obliguard-specific (active bans + suspicious IPs) */}
        {(activeBans !== null || suspicious !== null) && (
          <div className="hidden sm:flex items-center gap-1.5">
            {activeBans !== null && activeBans > 0 && (
              <Link
                to="/bans"
                title={t('dashboard.activeBans', { defaultValue: 'Active Bans' })}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors"
              >
                <ShieldOff size={10} />
                {activeBans} ban
              </Link>
            )}
            {suspicious !== null && suspicious > 0 && (
              <Link
                to="/ip-reputation"
                title={t('header.suspiciousIps', { defaultValue: 'Suspicious IPs' })}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold text-yellow-400 bg-yellow-500/10 hover:bg-yellow-500/20 transition-colors"
              >
                <ShieldAlert size={10} />
                {suspicious} sus
              </Link>
            )}
          </div>
        )}

        {/* Download App link */}
        {!isNativeApp && (
          <Link
            to="/download"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <Download size={14} />
            {t('nav.downloadApp')}
          </Link>
        )}

        {/* Socket connection status dot */}
        <button
          onClick={socketStatus !== 'connected' ? () => window.location.reload() : undefined}
          title={
            socketStatus === 'connected'    ? t('header.socketConnected')    :
            socketStatus === 'reconnecting' ? t('header.socketReconnecting') :
                                              t('header.socketDisconnected')
          }
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md transition-opacity',
            socketStatus !== 'connected' && 'cursor-pointer hover:opacity-70',
            socketStatus === 'connected'  && 'cursor-default',
          )}
        >
          <span
            className={cn(
              'h-2 w-2 rounded-full transition-colors',
              socketStatus === 'connected'    && 'bg-green-500',
              socketStatus === 'reconnecting' && 'bg-amber-400 animate-pulse',
              socketStatus === 'disconnected' && 'bg-red-500 animate-pulse',
            )}
          />
        </button>

        {/* Notification Center */}
        <NotificationCenter />

        {user && (
          <>
            <div className="flex items-center gap-2 pl-1.5 pr-3 py-1 rounded-lg bg-bg-hover">
              <UserAvatar avatar={user.avatar} username={username} size={28} />
              <span className="text-[13px] font-medium text-text-primary">{displayedUsername}</span>
              <span className="text-[10px] font-mono uppercase tracking-wider text-accent pl-2 border-l border-border-light">
                {user.role}
              </span>
            </div>
            <button
              onClick={logout}
              title={t('nav.signOut')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              <LogOut size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}

