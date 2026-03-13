import { useEffect, useState, useTransition } from 'react';
import { LogOut, Menu, Download, ArrowLeftRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useUiStore } from '@/store/uiStore';
import { useSocketStore } from '@/store/socketStore';
import { appConfigApi } from '@/api/appConfig.api';
import { Button } from '@/components/common/Button';
import { NotificationCenter } from './NotificationCenter';
import { TenantSwitcher } from './TenantSwitcher';
import { cn } from '@/utils/cn';

/** True when running inside the Obliview native desktop app (gear overlay sets this). */
const isNativeApp = typeof window !== 'undefined' &&
  !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

export function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const { toggleSidebar, sidebarFloating } = useUiStore();
  const { status: socketStatus } = useSocketStore();
  const [obliviewUrl, setObliviewUrl] = useState<string | null>(null);
  const [obliviewSsoEnabled, setObliviewSsoEnabled] = useState(false);
  const [ssoSwitching, setSsoSwitching] = useState(false);
  const [, startSsoTransition] = useTransition();

  useEffect(() => {
    appConfigApi.getConfig()
      .then(cfg => {
        const url = (cfg as unknown as Record<string, unknown>).obliview_url;
        const sso = (cfg as unknown as Record<string, unknown>).obliview_sso_enabled;
        if (url && typeof url === 'string' && url.trim()) {
          setObliviewUrl(url.trim());
        }
        setObliviewSsoEnabled(!!sso);
      })
      .catch(() => {});
  }, []);

  const handleObliviewClick = async () => {
    if (!obliviewUrl) return;
    if (!obliviewSsoEnabled) {
      window.location.href = obliviewUrl;
      return;
    }
    setSsoSwitching(true);
    try {
      const res = await fetch('/api/sso/generate-token', { method: 'POST', credentials: 'include' });
      const body = await res.json() as { success: boolean; data?: { token: string } };
      if (body.success && body.data?.token) {
        const from = encodeURIComponent(window.location.origin);
        const token = encodeURIComponent(body.data.token);
        window.location.href = `${obliviewUrl.replace(/\/$/, '')}/auth/foreign?token=${token}&from=${from}&source=obliguard`;
      } else {
        window.location.href = obliviewUrl;
      }
    } catch {
      window.location.href = obliviewUrl;
    } finally {
      setSsoSwitching(false);
    }
  };

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-bg-secondary px-4">
      <div className="flex items-center gap-3">
        {/* Logo — shown in the Header only when the sidebar is floating. */}
        {sidebarFloating && (
          <Link to="/" className="flex items-center gap-2 shrink-0">
            <img src="/logo.webp" alt="Obliguard" className="h-8 w-8 rounded-lg" />
            <span className="hidden text-lg font-semibold text-text-primary sm:block">Obliguard</span>
          </Link>
        )}

        {/* Mobile menu button */}
        <button
          onClick={toggleSidebar}
          className="rounded-md p-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary lg:hidden"
        >
          <Menu size={20} />
        </button>

        {/* Tenant switcher — hidden when single-tenant (tenants.length <= 1) */}
        <TenantSwitcher />

        {/* Obliview switch — shown in header only when sidebar is floating */}
        {sidebarFloating && obliviewUrl && (
          <button
            type="button"
            onClick={() => { startSsoTransition(() => { void handleObliviewClick(); }); }}
            disabled={ssoSwitching}
            title="Switch to Obliview"
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-[#58a6ff] border border-[#1d4ed8]/40 bg-[#0c1929]/50 hover:bg-[#0c1929]/70 hover:border-[#3b82f6] transition-colors disabled:opacity-60"
          >
            <ArrowLeftRight size={12} className={ssoSwitching ? 'animate-pulse' : ''} />
            Obliview
          </button>
        )}
      </div>

      <div className="flex items-center gap-4">

        {/* Download App link — hidden inside the native desktop app */}
        {!isNativeApp && (
          <Link
            to="/download"
            className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
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
            'flex h-6 w-6 items-center justify-center rounded-full transition-opacity',
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
            <div className="text-sm">
              <span className="text-text-secondary">{t('header.signedInAs')} </span>
              <span className="font-medium text-text-primary">{user.username}</span>
              <span className="ml-2 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">
                {user.role}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              title={t('nav.signOut')}
            >
              <LogOut size={16} />
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
