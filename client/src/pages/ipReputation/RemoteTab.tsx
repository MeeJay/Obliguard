import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { CloudOff, Eye, EyeOff, Globe, Info, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TableScroll } from '@/components/common/TableScroll';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useIpsPermissions } from '@/hooks/useIpsPermissions';
import { useIsPlatformAdmin } from '@/hooks/usePermission';
import { useIpDrawer } from '@/hooks/useIpDrawer';
import { useRowSelection } from '@/hooks/useRowSelection';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useTenantStore } from '@/store/tenantStore';
import { apiError } from '@/api/bans.api';
import {
  remoteBlocklistApi,
  type RemoteBlockedIp,
  type RemoteBlocklist,
  type RemoteBlocklistStats,
} from '@/api/remoteBlocklist.api';
import { anonIp } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  formatWhen,
  parseEnum,
  parsePage,
  useDebouncedSearch,
  usePrefixedParams,
} from './listParams';

/** Where the lists (and their Enforce toggle) are configured. */
const POLICIES_BLOCKLISTS = '/policies?tab=blocklists';

// ── URL state (prefix r_) ────────────────────────────────────────────────────
// ?r_source= ?r_status= ?r_search= ?r_page=

type StatusFilter = 'all' | 'enabled' | 'disabled';
const STATUSES: readonly StatusFilter[] = ['all', 'enabled', 'disabled'];

/** Run `fn` over `items`, a few at a time; counts successes and failures. */
async function runBulk<T>(items: readonly T[], fn: (item: T) => Promise<unknown>, concurrency = 4): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await fn(item); ok++; } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { ok, failed };
}

/**
 * Remote tab of the IP Reputation hub: the addresses imported from the
 * remote blocklists (obli.tools, URL lists), with their provenance: the
 * list, the source's verdict and whether a ban is enforced. Listing only:
 * the lists and their per-list Enforce toggle are configured in Policies >
 * Remote blocklists (instance setting, owner decision 6). A list that does
 * not enforce only lists its addresses. Enabling / disabling an imported
 * address is a platform-admin action from the Default tenant (server rule).
 */
