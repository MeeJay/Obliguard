import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronDown, Building2, Check, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTenantStore } from '@/store/tenantStore';
import { useGroupStore } from '@/store/groupStore';
import { useAgentStore } from '@/store/agentStore';
import { disconnectSocket, connectSocket } from '@/socket/socketClient';
import { useAuthStore } from '@/store/authStore';
import { Drawer } from '@/components/common/Drawer';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useNativeBack } from '@/hooks/useNativeBack';
import { useLayoutMode } from '@/hooks/useMediaQuery';
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
  const isPhone = useLayoutMode() === 'phone';

  // Hooks must run BEFORE the early returns below (Rules of Hooks).
  // Dropdown: outside tap (pointerdown), Escape and Android back close it.
  // The phone sheet (Drawer) handles its own dismissal.
  const dropdownOpen = open && !isPhone;
  useClickOutside([panelRef, buttonRef], () => setOpen(false), dropdownOpen);
  useNativeBack(() => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
    return true;
  }, dropdownOpen, { escape: true });

  // In the native desktop app the injected tab bar replaces this dropdown
  const isNativeApp = !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;
  if (isNativeApp && tenants.length > 1) return null;

  // Only show when there are multiple tenants
  if (tenants.length <= 1) return null;

  const currentTenant = tenants.find((t) => t.id === currentTenantId) ?? tenants[0];

  const handleSwitch = async (tenantId: number) => {
    // Re-picking the current workspace just closes the list / sheet.
    if (tenantId === currentTenantId) { setOpen(false); return; }
    if (switching) return;
    setSwitching(true);
    setOpen(false);

    try {
      await setCurrentTenant(tenantId);
      // Switch refused (network / 403): nothing else to reload.
      if (useTenantStore.getState().currentTenantId !== tenantId) {
        toast.error(t('common.error', 'Error'));
        return;
      }

      // Reconnect the socket first: the server reads the new tenant from the
      // session, and the new instance bumps the socket generation so every
      // listener re-binds to it (useSocket, pages).
      if (user) {
        disconnectSocket();
        connectSocket();
      }

      // Reload the tenant-scoped stores. The agent store drops the previous
      // tenant's rows on its own (cache key = user + tenant).
      await Promise.all([
        useGroupStore.getState().fetchTree(),
        useAgentStore.getState().fetchDevices(),
      ]);
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

  // One row per workspace: switch on the name, favourite star on the right.
  // sheet = the phone bottom sheet (48 px rows, star always visible).
  const renderRows = (sheet: boolean) => tenants.map((tenant) => {
    const isFavourite = tenant.id === preferredTenantId;
    return (
      <div
        key={tenant.id}
        className={cn(
          'group flex items-center gap-1 pr-2 transition-colors hover:bg-bg-hover',
          sheet && 'rounded-lg',
          tenant.id === currentTenantId
            ? 'text-accent font-semibold'
            : 'text-text-primary',
        )}
      >
        <button
          onClick={() => handleSwitch(tenant.id)}
          aria-current={tenant.id === currentTenantId ? 'true' : undefined}
          className={cn(
            'flex min-w-0 flex-1 items-center justify-between px-3 py-2 text-sm text-left',
            sheet ? 'min-h-12' : 'coarse:min-h-11',
          )}
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
            // No hover on touch screens: the star stays visible there.
            isFavourite ? 'text-accent' : 'text-text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100',
            'coarse:inline-flex coarse:min-h-10 coarse:min-w-10 coarse:items-center coarse:justify-center',
          )}
        >
          <Star size={13} className={cn(isFavourite && 'fill-current')} />
        </button>
      </div>
    );
  });

  return (
    <div className="relative min-w-0">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        disabled={switching}
        aria-haspopup={isPhone ? 'dialog' : 'true'}
        aria-expanded={open}
        aria-label={`${t('tenant.label', 'Tenant')}: ${currentTenant?.name ?? ''}`}
        className={cn(
          'flex max-w-full min-w-0 items-center gap-2 rounded-md bg-bg-hover px-3 py-1.5 text-[13px] text-text-primary font-medium transition-colors hover:bg-bg-active',
          'max-md:gap-1.5 max-md:px-2.5 coarse:min-h-10',
          switching && 'opacity-60 cursor-wait',
        )}
      >
        {/* The "TENANT" caption is dropped below 1024 px to leave room for
            the name (the aria-label keeps it for screen readers). */}
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted max-lg:hidden">
          {t('tenant.label', 'Tenant')}
        </span>
        <span className="min-w-0 max-w-[140px] truncate tracking-[0.04em]">{currentTenant?.name ?? '…'}</span>
        <ChevronDown size={12} className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {/* Tablet / desktop: anchored dropdown. */}
      {dropdownOpen && (
        <div
          ref={panelRef}
          className="absolute left-0 top-9 z-50 w-52 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              {t('tenant.switchWorkspace')}
            </p>
          </div>
          <div className="py-1 max-h-64 overflow-y-auto overscroll-contain">
            {renderRows(false)}
          </div>
          <div className="px-3 py-2 border-t border-border">
            <p className="text-[11px] text-text-muted">
              <Star size={10} className="mr-1 inline align-[-1px]" />
              {t('tenant.favouriteHint', 'The favourite workspace opens at sign-in')}
            </p>
          </div>
        </div>
      )}

      {/* Phone: bottom sheet with 48 px rows. */}
      <Drawer
        open={open && isPhone}
        onClose={() => setOpen(false)}
        side="bottom"
        size="md"
        title={t('tenant.switchWorkspace')}
        icon={<Building2 className="h-4 w-4 text-accent" />}
        bodyClassName="px-2 pb-3 pt-0"
        footer={(
          <p className="w-full text-[11px] text-text-muted">
            <Star size={10} className="mr-1 inline align-[-1px]" />
            {t('tenant.favouriteHint', 'The favourite workspace opens at sign-in')}
          </p>
        )}
      >
        <div>{renderRows(true)}</div>
      </Drawer>
    </div>
  );
}
