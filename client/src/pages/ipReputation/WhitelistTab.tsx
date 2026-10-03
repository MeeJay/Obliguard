import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Download, Globe, Lock, Plus, RefreshCw, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { SOCKET_EVENTS } from '@obliview/shared';
import type { AgentDevice, CreateWhitelistRequest, GroupTreeNode, WhitelistScope } from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { TableScroll } from '@/components/common/TableScroll';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { SortableTh, nextSort } from '@/components/common/SortableTh';
import { TenantBadge } from '@/components/common/TenantBadge';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { GroupPicker } from '@/components/common/GroupPicker';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { ScopeBadge } from '@/components/status/ScopeBadge';
import { useIpsPermissions, type IpsPermissions } from '@/hooks/useIpsPermissions';
import { useIpChanged, useIpDrawer, notifyIpChanged } from '@/hooks/useIpDrawer';
import { useRowSelection } from '@/hooks/useRowSelection';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useSocketRefresh } from '@/hooks/useSocketRefresh';
import { useTenantStore } from '@/store/tenantStore';
import { useGroupStore } from '@/store/groupStore';
import { agentApi } from '@/api/agent.api';
import { apiError } from '@/api/bans.api';
import { whitelistApi, type WhitelistListItem, type WhitelistSortBy } from '@/api/whitelist.api';
import { anonIp } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import { CSV_EXPORT_MAX, csvExportError, downloadCsvExport } from '@/utils/download';
import {
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

// ── URL state (prefix w_) ────────────────────────────────────────────────────
// ?w_scope= ?w_search= ?w_page= ?w_sortBy= ?w_sortOrder= ?w_tenants= (god view).

type ScopeFilter = WhitelistScope | 'all';

const SCOPES: readonly ScopeFilter[] = ['all', 'global', 'tenant', 'group', 'agent'];
const SORT_KEYS: readonly WhitelistSortBy[] = ['createdAt', 'ip', 'scope'];

/** Whitelist writes (create / delete / bulk) pushed by the server. */
const WHITELIST_SOCKET_EVENTS = [SOCKET_EVENTS.WHITELIST_CHANGED] as const;

/** The entry as shown: the bare address for a /32 or /128, the range otherwise. */
function entryText(ip: string): string {
  return String(ip).replace(/\/(32|128)$/, '');
}

/**
 * Whitelist tab of the IP Reputation hub, driven by ip_whitelist: every
 * entry visible to the tenant (addresses and CIDR ranges, global / tenant /
 * group / agent), with names instead of ids. A global entry created from
 * Default applies to every tenant and is locked outside Default; entries
 * created elsewhere are local.
 */
export default function WhitelistTab() {
  const { t } = useTranslation();
  const perms = useIpsPermissions();
  const confirm = useConfirm();
  const { open: openIp } = useIpDrawer();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);

  const params = usePrefixedParams('w_');
  const scope = parseEnum(params.get('scope'), SCOPES, 'all');
  const page = parsePage(params.get('page'));
  const tenantIds = parseIdList(params.get('tenants'));
  const tenantsKey = tenantIds.join(',');
  const [search, setSearch, urlSearch] = useDebouncedSearch(params);
  const [sort, setSort] = useSortParam(params, SORT_KEYS);
  const [pageSizeRaw, setPageSize] = usePersistedState<number>('og-whitelist-page-size', DEFAULT_PAGE_SIZE);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(pageSizeRaw) ? pageSizeRaw : DEFAULT_PAGE_SIZE;

  const { update } = params;
  const setScope = (next: ScopeFilter) => update((set) => set('scope', next === 'all' ? null : next));
  const setPage = useCallback((next: number) => update((set) => set('page', next <= 1 ? null : String(next)), false), [update]);
  const setTenants = (next: Set<number>) => update((set) => set('tenants', next.size ? [...next].sort((a, b) => a - b).join(',') : null));
  const onSort = (field: WhitelistSortBy) => setSort(nextSort(sort, field));
  const hasFilters = scope !== 'all' || urlSearch !== '' || tenantIds.length > 0;
  const clearFilters = () => {
    setSearch('');
    update((set) => { set('scope', null); set('search', null); set('tenants', null); });
  };

  // ── Data ──
  const [rows, setRows] = useState<WhitelistListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const res = await whitelistApi.listPage({
        scope: scope === 'all' ? undefined : scope,
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
      toast.error(apiError(err, t('whitelist.errors.load', { defaultValue: 'Failed to load the whitelist' })));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
    // currentTenantId: a tenant switch reloads the list.
  }, [scope, urlSearch, tenantsKey, sort?.field, sort?.dir, page, pageSize, currentTenantId, t]);

  // ── CSV export (current filters, server-side, capped) ──
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const params: Record<string, string | number> = {};
      if (scope !== 'all') params.scope = scope;
      if (urlSearch) params.search = urlSearch;
      if (sort) { params.sortBy = sort.field; params.sortOrder = sort.dir; }
      if (tenantsKey) params.tenants = tenantsKey;
      const r = await downloadCsvExport('/whitelist/export', params, 'whitelist.csv');
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
  useSocketRefresh(WHITELIST_SOCKET_EVENTS, load, { debounceMs: 1000 });
  useIpChanged(() => { void load(); });

  // A page past the end (entries removed meanwhile): go to the last page.
  useEffect(() => {
    if (!loading && rows.length === 0 && page > 1 && total > 0) setPage(Math.max(1, Math.ceil(total / pageSize)));
  }, [loading, rows.length, page, total, pageSize, setPage]);

  // ── Selection (cleared on any filter / page / sort change) ──
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selection = useRowSelection(visibleIds, [scope, urlSearch, tenantsKey, page, pageSize, sort, currentTenantId]);
  const selectedRows = useMemo(() => rows.filter((r) => selection.selected.has(r.id)), [rows, selection.selected]);
  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = selection.headerState === 'indeterminate';
  }, [selection.headerState]);

  const deletable = (r: WhitelistListItem) => perms.canWhitelist && r.canDelete === true;
  const bulkDeleteRows = selectedRows.filter(deletable);
  const [bulkBusy, setBulkBusy] = useState(false);

  const bulkDelete = async () => {
    const targets = bulkDeleteRows;
    if (targets.length === 0) return;
    const ok = await confirm({
      title: t('whitelist.bulkDelete.title', { defaultValue: 'Remove {{count}} whitelist entries', count: targets.length }),
      message: <>
        <p>{t('whitelist.bulkDelete.message', { defaultValue: 'These addresses may be banned again if they trigger a ban rule.' })}</p>
        {targets.length !== selection.count && (
          <p className="mt-2 text-xs text-text-muted">{t('whitelist.bulkDelete.eligible', {
            defaultValue: '{{eligible}} of the {{selected}} selected entries can be removed from this tenant.',
            eligible: targets.length, selected: selection.count,
          })}</p>
        )}
      </>,
      confirmLabel: t('whitelist.actions.remove', { defaultValue: 'Remove' }),
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const r = await whitelistApi.bulkDelete(targets.map((e) => e.id));
      toast.success(t('whitelist.bulkDelete.done', { defaultValue: '{{count}} entries removed', count: r.deleted }));
      if (r.forbidden + r.notFound > 0) {
        toast.error(t('whitelist.bulkDelete.refused', {
          defaultValue: '{{count}} refused: {{reason}}',
          count: r.forbidden + r.notFound,
          reason: r.errors[0]?.error ?? '—',
        }));
      }
      selection.clear();
      notifyIpChanged(null);
    } catch (err) {
      toast.error(apiError(err, t('whitelist.errors.bulkDelete', { defaultValue: 'Bulk removal failed' })));
    } finally {
      setBulkBusy(false);
      void load();
    }
  };

  const remove = async (entry: WhitelistListItem): Promise<void> => {
    const text = entryText(entry.ip);
    const ok = await confirm({
      title: t('whitelist.remove.title', { defaultValue: 'Remove whitelist entry' }),
      message: entry.scope === 'global'
        ? t('whitelist.remove.globalConfirm', { defaultValue: 'Remove {{ip}} from the global whitelist? Every tenant may ban it again.', ip: text })
        : t('whitelist.remove.confirm', { defaultValue: 'Remove {{ip}} from the whitelist? It may be banned again if it triggers a ban rule.', ip: text }),
      confirmLabel: t('whitelist.actions.remove', { defaultValue: 'Remove' }),
      danger: true,
    });
    if (!ok) return;
    try {
      await whitelistApi.delete(entry.id);
      toast.success(t('whitelist.remove.done', { defaultValue: '{{ip}} removed from the whitelist', ip: text }));
      notifyIpChanged(text.includes('/') ? null : text);
    } catch (err) {
      toast.error(apiError(err, t('whitelist.errors.remove', { defaultValue: 'Failed to remove the whitelist entry' })));
    } finally {
      void load();
    }
  };

  // ── Add entry ──
  const [showAdd, setShowAdd] = useState(false);

  // ── Columns ──
  const showTenantCol = perms.isGodView;
  const colCount = 6 + (showTenantCol ? 1 : 0);
  const th = 'px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted';
  const scopeFilters: { key: ScopeFilter; label: string }[] = SCOPES.map((s) => ({
    key: s,
    label: s === 'all' ? t('whitelist.filters.all', { defaultValue: 'All' }) : t(`status.scope.${s}`, { defaultValue: s }),
  }));

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label={t('whitelist.filters.scope', { defaultValue: 'Scope' })} className="flex flex-wrap items-center gap-1.5">
          {scopeFilters.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={scope === f.key}
              onClick={() => setScope(f.key)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors coarse:min-h-10 coarse:px-4',
                scope === f.key
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-transparent bg-bg-secondary text-text-muted hover:text-text-primary',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('whitelist.searchPlaceholder', { defaultValue: 'IP, CIDR or label…' })}
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
          {perms.canWhitelist && (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus size={14} className="mr-1" />{t('whitelist.add.button', { defaultValue: 'Add entry' })}
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
          {perms.canWhitelist && (
            <Button size="sm" variant="secondary" disabled={bulkBusy || bulkDeleteRows.length === 0} onClick={() => void bulkDelete()}>
              <Trash2 size={12} className="mr-1" />{t('whitelist.actions.remove', { defaultValue: 'Remove' })}
              {bulkDeleteRows.length !== selection.count && <span className="ml-1 tabular-nums text-text-muted">({bulkDeleteRows.length})</span>}
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
              <th scope="col" className={cn(th, 'pl-3')}>
                <label className="flex items-center gap-3">
                  <input
                    ref={headerCheckbox}
                    type="checkbox"
                    className="accent-accent"
                    checked={selection.headerState === 'checked'}
                    disabled={rows.length === 0}
                    onChange={() => selection.toggleAllVisible()}
                    aria-label={t('whitelist.bulk.selectPage', { defaultValue: 'Select every entry of this page' })}
                  />
                  <span>{t('whitelist.columns.entry', { defaultValue: 'IP / range' })}</span>
                </label>
              </th>
              <th scope="col" className={th}>{t('whitelist.columns.label', { defaultValue: 'Label' })}</th>
              <SortableTh field="scope" sort={sort} onSort={onSort} className={th}>
                {t('whitelist.columns.scope', { defaultValue: 'Scope' })}
              </SortableTh>
              <th scope="col" className={th}>{t('whitelist.columns.createdBy', { defaultValue: 'Added by' })}</th>
              <SortableTh field="createdAt" sort={sort} onSort={onSort} className={th}>
                {t('whitelist.columns.createdAt', { defaultValue: 'Added at' })}
              </SortableTh>
              {showTenantCol && <th scope="col" className={th}>{t('whitelist.columns.tenant', { defaultValue: 'Tenant' })}</th>}
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
                  title={t('whitelist.loadFailed', { defaultValue: 'The whitelist could not be loaded' })}
                  action={<Button size="sm" variant="secondary" onClick={() => void load()}>{t('common.refresh', { defaultValue: 'Refresh' })}</Button>}
                />
              ) : hasFilters ? (
                <EmptyState variant="filtered" colSpan={colCount} onClearFilters={clearFilters} />
              ) : (
                <EmptyState
                  colSpan={colCount}
                  icon={<ShieldCheck size={32} strokeWidth={1.5} />}
                  title={t('whitelist.empty', { defaultValue: 'No whitelist entries' })}
                  description={t('whitelist.emptyHint', { defaultValue: 'Whitelisted addresses and ranges are never banned.' })}
                  action={perms.canWhitelist
                    ? <Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} className="mr-1" />{t('whitelist.add.button', { defaultValue: 'Add entry' })}</Button>
                    : undefined}
                />
              )
            ) : rows.map((entry) => (
              <WhitelistRow
                key={entry.id}
                entry={entry}
                perms={perms}
                showTenant={showTenantCol}
                selected={selection.selected.has(entry.id)}
                onToggle={() => selection.toggle(entry.id)}
                onOpen={() => openIp(entryText(entry.ip).split('/')[0])}
                onRemove={() => remove(entry)}
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

      <AddWhitelistModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={(ip) => { setShowAdd(false); notifyIpChanged(ip); void load(); }}
        perms={perms}
        tenantId={currentTenantId}
      />
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

interface WhitelistRowProps {
  entry: WhitelistListItem;
  perms: IpsPermissions;
  showTenant: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRemove: () => Promise<void>;
}

function WhitelistRow({ entry, perms, showTenant, selected, onToggle, onOpen, onRemove }: WhitelistRowProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const text = entryText(entry.ip);
  const canRemove = perms.canWhitelist && entry.canDelete === true;
  // Why the entry is locked here (server rule: whitelistDeleteVerdict).
  const lockedHint = entry.scope === 'global'
    ? t('whitelist.lockedGlobal', { defaultValue: 'Global entry: only the Default tenant can remove it' })
    : t('agents.foreignReadOnlyShort', { defaultValue: 'Read-only (other tenant)' });

  const items: ActionMenuItem[] = [
    { key: 'details', icon: <Globe size={14} />, label: t('ipReputation.actions.details', { defaultValue: 'Details' }), onClick: onOpen },
  ];

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
            aria-label={t('whitelist.bulk.select', { defaultValue: 'Select {{ip}}', ip: text })}
          />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="whitespace-nowrap rounded font-mono text-text-primary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {anonIp(text)}
          </button>
        </div>
      </td>
      <td className="max-w-[16rem] px-4 py-2 text-text-secondary">
        {entry.label
          ? <span className="block truncate" title={entry.label}>{entry.label}</span>
          : <span className="text-text-muted">—</span>}
      </td>
      <td className="px-4 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <ScopeBadge scope={entry.scope} scopeName={entry.scopeName} />
          {entry.scopeName && entry.scope !== 'tenant' && (
            <span className="max-w-[10rem] truncate text-xs text-text-secondary" title={entry.scopeId != null ? `#${entry.scopeId}` : undefined}>
              {entry.scopeName}
            </span>
          )}
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-text-secondary">
        {entry.createdByUsername ?? <span className="text-text-muted">—</span>}
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-text-muted">{formatWhen(entry.createdAt)}</td>
      {showTenant && (
        <td className="px-4 py-2">
          {entry.tenantId != null
            ? <TenantBadge tenantId={entry.tenantId} tenantName={entry.tenantName ?? undefined} />
            : <span className="text-xs text-text-muted">{t('status.scope.global', { defaultValue: 'Global' })}</span>}
        </td>
      )}
      <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          {canRemove ? (
            <Button size="sm" variant="secondary" disabled={busy}
              onClick={() => { setBusy(true); void onRemove().finally(() => setBusy(false)); }}>
              <Trash2 size={12} className="mr-1" />{t('whitelist.actions.remove', { defaultValue: 'Remove' })}
            </Button>
          ) : perms.canWhitelist ? (
            <span className="inline-flex p-1.5 text-text-muted" title={lockedHint} aria-label={lockedHint}>
              <Lock size={14} />
            </span>
          ) : null}
          <ActionMenu items={items} triggerSize="sm" disabled={busy} />
        </div>
      </td>
    </tr>
  );
}

// ── Add entry ────────────────────────────────────────────────────────────────

type AddScope = 'main' | 'group' | 'agent';

/** The groups of one tenant (god view trees may hold other tenants' groups). */
function ownTree(nodes: GroupTreeNode[], tenantId: number | null): GroupTreeNode[] {
  if (tenantId == null) return nodes;
  return nodes
    .filter((n) => n.tenantId == null || n.tenantId === tenantId)
    .map((n) => ({ ...n, children: ownTree(n.children, tenantId) }));
}

/**
 * New whitelist entry. The main scope follows the operating tenant (server
 * rule): global from Default (applies to every tenant, locked elsewhere),
 * tenant-local elsewhere. A group or agent of the operating tenant narrows it.
 */
function AddWhitelistModal({ open, onClose, onAdded, perms, tenantId }: {
  open: boolean;
  onClose: () => void;
  onAdded: (ip: string | null) => void;
  perms: IpsPermissions;
  tenantId: number | null;
}) {
  const { t } = useTranslation();
  const tree = useGroupStore((s) => s.tree);
  const fetchTree = useGroupStore((s) => s.fetchTree);
  const [ip, setIp] = useState('');
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<AddScope>('main');
  const [groupId, setGroupId] = useState<number | null>(null);
  const [agentId, setAgentId] = useState<number | null>(null);
  const [agents, setAgents] = useState<AgentDevice[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIp(''); setLabel(''); setScope('main'); setGroupId(null); setAgentId(null);
  }, [open]);

  useEffect(() => {
    if (!open || scope !== 'group' || tree.length > 0) return;
    void fetchTree();
  }, [open, scope, tree.length, fetchTree]);

  useEffect(() => {
    if (!open || scope !== 'agent') return;
    let cancelled = false;
    agentApi.listDevices('approved')
      .then((list) => {
        if (cancelled) return;
        // Only agents of the operating tenant the user may write.
        setAgents(list
          .filter((d) => (tenantId == null || d.tenantId === tenantId) && d.accessLevel !== 'ro')
          .sort((a, b) => (a.name || a.hostname).localeCompare(b.name || b.hostname)));
      })
      .catch(() => { if (!cancelled) setAgents([]); });
    return () => { cancelled = true; };
  }, [open, scope, tenantId]);

  const groups = useMemo(() => ownTree(tree, tenantId), [tree, tenantId]);

  const submit = async () => {
    const value = ip.trim();
    if (!value) {
      toast.error(t('whitelist.add.ipRequired', { defaultValue: 'The IP address or range is required' }));
      return;
    }
    if (scope === 'group' && groupId == null) {
      toast.error(t('whitelist.add.groupRequired', { defaultValue: 'Pick a group' }));
      return;
    }
    if (scope === 'agent' && agentId == null) {
      toast.error(t('whitelist.add.agentRequired', { defaultValue: 'Pick an agent' }));
      return;
    }
    const req: CreateWhitelistRequest = {
      ip: value,
      label: label.trim() || null,
      ...(scope === 'group' ? { scope: 'group' as const, scopeId: groupId } : {}),
      ...(scope === 'agent' ? { scope: 'agent' as const, scopeId: agentId } : {}),
    };
    setSaving(true);
    try {
      await whitelistApi.create(req);
      toast.success(t('whitelist.add.done', { defaultValue: '{{ip}} added to the whitelist', ip: value }));
      onAdded(value.includes('/') ? null : value);
    } catch (err) {
      toast.error(apiError(err, t('whitelist.errors.create', { defaultValue: 'Failed to add the whitelist entry' })));
    } finally {
      setSaving(false);
    }
  };

  const scopeOptions: { key: AddScope; label: string }[] = [
    {
      key: 'main',
      label: perms.canWhitelistGlobally
        ? t('status.scope.global', { defaultValue: 'Global' })
        : t('status.scope.tenant', { defaultValue: 'Tenant' }),
    },
    { key: 'group', label: t('status.scope.group', { defaultValue: 'Group' }) },
    { key: 'agent', label: t('status.scope.agent', { defaultValue: 'Agent' }) },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={t('whitelist.add.title', { defaultValue: 'Add a whitelist entry' })}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
          <Button loading={saving} onClick={() => void submit()}>
            <ShieldCheck size={14} className="mr-1" />{t('whitelist.add.submit', { defaultValue: 'Add entry' })}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <Input
          label={t('whitelist.add.target', { defaultValue: 'IP address or CIDR range' })}
          placeholder="192.0.2.10 / 192.0.2.0/24"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
        />
        <Input
          label={t('whitelist.add.label', { defaultValue: 'Label (optional)' })}
          placeholder={t('whitelist.add.labelPlaceholder', { defaultValue: 'e.g. Office network' })}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <div className="space-y-1">
          <span className="block text-sm font-medium text-text-secondary">{t('whitelist.columns.scope', { defaultValue: 'Scope' })}</span>
          <div role="radiogroup" className="grid grid-cols-3 gap-2">
            {scopeOptions.map((o) => (
              <button
                key={o.key}
                type="button"
                role="radio"
                aria-checked={scope === o.key}
                onClick={() => setScope(o.key)}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                  scope === o.key ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-tertiary text-text-muted hover:text-text-primary',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-muted">
            {scope === 'main'
              ? (perms.canWhitelistGlobally
                ? t('bans.whitelistGlobalHint', { defaultValue: 'Global whitelist entry: applies to every tenant and cannot be removed by other tenants.' })
                : t('bans.whitelistTenantHint', { defaultValue: 'Local whitelist entry: applies only to this tenant.' }))
              : scope === 'group'
                ? t('whitelist.add.groupHint', { defaultValue: 'Applies to the agents of the group and its subgroups.' })
                : t('whitelist.add.agentHint', { defaultValue: 'Applies to a single agent.' })}
          </p>
        </div>
        {scope === 'group' && (
          <GroupPicker
            value={groupId}
            onChange={setGroupId}
            tree={groups}
            kindFilter="agent"
            placeholder={t('whitelist.add.pickGroup', { defaultValue: 'Pick a group' })}
          />
        )}
        {scope === 'agent' && (
          <select
            value={agentId ?? ''}
            onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : null)}
            aria-label={t('whitelist.add.pickAgent', { defaultValue: 'Pick an agent' })}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">{t('whitelist.add.pickAgent', { defaultValue: 'Pick an agent' })}</option>
            {agents.map((d) => <option key={d.id} value={d.id}>{d.name || d.hostname}</option>)}
          </select>
        )}
      </div>
    </Modal>
  );
}