export default function RemoteTab() {
  const { t } = useTranslation();
  const perms = useIpsPermissions();
  const isPlatformAdmin = useIsPlatformAdmin();
  const canToggle = isPlatformAdmin && perms.isGodView;
  const confirm = useConfirm();
  const { open: openIp } = useIpDrawer();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);

  const params = usePrefixedParams('r_');
  const sourceRaw = Number(params.get('source'));
  const sourceId = Number.isInteger(sourceRaw) && sourceRaw > 0 ? sourceRaw : null;
  const status = parseEnum(params.get('status'), STATUSES, 'all');
  const page = parsePage(params.get('page'));
  const [search, setSearch, urlSearch] = useDebouncedSearch(params);
  const [pageSizeRaw, setPageSize] = usePersistedState<number>('og-remote-ips-page-size', DEFAULT_PAGE_SIZE);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(pageSizeRaw) ? pageSizeRaw : DEFAULT_PAGE_SIZE;

  const { update } = params;
  const setSource = (next: number | null) => update((set) => set('source', next == null ? null : String(next)));
  const setStatus = (next: StatusFilter) => update((set) => set('status', next === 'all' ? null : next));
  const setPage = useCallback((next: number) => update((set) => set('page', next <= 1 ? null : String(next)), false), [update]);
  const hasFilters = sourceId != null || status !== 'all' || urlSearch !== '';
  const clearFilters = () => {
    setSearch('');
    update((set) => { set('source', null); set('status', null); set('search', null); });
  };

  // ── Sources + stats ──
  const [sources, setSources] = useState<RemoteBlocklist[]>([]);
  const [stats, setStats] = useState<RemoteBlocklistStats | null>(null);
  const loadMeta = useCallback(async () => {
    const [s, st] = await Promise.allSettled([remoteBlocklistApi.list(), remoteBlocklistApi.stats()]);
    setSources(s.status === 'fulfilled' ? s.value : []);
    setStats(st.status === 'fulfilled' ? st.value : null);
    // currentTenantId: a tenant switch reloads.
  }, [currentTenantId]);

  // ── Data ──
  const [rows, setRows] = useState<RemoteBlockedIp[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const res = await remoteBlocklistApi.listIps({
        blocklistId: sourceId ?? undefined,
        search: urlSearch || undefined,
        enabled: status === 'all' ? undefined : status === 'enabled',
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      if (seq !== requestSeq.current) return;
      setRows(res.data);
      setTotal(res.total);
      setLoadError(false);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(true);
      toast.error(apiError(err, t('remoteIps.errors.load', { defaultValue: 'Failed to load the remote IPs' })));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [sourceId, urlSearch, status, page, pageSize, currentTenantId, t]);

  useEffect(() => { void loadMeta(); }, [loadMeta]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!loading && rows.length === 0 && page > 1 && total > 0) setPage(Math.max(1, Math.ceil(total / pageSize)));
  }, [loading, rows.length, page, total, pageSize, setPage]);

  // ── Selection (cleared on any filter / page change) ──
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selection = useRowSelection(visibleIds, [sourceId, status, urlSearch, page, pageSize, currentTenantId]);
  const selectedRows = useMemo(() => rows.filter((r) => selection.selected.has(r.id)), [rows, selection.selected]);
  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = selection.headerState === 'indeterminate';
  }, [selection.headerState]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const setEnabled = async (targets: RemoteBlockedIp[], enabled: boolean) => {
    if (targets.length === 0) return;
    if (targets.length > 1) {
      const ok = await confirm({
        title: enabled
          ? t('remoteIps.bulk.enableTitle', { defaultValue: 'Enable {{count}} remote IPs', count: targets.length })
          : t('remoteIps.bulk.disableTitle', { defaultValue: 'Disable {{count}} remote IPs', count: targets.length }),
        message: enabled
          ? t('remoteIps.bulk.enableMessage', { defaultValue: 'These addresses are enforced again wherever their list applies.' })
          : t('remoteIps.bulk.disableMessage', { defaultValue: 'These addresses stop being enforced until enabled again.' }),
        confirmLabel: enabled ? t('remoteIps.actions.enable', { defaultValue: 'Enable' }) : t('remoteIps.actions.disable', { defaultValue: 'Disable' }),
      });
      if (!ok) return;
    }
    setBulkBusy(true);
    try {
      const r = await runBulk(targets, (ip) => remoteBlocklistApi.toggleIp(ip.id, enabled));
      if (r.ok > 0) {
        toast.success(enabled
          ? t('remoteIps.bulk.enabled', { defaultValue: '{{count}} enabled', count: r.ok })
          : t('remoteIps.bulk.disabled', { defaultValue: '{{count}} disabled', count: r.ok }));
      }
      if (r.failed > 0) toast.error(t('remoteIps.bulk.failed', { defaultValue: '{{count}} failed', count: r.failed }));
      selection.clear();
    } finally {
      setBulkBusy(false);
      void load();
      void loadMeta();
    }
  };

  const bulkEnableRows = selectedRows.filter((r) => !r.enabled);
  const bulkDisableRows = selectedRows.filter((r) => r.enabled);

  // ── Columns ──
  const colCount = 7;
  const th = 'px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted';
  const statusTabs = STATUSES.map((s) => ({
    id: s,
    label: s === 'all'
      ? t('remoteIps.filters.all', { defaultValue: 'All' })
      : s === 'enabled'
        // The entry flag, not the ban: a non-enforcing list's entries are enabled too.
        ? t('remoteIps.filters.enabledEntries', { defaultValue: 'Enabled' })
        : t('remoteIps.filters.disabled', { defaultValue: 'Disabled' }),
  }));
  const noSources = sources.length === 0 && !loading && total === 0 && !hasFilters;
  const listedOnly = sources.filter((s) => s.enforce === false);

  return (
    <div className="space-y-4">
      {/* Stats */}
      {stats && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-text-muted">
          <span>{t('remoteIps.stats.total', { defaultValue: '{{count}} remote IPs', count: stats.total })}</span>
          <span>{t('remoteIps.stats.enabled', { defaultValue: '{{count}} enforced', count: stats.enforced })}</span>
          <span>{t('remoteIps.stats.sources', { defaultValue: '{{count}} sources', count: stats.sources })}</span>
          {stats.lastSync && <span>{t('remoteIps.stats.lastSync', { defaultValue: 'Last sync: {{when}}', when: formatWhen(stats.lastSync) })}</span>}
        </div>
      )}

      {/* Lists that only list (no ban): said once, configured in Policies */}
      {listedOnly.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
          <Info size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
          <span>
            {t('remoteIps.listedOnlyNotice', {
              defaultValue: '{{lists}}: listed only, these addresses are not banned (enforcement is off for the list).',
              lists: listedOnly.map((s) => s.name).join(', '),
              count: listedOnly.length,
            })}
          </span>
          {isPlatformAdmin && perms.isGodView && (
            <Link to={POLICIES_BLOCKLISTS} className="ml-auto font-medium text-accent hover:underline">
              {t('remoteIps.configureLists', { defaultValue: 'Configure the lists' })}
            </Link>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs
          tabs={statusTabs}
          value={status}
          onChange={setStatus}
          fill={false}
          size="sm"
          ariaLabel={t('remoteIps.filters.status', { defaultValue: 'Status' })}
        />
        <select
          value={sourceId ?? ''}
          onChange={(e) => setSource(e.target.value ? Number(e.target.value) : null)}
          aria-label={t('remoteIps.filters.source', { defaultValue: 'Source' })}
          className="rounded-md border border-border bg-bg-secondary px-2.5 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent coarse:min-h-10"
        >
          <option value="">{t('remoteIps.filters.allSources', { defaultValue: 'All sources' })}</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.enforce === false
                ? t('remoteIps.filters.sourceListedOnly', { defaultValue: '{{name}} (listed only)', name: s.name })
                : s.name}
            </option>
          ))}
        </select>
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('remoteIps.searchPlaceholder', { defaultValue: 'Search IP…' })}
            aria-label={t('common.search', { defaultValue: 'Search' })}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-md border border-border bg-bg-secondary py-2 pl-9 pr-8 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('ipReputation.clearSearch', { defaultValue: 'Clear search' })}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-muted hover:text-text-primary"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <IconButton
            label={t('common.refresh', { defaultValue: 'Refresh' })}
            icon={<RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />}
            onClick={() => { void load(); void loadMeta(); }}
          />
        </div>
      </div>

      {/* Bulk bar */}
      {canToggle && selection.count > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/20 bg-accent/10 px-3 py-2">
          <span className="text-sm font-medium text-accent">
            {t('ipReputation.bulk.selected', { defaultValue: '{{count}} selected', count: selection.count })}
          </span>
          <Button size="sm" variant="secondary" disabled={bulkBusy || bulkEnableRows.length === 0} onClick={() => void setEnabled(bulkEnableRows, true)}>
            <Eye size={12} className="mr-1" />{t('remoteIps.actions.enable', { defaultValue: 'Enable' })}
            {bulkEnableRows.length !== selection.count && <span className="ml-1 tabular-nums text-text-muted">({bulkEnableRows.length})</span>}
          </Button>
          <Button size="sm" variant="secondary" disabled={bulkBusy || bulkDisableRows.length === 0} onClick={() => void setEnabled(bulkDisableRows, false)}>
            <EyeOff size={12} className="mr-1" />{t('remoteIps.actions.disable', { defaultValue: 'Disable' })}
            {bulkDisableRows.length !== selection.count && <span className="ml-1 tabular-nums text-text-muted">({bulkDisableRows.length})</span>}
          </Button>
          <button type="button" onClick={selection.clear} className="ml-auto text-xs text-text-muted hover:text-text-primary">
            {t('ipReputation.bulk.clearSelection', { defaultValue: 'Clear selection' })}
          </button>
        </div>
      )}

      {/* Table */}
      <TableScroll className="bg-bg-secondary" stickyFirstCol>
        <table className={cn('w-full text-sm', loading && rows.length > 0 && 'opacity-60 transition-opacity')} aria-busy={loading}>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={cn(th, 'pl-3')}>
                <label className="flex items-center gap-3">
                  {canToggle && (
                    <input
                      ref={headerCheckbox}
                      type="checkbox"
                      className="accent-accent"
                      checked={selection.headerState === 'checked'}
                      disabled={rows.length === 0}
                      onChange={() => selection.toggleAllVisible()}
                      aria-label={t('remoteIps.bulk.selectPage', { defaultValue: 'Select every IP of this page' })}
                    />
                  )}
                  <span>{t('remoteIps.columns.ip', { defaultValue: 'IP address' })}</span>
                </label>
              </th>
              <th scope="col" className={th}>{t('remoteIps.columns.status', { defaultValue: 'Status' })}</th>
              <th scope="col" className={th}>{t('remoteIps.columns.source', { defaultValue: 'Source' })}</th>
              <th scope="col" className={th}>{t('remoteIps.columns.reason', { defaultValue: 'Reason' })}</th>
              <th scope="col" className={cn(th, 'text-right')}>{t('remoteIps.columns.reports', { defaultValue: 'Reports' })}</th>
              <th scope="col" className={th}>{t('remoteIps.columns.lastSeen', { defaultValue: 'Last seen' })}</th>
              <th scope="col" className={cn(th, 'text-right')}>
                <span className="sr-only">{t('common.actions', { defaultValue: 'Actions' })}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {loading && rows.length === 0 ? (
              <TableSkeleton rows={Math.min(pageSize, 10)} cols={colCount} />
            ) : rows.length === 0 ? (
              loadError ? (
                <EmptyState
                  colSpan={colCount}
                  title={t('remoteIps.loadFailed', { defaultValue: 'The remote IPs could not be loaded' })}
                  action={<Button size="sm" variant="secondary" onClick={() => void load()}>{t('common.refresh', { defaultValue: 'Refresh' })}</Button>}
                />
              ) : hasFilters ? (
                <EmptyState variant="filtered" colSpan={colCount} onClearFilters={clearFilters} />
              ) : (
                <EmptyState
                  colSpan={colCount}
                  icon={<CloudOff size={32} strokeWidth={1.5} />}
                  title={noSources
                    ? t('remoteIps.noSources', { defaultValue: 'No remote blocklist' })
                    : t('remoteIps.empty', { defaultValue: 'No remote IPs imported yet' })}
                  description={noSources
                    ? t('remoteIps.noSourcesHintPolicies', { defaultValue: 'Remote blocklists (obli.tools, URL lists) are configured in Policies > Remote blocklists.' })
                    : t('remoteIps.emptyHint', { defaultValue: 'Addresses appear here after the next synchronisation.' })}
                  action={isPlatformAdmin && noSources
                    ? <Link to={POLICIES_BLOCKLISTS} className="rounded-lg bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary hover:bg-bg-hover">{t('remoteIps.openPolicies', { defaultValue: 'Open Policies' })}</Link>
                    : undefined}
                />
              )
            ) : rows.map((ip) => (
              <RemoteRow
                key={ip.id}
                ip={ip}
                canToggle={canToggle}
                busy={bulkBusy}
                selected={selection.selected.has(ip.id)}
                onToggleSelect={() => selection.toggle(ip.id)}
                onOpen={() => openIp(ip.ip.split('/')[0])}
                onSetEnabled={(enabled) => setEnabled([ip], enabled)}
              />
            ))}
          </tbody>
        </table>
      </TableScroll>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onChange={setPage}
        pageSizeOptions={PAGE_SIZES}
        onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
        disabled={loading}
      />
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

