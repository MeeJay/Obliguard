import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, Eye, Globe, Plus, RefreshCw, Search, Shield, ShieldOff, X } from 'lucide-react';
import type { BanScope, CreateBanRequest } from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TableScroll } from '@/components/common/TableScroll';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { SortableTh, nextSort } from '@/components/common/SortableTh';
import { TenantBadge } from '@/components/common/TenantBadge';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { ScopeBadge } from '@/components/status/ScopeBadge';
import { useIpsPermissions, type IpsPermissions } from '@/hooks/useIpsPermissions';
import { useIpChanged, useIpDrawer, notifyIpChanged } from '@/hooks/useIpDrawer';
import { useRowSelection } from '@/hooks/useRowSelection';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useSocketRefresh } from '@/hooks/useSocketRefresh';
import { useTenantStore } from '@/store/tenantStore';
import { bansApi, apiError, type BanListItem, type BanSortBy, type BanState } from '@/api/bans.api';
import { anonIp } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import { CSV_EXPORT_MAX, csvExportError, downloadCsvExport } from '@/utils/download';
import {
  BAN_SOCKET_EVENTS,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  formatWhen,
  parseEnum,
  parseIdList,
  parsePage,
  useDebouncedSearch,
  usePrefixedParams,
  useSortParam,
} from './listParams';

// ── URL state (prefix b_) ────────────────────────────────────────────────────
// ?b_state= ?b_scope= ?b_type= ?b_search= ?b_page= ?b_sortBy= ?b_sortOrder=
// ?b_tenants= (god view).

type StateFilter = BanState | 'all';
type ScopeFilter = BanScope | 'all';
type TypeFilter = 'all' | 'auto' | 'manual' | 'external' | 'remote';

const STATES: readonly StateFilter[] = ['active', 'expired', 'lifted', 'all'];
const SCOPES: readonly ScopeFilter[] = ['all', 'global', 'tenant', 'group', 'agent'];
const TYPES: readonly TypeFilter[] = ['all', 'auto', 'manual', 'external', 'remote'];
const SORT_KEYS: readonly BanSortBy[] = ['createdAt', 'expiresAt', 'ip'];

/** The ban target as shown: the bare address for a host, 'network/prefix' for a subnet. */
function banTargetText(ban: Pick<BanListItem, 'ip' | 'cidrPrefix'>): string {
  const ip = String(ban.ip);
  if (ip.includes('/')) return ip.replace(/\/(32|128)$/, '');
  const full = ip.includes(':') ? 128 : 32;
  return ban.cidrPrefix != null && ban.cidrPrefix !== full ? `${ip}/${ban.cidrPrefix}` : ip;
}

