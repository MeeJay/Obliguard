import { useRef, useState, useEffect, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronDown, Building2, Check, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTenantStore } from '@/store/tenantStore';
import { useGroupStore } from '@/store/groupStore';
import { useMonitorStore } from '@/store/monitorStore';
import { disconnectSocket, connectSocket } from '@/socket/socketClient';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';
import toast from 'react-hot-toast';

export function TenantSwitcher() {
  const { t } = useTranslation();
  const { currentTenantId, tenants, setCurrentTenant } = useTenantStore();
  const { user, preferredTenantId, setDefaultTenant } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click — must be BEFORE the early return to satisfy Rules of Hooks
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // In the native desktop app the injected tab bar replaces this dropdown
  const isNativeApp = !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;
  if (isNativeApp && tenants.length > 1) return null;

  // Only show when there are multiple tenants
  if (tenants.length <= 1) return null;

  const currentTenant = tenants.find((t) => t.id === currentTenantId) ?? tenants[0];

  const handleSwitch = async (tenantId: number) => {
    if (tenantId === currentTenantId || switching) return;
    setSwitching(true);
    setOpen(false);

    try {
      await setCurrentTenant(tenantId);

      // Reload all tenant-scoped data in parallel
      await Promise.all([
        useMonitorStore.getState().fetchMonitors(),
        useGroupStore.getState().fetchTree(),
      ]);

      // Reconnect the socket: the server reads the new tenant from the session
      if (user) {
        disconnectSocket();
        connectSocket();
      }
    } finally {
      setSwitching(false);
    }
  };

  const handleSetDefault = async (e: ReactMouseEvent, tenantId: number) => {
    e.stopPropagation();
    // Toggle: clicking the current favourite clears it (back to the first workspace).
    try {
      await setDefaultTenant(preferredTenantId === tenantId ? null : tenantId);
    } catch {
      toast.error(t('common.error', 'Error'));
    }
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        disabled={switching}
        className={cn(
          'flex items-center gap-2 rounded-md bg-bg-hover px-3 py-1.5 text-[13px] text-text-primary font-medium transition-colors hover:bg-bg-active',
          switching && 'opacity-60 cursor-wait',
        )}
      >
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          {t('tenant.label', 'Tenant')}
        </span>
        <span className="max-w-[140px] truncate tracking-[0.04em]">{currentTenant?.name ?? '…'}</span>
        <ChevronDown size={12} className={cn('text-text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute left-0 top-9 z-50 w-52 rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              {t('tenant.switchWorkspace')}
            </p>
          </div>
          <div className="py-1 max-h-64 overflow-y-auto">
            {tenants.map((tenant) => {
              const isFavourite = tenant.id === preferredTenantId;
              return (
                <div
                  key={tenant.id}
                  className={cn(
                    'group flex items-center gap-1 pr-2 transition-colors hover:bg-bg-hover',
                    tenant.id === currentTenantId
                      ? 'text-accent font-semibold'
                      : 'text-text-primary',
                  )}
                >
                  <button
                    onClick={() => handleSwitch(tenant.id)}
                    className="flex min-w-0 flex-1 items-center justify-between px-3 py-2 text-sm text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Building2 size={13} className="shrink-0 text-text-muted" />
                      <span className="truncate">{tenant.name}</span>
                      {tenant.role === 'admin' && (
                        <span className="shrink-0 text-[10px] text-text-muted bg-bg-tertiary rounded px-1 py-0.5">
                          {t('tenant.roleAdmin')}
                        </span>
                      )}
                    </div>
                    {tenant.id === currentTenantId && (
                      <Check size={13} className="shrink-0 text-accent" />
                    )}
                  </button>
                  <button
                    onClick={(e) => { void handleSetDefault(e, tenant.id); }}
                    title={isFavourite
                      ? t('tenant.clearFavourite', 'Favourite workspace (click to clear)')
                      : t('tenant.setFavourite', 'Set as favourite workspace')}
                    aria-pressed={isFavourite}
                    className={cn(
                      'shrink-0 rounded p-1 transition-colors hover:bg-bg-tertiary',
                      isFavourite ? 'text-accent' : 'text-text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                    )}
                  >
                    <Star size={13} className={cn(isFavourite && 'fill-current')} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="px-3 py-2 border-t border-border">
            <p className="text-[11px] text-text-muted">
              <Star size={10} className="mr-1 inline align-[-1px]" />
              {t('tenant.favouriteHint', 'The favourite workspace opens at sign-in')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