interface RemoteRowProps {
  ip: RemoteBlockedIp;
  canToggle: boolean;
  busy: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onSetEnabled: (enabled: boolean) => Promise<void>;
}

function RemoteRow({ ip, canToggle, busy, selected, onToggleSelect, onOpen, onSetEnabled }: RemoteRowProps) {
  const { t } = useTranslation();
  const items: ActionMenuItem[] = [
    { key: 'details', icon: <Globe size={14} />, label: t('ipReputation.actions.details', { defaultValue: 'Details' }), onClick: onOpen },
  ];
  const chip = 'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium';
  const suspicious = ip.status === 'suspicious';
  const enforced = ip.enforced;

  return (
    <tr onClick={onOpen} className={cn('h-11 cursor-pointer transition-colors hover:bg-bg-hover', selected && 'bg-accent/5', !ip.enabled && 'text-text-muted')}>
      <td className="px-3 py-2">
        <div className="flex items-center gap-3">
          {canToggle && (
            <input
              type="checkbox"
              className="accent-accent"
              checked={selected}
              onChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              aria-label={t('remoteIps.bulk.select', { defaultValue: 'Select {{ip}}', ip: ip.ip })}
            />
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className={cn(
              'whitespace-nowrap rounded font-mono hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
              ip.enabled ? 'text-text-primary' : 'text-text-muted',
            )}
          >
            {anonIp(ip.ip)}
          </button>
        </div>
      </td>
      <td className="px-4 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {!ip.enabled ? (
            <span className={cn(chip, 'border-text-muted/20 bg-text-muted/10 text-text-muted')}>
              {t('remoteIps.status.disabled', { defaultValue: 'Disabled' })}
            </span>
          ) : enforced ? (
            <span className={cn(chip, 'border-red-400/30 bg-red-400/10 text-red-400')}>
              {t('remoteIps.status.enabled', { defaultValue: 'Enforced' })}
            </span>
          ) : (
            <span
              className={cn(chip, 'border-border bg-bg-tertiary text-text-secondary')}
              title={suspicious
                ? t('remoteIps.status.suspiciousHint', { defaultValue: 'Reported as suspicious by the source: never banned from the list.' })
                : t('remoteIps.status.listedHint', { defaultValue: 'The list does not enforce: this address is listed, not banned.' })}
            >
              {t('remoteIps.status.listed', { defaultValue: 'Listed only' })}
            </span>
          )}
          {suspicious && (
            <span className={cn(chip, 'border-yellow-500/20 bg-yellow-500/10 text-yellow-400')}>
              {t('remoteIps.status.suspicious', { defaultValue: 'Suspicious' })}
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-2">
        <span
          className={cn(
            chip,
            ip.sourceType === 'oblitools'
              ? 'border-amber-500/20 bg-amber-500/10 text-amber-400'
              : 'border-cyan-500/20 bg-cyan-500/10 text-cyan-400',
          )}
          title={ip.listEnforce === false
            ? t('remoteIps.source.listedOnly', { defaultValue: 'Enforcement is off for this list' })
            : undefined}
        >
          {ip.blocklistName}
        </span>
      </td>
      <td className="max-w-[16rem] px-4 py-2 text-text-secondary">
        {ip.reason
          ? <span className="block truncate" title={ip.reason}>{ip.reason}</span>
          : <span className="text-text-muted">—</span>}
      </td>
      <td className="px-4 py-2 text-right tabular-nums text-text-secondary">{ip.reports.toLocaleString()}</td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-text-muted">{formatWhen(ip.lastSeen)}</td>
      <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          {canToggle && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onSetEnabled(!ip.enabled)}>
              {ip.enabled
                ? <><EyeOff size={12} className="mr-1" />{t('remoteIps.actions.disable', { defaultValue: 'Disable' })}</>
                : <><Eye size={12} className="mr-1" />{t('remoteIps.actions.enable', { defaultValue: 'Enable' })}</>}
            </Button>
          )}
          <ActionMenu items={items} triggerSize="sm" />
        </div>
      </td>
    </tr>
  );
}