const STATE_BADGE: Record<BanState, { color: string; key: string; fallback: string }> = {
  active: { color: 'text-red-400 bg-red-400/10 border-red-400/30', key: 'bans.state.active', fallback: 'Active' },
  expired: { color: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30', key: 'bans.state.expired', fallback: 'Expired' },
  lifted: { color: 'text-text-muted bg-text-muted/10 border-text-muted/20', key: 'bans.state.lifted', fallback: 'Lifted' },
};

const TYPE_BADGE: Record<string, string> = {
  auto: 'text-blue-400 bg-blue-400/10 border-blue-400/30',
  manual: 'text-text-secondary bg-bg-tertiary border-transparent',
  external: 'text-purple-400 bg-purple-400/10 border-purple-400/30',
  remote: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/30',
};

const pill = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium';

/**
 * Bans tab of the IP Reputation hub, driven by ip_bans: every ban (active,
 * expired, lifted) visible to the tenant, with names instead of ids, the
 * single Lift button (Default = lift for every tenant, other tenants = local
 * exclusion of a global ban) and an explicit-selection bulk Lift.
 */
export default function BansTab() {
  const { t } = useTranslation();
  const perms = useIpsPermissions();
  const confirm = useConfirm();
  const { open: openIp } = useIpDrawer();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);

  const params = usePrefixedParams('b_');
  const state = parseEnum(params.get('state'), STATES, 'active');
  const scope = parseEnum(params.get('scope'), SCOPES, 'all');
  const type = parseEnum(params.get('type'), TYPES, 'all');
  const page = parsePage(params.get('page'));
  const tenantIds = parseIdList(params.get('tenants'));
  const tenantsKey = tenantIds.join(',');
  const [search, setSearch, urlSearch] = useDebouncedSearch(params);
  const [sort, setSort] = useSortParam(params, SORT_KEYS);
  const [pageSizeRaw, setPageSize] = usePersistedState<number>('og-bans-page-size', DEFAULT_PAGE_SIZE);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(pageSizeRaw) ? pageSizeRaw : DEFAULT_PAGE_SIZE;

  const { update } = params;
  const setState = (next: StateFilter) => update((set) => set('state', next === 'active' ? null : next));
  const setScope = (next: ScopeFilter) => update((set) => set('scope', next === 'all' ? null : next));
  const setType = (next: TypeFilter) => update((set) => set('type', next === 'all' ? null : next));
  const setPage = useCallback((next: number) => update((set) => set('page', next <= 1 ? null : String(next)), false), [update]);
  const setTenants = (next: Set<number>) => update((set) => set('tenants', next.size ? [...next].sort((a, b) => a - b).join(',') : null));
  const onSort = (field: BanSortBy) => setSort(nextSort(sort, field));
  const hasFilters = scope !== 'all' || type !== 'all' || urlSearch !== '' || tenantIds.length > 0;
  const clearFilters = () => {
    setSearch('');
    update((set) => { set('scope', null); set('type', null); set('search', null); set('tenants', null); });
  };

  // ── Data ──
  const [rows, setRows] = useState<BanListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const res = await bansApi.list({
        state,
        scope: scope === 'all' ? undefined : scope,
        type: type === 'all' ? undefined : type,
        search: urlSearch || undefined,
        tenantIds: tenantsKey ? tenantsKey.split(',').map(Number) : undefined,
        sortBy: sort?.field,
        sortOrder: sort?.dir,
        page,
        pageSize,
      });
      if (seq !== requestSeq.current) return;
      setRows(res.data);
      setTotal(res.total);
      setLoadError(false);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(true);
      toast.error(apiError(err, t('bans.errors.load', { defaultValue: 'Failed to load the bans' })));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
    // currentTenantId: a tenant switch reloads the list.
  }, [state, scope, type, urlSearch, tenantsKey, sort?.field, sort?.dir, page, pageSize, currentTenantId, t]);

  // ── CSV export (current filters, server-side, capped) ──
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const params: Record<string, string | number> = {};
      params.state = state;
      if (scope !== 'all') params.scope = scope;
      if (type !== 'all') params.type = type;
      if (urlSearch) params.search = urlSearch;
      if (sort) { params.sortBy = sort.field; params.sortOrder = sort.dir; }
      if (tenantsKey) params.tenants = tenantsKey;
      const r = await downloadCsvExport('/bans/export', params, 'bans.csv');
      if (!r.ok) toast.error(t('csvExport.failed', { defaultValue: 'Export failed' }));
      else if (r.truncated) {
        toast(t('csvExport.truncated', {
          max: CSV_EXPORT_MAX.toLocaleString(),
          defaultValue: 'Only the first {{max}} rows were exported: narrow the filters to get the rest',
        }));
      }
    } catch (err) {
      toast.error(await csvExportError(err, t('csvExport.failed', { defaultValue: 'Export failed' })));
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => { void load(); }, [load]);
  useSocketRefresh(BAN_SOCKET_EVENTS, load, { debounceMs: 1500 });
  useIpChanged(() => { void load(); });

  // A page past the end (rows lifted meanwhile): go to the last page.
  useEffect(() => {
    if (!loading && rows.length === 0 && page > 1 && total > 0) setPage(Math.max(1, Math.ceil(total / pageSize)));
  }, [loading, rows.length, page, total, pageSize, setPage]);

  // ── Selection (cleared on any filter / page / sort change) ──
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selection = useRowSelection(visibleIds, [state, scope, type, urlSearch, tenantsKey, page, pageSize, sort, currentTenantId]);
  const selectedRows = useMemo(() => rows.filter((r) => selection.selected.has(r.id)), [rows, selection.selected]);
  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = selection.headerState === 'indeterminate';
  }, [selection.headerState]);

  const liftable = (r: BanListItem) => perms.canLift && r.liftAction != null && !r.isExcludedByTenant;
  const bulkLiftRows = selectedRows.filter(liftable);
  const [bulkBusy, setBulkBusy] = useState(false);

  const bulkLift = async () => {
    const targets = bulkLiftRows;
    if (targets.length === 0) return;
    const excludeCount = targets.filter((r) => r.liftAction === 'exclude').length;
    const ok = await confirm({
      title: t('bans.bulkLift.title', { defaultValue: 'Lift {{count}} bans', count: targets.length }),
      message: <>
        <p>{perms.canLiftGlobally
          ? t('bans.bulkLift.global', { defaultValue: 'The selected bans are lifted for every tenant.' })
          : t('bans.bulkLift.local', { defaultValue: 'The selected bans are lifted on this tenant only.' })}</p>
        {excludeCount > 0 && !perms.canLiftGlobally && (
          <p className="mt-2 text-xs text-text-muted">{t('bans.bulkLift.excludeHint', {
            defaultValue: '{{count}} of them are global bans: they stay active for the other tenants.',
            count: excludeCount,
          })}</p>
        )}
        {targets.length !== selection.count && (
          <p className="mt-2 text-xs text-text-muted">{t('bans.bulkLift.eligible', {
            defaultValue: '{{eligible}} of the {{selected}} selected bans can be lifted.',
            eligible: targets.length, selected: selection.count,
          })}</p>
        )}
      </>,
      confirmLabel: t('bans.actions.lift', { defaultValue: 'Lift' }),
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const r = await bansApi.bulkLift(targets.map((b) => b.id));
      toast.success(t('bans.bulkLift.done', {
        defaultValue: '{{lifted}} lifted, {{excluded}} lifted on this tenant, {{skipped}} skipped',
        lifted: r.lifted, excluded: r.excluded, skipped: r.skipped,
      }));
      if (r.refused > 0) {
        toast.error(t('bans.bulkLift.refused', {
          defaultValue: '{{count}} refused: {{reason}}',
          count: r.refused,
          reason: r.errors.find((e) => e.status !== 409)?.error ?? '—',
        }));
      }
      selection.clear();
      notifyIpChanged(null);
    } catch (err) {
      toast.error(apiError(err, t('bans.errors.bulkLift', { defaultValue: 'Bulk lift failed' })));
    } finally {
      setBulkBusy(false);
      void load();
    }
  };

  // ── Row actions ──
  const lift = async (ban: BanListItem): Promise<void> => {
    const target = banTargetText(ban);
    const message = ban.liftAction === 'exclude'
      ? t('bans.lift.excludeConfirm', { defaultValue: 'Lift the global ban on {{ip}} on this tenant? It stays active for the other tenants.', ip: target })
      : perms.canLiftGlobally
        ? t('bans.lift.globalConfirm', { defaultValue: 'Lift the ban on {{ip}} for every tenant?', ip: target })
        : t('bans.lift.localConfirm', { defaultValue: 'Lift the ban on {{ip}}?', ip: target });
    if (!(await confirm({ title: t('bans.lift.title', { defaultValue: 'Lift ban' }), message, confirmLabel: t('bans.actions.lift', { defaultValue: 'Lift' }) }))) return;
    try {
      await bansApi.lift(ban.id);
      toast.success(ban.liftAction === 'exclude'
        ? t('bans.lift.excluded', { defaultValue: '{{ip}} lifted on this tenant', ip: target })
        : t('bans.lift.done', { defaultValue: 'Ban on {{ip}} lifted', ip: target }));
      notifyIpChanged(ban.ip);
    } catch (err) {
      toast.error(apiError(err, t('bans.errors.lift', { defaultValue: 'Failed to lift the ban' })));
    } finally {
      void load();
    }
  };

  const reEnable = async (ban: BanListItem): Promise<void> => {
    try {
      await bansApi.removeExclusion(ban.id);
      toast.success(t('bans.reEnable.done', { defaultValue: '{{ip}} is enforced again on this tenant', ip: banTargetText(ban) }));
      notifyIpChanged(ban.ip);
    } catch (err) {
      toast.error(apiError(err, t('bans.errors.reEnable', { defaultValue: 'Failed to re-enable the ban' })));
    } finally {
      void load();
    }
  };

  const promote = async (ban: BanListItem): Promise<void> => {
    const target = banTargetText(ban);
    const ok = await confirm({
      title: t('bans.promote.title', { defaultValue: 'Promote to global' }),
      message: t('bans.promote.confirm', { defaultValue: 'Ban {{ip}} on every agent of every tenant? The reason becomes visible to every tenant.', ip: target }),
      confirmLabel: t('bans.promoteButton', { defaultValue: 'Promote to global' }),
      danger: true,
    });
    if (!ok) return;
    try {
      await bansApi.promoteToGlobal(ban.id);
      toast.success(t('bans.promote.done', { defaultValue: 'Ban on {{ip}} promoted to global', ip: target }));
      notifyIpChanged(ban.ip);
    } catch (err) {
      toast.error(apiError(err, t('bans.errors.promote', { defaultValue: 'Failed to promote the ban' })));
    } finally {
      void load();
    }
  };

  // ── Add ban ──
  const [showAdd, setShowAdd] = useState(false);

  // ── Columns ──
  const showTenantCol = perms.isGodView;
  const colCount = 9 + (showTenantCol ? 1 : 0);
  const th = 'px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted';
  const stateTabs = STATES.map((s) => ({
    id: s,
    label: s === 'all'
      ? t('bans.state.all', { defaultValue: 'All' })
      : t(STATE_BADGE[s].key, { defaultValue: STATE_BADGE[s].fallback }),
  }));
  const selectCls = 'rounded-md border border-border bg-bg-secondary px-2.5 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent coarse:min-h-10';

  const emptyTitle = state === 'active'
    ? t('bans.empty.active', { defaultValue: 'No active bans' })
    : state === 'expired'
      ? t('bans.empty.expired', { defaultValue: 'No expired bans' })
      : state === 'lifted'
        ? t('bans.empty.lifted', { defaultValue: 'No lifted bans' })
        : t('bans.empty.all', { defaultValue: 'No bans yet' });

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs
          tabs={stateTabs}
          value={state}
          onChange={setState}
          fill={false}
          size="sm"
          ariaLabel={t('bans.filters.state', { defaultValue: 'Ban state' })}
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as ScopeFilter)}
          aria-label={t('bans.filters.scope', { defaultValue: 'Scope' })}
          className={selectCls}
        >
          {SCOPES.map((s) => (
            <option key={s} value={s}>
              {s === 'all' ? t('bans.filters.allScopes', { defaultValue: 'All scopes' }) : t(`status.scope.${s}`, { defaultValue: s })}
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as TypeFilter)}
          aria-label={t('bans.filters.type', { defaultValue: 'Type' })}
          className={selectCls}
        >
          {TYPES.map((ty) => (
            <option key={ty} value={ty}>
              {ty === 'all' ? t('bans.filters.allTypes', { defaultValue: 'All types' }) : t(`bans.type.${ty}`, { defaultValue: ty })}
            </option>
          ))}
        </select>
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('bans.searchPlaceholder', { defaultValue: 'IP, CIDR or reason…' })}
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
            onClick={() => void load()}
          />
          <IconButton
            label={t('csvExport.button', { defaultValue: 'Export CSV' })}
            icon={<Download className={cn('h-4 w-4', exporting && 'animate-pulse')} />}
            onClick={() => void exportCsv()}
            disabled={exporting}
          />
          {perms.canBan && (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus size={14} className="mr-1" />{t('bans.add.button', { defaultValue: 'Add ban' })}
            </Button>
          )}
        </div>
      </div>

      <TenantFilterChips value={new Set(tenantIds)} onChange={setTenants} />

      {/* Bulk bar */}
      {selection.count > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/20 bg-accent/10 px-3 py-2">
          <span className="text-sm font-medium text-accent">
            {t('ipReputation.bulk.selected', { defaultValue: '{{count}} selected', count: selection.count })}
          </span>
          {perms.canLift && (
            <Button size="sm" variant="secondary" disabled={bulkBusy || bulkLiftRows.length === 0} onClick={() => void bulkLift()}>
              <Shield size={12} className="mr-1" />{t('bans.actions.lift', { defaultValue: 'Lift' })}
              {bulkLiftRows.length !== selection.count && <span className="ml-1 tabular-nums text-text-muted">({bulkLiftRows.length})</span>}
            </Button>
          )}
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
              <th
                scope="col"
                aria-sort={sort?.field === 'ip' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                className={cn(th, 'pl-3')}
              >
                {/* The checkbox cannot live inside SortableTh's button: same sort control, built inline. */}
                <div className="flex items-center gap-3">
                  <input
                    ref={headerCheckbox}
                    type="checkbox"
                    className="accent-accent"
                    checked={selection.headerState === 'checked'}
                    disabled={rows.length === 0}
                    onChange={() => selection.toggleAllVisible()}
                    aria-label={t('bans.bulk.selectPage', { defaultValue: 'Select every ban of this page' })}
                  />
                  <button
                    type="button"
                    onClick={() => onSort('ip')}
                    className={cn(
                      'inline-flex items-center gap-1 rounded [letter-spacing:inherit] [text-transform:inherit] transition-colors hover:text-text-primary',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                      sort?.field === 'ip' && 'text-text-primary',
                    )}
                  >
                    {t('bans.columns.target', { defaultValue: 'IP / range' })}
                    {sort?.field === 'ip'
                      ? (sort.dir === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)
                      : <ChevronsUpDown size={12} aria-hidden="true" className="opacity-40" />}
                  </button>
                </div>
              </th>
              <th scope="col" className={th}>{t('bans.columns.state', { defaultValue: 'State' })}</th>
              <th scope="col" className={th}>{t('bans.columns.scope', { defaultValue: 'Scope' })}</th>
              <th scope="col" className={th}>{t('bans.columns.type', { defaultValue: 'Type' })}</th>
              <th scope="col" className={th}>{t('bans.columns.reason', { defaultValue: 'Reason' })}</th>
              <th scope="col" className={th}>{t('bans.columns.createdBy', { defaultValue: 'Banned by' })}</th>
              <SortableTh field="createdAt" sort={sort} onSort={onSort} className={th}>
                {t('bans.columns.bannedAt', { defaultValue: 'Banned at' })}
              </SortableTh>
              <SortableTh field="expiresAt" sort={sort} onSort={onSort} className={th}>
                {state === 'lifted'
                  ? t('bans.columns.liftedOrExpires', { defaultValue: 'Lifted / expires' })
                  : t('bans.columns.expires', { defaultValue: 'Expires' })}
              </SortableTh>
              {showTenantCol && <th scope="col" className={th}>{t('bans.columns.tenant', { defaultValue: 'Tenant' })}</th>}
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
                  title={t('bans.loadFailed', { defaultValue: 'The bans could not be loaded' })}
                  action={<Button size="sm" variant="secondary" onClick={() => void load()}>{t('common.refresh', { defaultValue: 'Refresh' })}</Button>}
                />
              ) : hasFilters ? (
                <EmptyState variant="filtered" colSpan={colCount} onClearFilters={clearFilters} />
              ) : (
                <EmptyState colSpan={colCount} icon={<ShieldOff size={32} strokeWidth={1.5} />} title={emptyTitle} />
              )
            ) : rows.map((ban) => (
              <BanRow
                key={ban.id}
                ban={ban}
                perms={perms}
                showTenant={showTenantCol}
                selected={selection.selected.has(ban.id)}
                onToggle={() => selection.toggle(ban.id)}
                onOpen={() => openIp(String(ban.ip).split('/')[0])}
                onLift={() => lift(ban)}
                onReEnable={() => reEnable(ban)}
                onPromote={() => promote(ban)}
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

      <AddBanModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={(ip) => { setShowAdd(false); notifyIpChanged(ip); void load(); }}
        global={perms.isGodView}
      />
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

interface BanRowProps {
  ban: BanListItem;
  perms: IpsPermissions;
  showTenant: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onLift: () => Promise<void>;
  onReEnable: () => Promise<void>;
  onPromote: () => Promise<void>;
}

function BanRow({ ban, perms, showTenant, selected, onToggle, onOpen, onLift, onReEnable, onPromote }: BanRowProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const active = ban.state === 'active';
  const excluded = ban.isExcludedByTenant;
  const canLift = perms.canLift && ban.liftAction != null && !excluded;
  const canReEnable = perms.canLift && active && excluded;
  const canPromote = perms.canPromote && active && ban.scope !== 'global';
  const target = banTargetText(ban);

  // One Lift button (the server decides global vs local), the rest in the menu.
  let primary: ReactNode = null;
  if (canLift) {
    primary = (
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(onLift)}
        title={ban.liftAction === 'exclude'
          ? t('bans.actions.liftLocalHint', { defaultValue: 'Lift on this tenant only (the global ban stays active elsewhere)' })
          : perms.canLiftGlobally
            ? t('bans.actions.liftGlobalHint', { defaultValue: 'Lift for every tenant' })
            : t('bans.actions.liftHint', { defaultValue: 'Lift this ban' })}>
        <Shield size={12} className="mr-1" />{t('bans.actions.lift', { defaultValue: 'Lift' })}
      </Button>
    );
  } else if (canReEnable) {
    primary = (
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(onReEnable)}
        title={t('bans.actions.reEnableHint', { defaultValue: 'Enforce this global ban again on this tenant' })}>
        <Eye size={12} className="mr-1" />{t('bans.actions.reEnable', { defaultValue: 'Re-enable' })}
      </Button>
    );
  }

  const items: ActionMenuItem[] = [
    { key: 'details', icon: <Globe size={14} />, label: t('ipReputation.actions.details', { defaultValue: 'Details' }), onClick: onOpen },
    { key: 'promote', icon: <Globe size={14} />, label: t('bans.promoteButton', { defaultValue: 'Promote to global' }), onClick: () => void run(onPromote), hidden: !canPromote, separator: true },
  ];

  const stateCfg = STATE_BADGE[ban.state];
  const tenantId = ban.tenantId ?? ban.originTenantId;
  const tenantName = ban.tenantId != null ? ban.tenantName : ban.originTenantName;

  return (
    <tr onClick={onOpen} className={cn('h-11 cursor-pointer transition-colors hover:bg-bg-hover', selected && 'bg-accent/5')}>
      <td className="px-3 py-2">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            className="accent-accent"
            checked={selected}
            onChange={onToggle}
            onClick={(e) => e.stopPropagation()}
            aria-label={t('bans.bulk.select', { defaultValue: 'Select {{ip}}', ip: target })}
          />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="whitespace-nowrap rounded font-mono text-text-primary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {anonIp(target)}
          </button>
        </div>
      </td>
      <td className="px-4 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <span className={cn(pill, stateCfg.color)}>{t(stateCfg.key, { defaultValue: stateCfg.fallback })}</span>
          {excluded && active && (
            <span className={cn(pill, 'border-purple-400/30 bg-purple-400/10 text-purple-400')}
              title={t('bans.excludedHint', { defaultValue: 'Lifted on this tenant: the global ban is not enforced on its agents' })}>
              {t('status.ip.excluded', { defaultValue: 'Excluded' })}
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <ScopeBadge scope={ban.scope} scopeName={ban.scopeName} />
          {ban.scopeName && ban.scope !== 'tenant' && (
            <span className="max-w-[10rem] truncate text-xs text-text-secondary" title={ban.scopeId != null ? `#${ban.scopeId}` : undefined}>
              {ban.scopeName}
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-2">
        <span className={cn(pill, TYPE_BADGE[ban.banType] ?? TYPE_BADGE.manual)}>
          {t(`bans.type.${ban.banType}`, { defaultValue: ban.banType })}
        </span>
      </td>
      <td className="max-w-[16rem] px-4 py-2 text-text-secondary">
        {ban.reason
          ? <span className="block truncate" title={ban.reason}>{ban.reason}</span>
          : <span className="text-text-muted">—</span>}
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-text-secondary">
        {ban.createdByUsername
          ?? (ban.banType === 'auto'
            ? <span className="text-text-muted">{t('bans.byEngine', { defaultValue: 'Ban engine' })}</span>
            : ban.banType === 'remote' && ban.originRef
              ? <span className="text-text-muted" title={ban.originRef}>{
                  ban.originRef.startsWith('mikrotik')
                    ? t('bans.byMikrotik', { defaultValue: 'MikroTik import' })
                    : t('bans.byBlocklist', { defaultValue: 'Remote blocklist' })
                }</span>
              : <span className="text-text-muted">—</span>)}
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-text-muted">{formatWhen(ban.bannedAt)}</td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-text-muted">
        {ban.state === 'lifted'
          ? <span title={t('bans.columns.liftedAt', { defaultValue: 'Lifted at' })}>{formatWhen(ban.liftedAt)}</span>
          : ban.expiresAt
            ? <span className={cn(ban.state === 'expired' && 'text-yellow-400')}>{formatWhen(ban.expiresAt)}</span>
            : <span className="italic">{t('bans.never', { defaultValue: 'Never' })}</span>}
      </td>
      {showTenant && (
        <td className="px-4 py-2">
          {tenantId != null
            ? <TenantBadge tenantId={tenantId} tenantName={tenantName ?? undefined} />
            : <span className="text-text-muted">—</span>}
        </td>
      )}
      <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          {primary}
          <ActionMenu items={items} triggerSize="sm" disabled={busy} />
        </div>
      </td>
    </tr>
  );
}

// ── Add ban ──────────────────────────────────────────────────────────────────

/**
 * Manual ban: an address or a CIDR range. The scope follows the operating
 * tenant (server rule): global from Default, tenant-local elsewhere.
 */
function AddBanModal({ open, onClose, onAdded, global }: { open: boolean; onClose: () => void; onAdded: (ip: string) => void; global: boolean }) {
  const { t } = useTranslation();
  const [ip, setIp] = useState('');
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIp(''); setReason(''); setExpiresAt('');
  }, [open]);

  const submit = async () => {
    const value = ip.trim();
    if (!value) {
      toast.error(t('bans.add.ipRequired', { defaultValue: 'The IP address or range is required' }));
      return;
    }
    const req: CreateBanRequest = {
      ip: value,
      reason: reason.trim() || null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };
    setSaving(true);
    try {
      await bansApi.create(req);
      toast.success(t('bans.add.done', { defaultValue: '{{ip}} banned', ip: value }));
      onAdded(value.split('/')[0]);
    } catch (err) {
      toast.error(apiError(err, t('bans.errors.create', { defaultValue: 'Failed to create the ban' })));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={t('bans.add.title', { defaultValue: 'Add a ban' })}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
          <Button variant="danger" loading={saving} onClick={() => void submit()}>
            <ShieldOff size={14} className="mr-1" />{t('bans.add.submit', { defaultValue: 'Ban' })}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <Input
          label={t('bans.add.target', { defaultValue: 'IP address or CIDR range' })}
          placeholder="203.0.113.10 / 203.0.113.0/24"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
        />
        <p className="text-xs text-text-muted">
          {global
            ? t('bans.scopeGlobalHint', { defaultValue: 'Global ban: enforced on every agent of every tenant.' })
            : t('bans.scopeTenantHint', { defaultValue: 'Local ban: enforced only on the agents of this tenant.' })}
        </p>
        <Input
          label={t('bans.add.reason', { defaultValue: 'Reason (optional)' })}
          placeholder={t('ipReputation.banReasonPlaceholder', { defaultValue: 'Why is this IP being banned?' })}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="space-y-1">
          <label htmlFor="ban-add-expires" className="block text-sm font-medium text-text-secondary">
            {t('bans.add.expiresAt', { defaultValue: 'Expires at (optional)' })}
          </label>
          <input
            id="ban-add-expires"
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <p className="text-xs text-text-muted">{t('bans.add.permanentHint', { defaultValue: 'Leave empty for a permanent ban.' })}</p>
        </div>
      </div>
    </Modal>
  );
}
