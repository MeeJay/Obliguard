import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Download,
  Eraser,
  Eye,
  Globe,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  ShieldOff,
  Tag,
  X,
} from 'lucide-react';
import { SOCKET_EVENTS } from '@obliview/shared';
import type { AddIpReputationRequest, IpStatus } from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { TableScroll } from '@/components/common/TableScroll';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { Pagination } from '@/components/common/Pagination';
import { SortableTh, nextSort, type SortState } from '@/components/common/SortableTh';
import { TenantBadge } from '@/components/common/TenantBadge';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { IpStatusBadge, resolveIpStatus } from '@/components/status/IpStatusBadge';
import { countryFlag, formatWhen, useIpActions } from '@/components/ip/IpDetailDrawer';
import { useIpsPermissions } from '@/hooks/useIpsPermissions';
import { useIpChanged, useIpDrawer, notifyIpChanged } from '@/hooks/useIpDrawer';
import { useRowSelection } from '@/hooks/useRowSelection';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useSocketRefresh } from '@/hooks/useSocketRefresh';
import { useTenantFilter } from '@/hooks/useTenantFilter';
import {
  apiErrorMessage,
  ipReputationApi,
  type IpReputationRow,
  type ReputationSortBy,
} from '@/api/ipReputation.api';
import { ipLabelsApi } from '@/api/ipLabels.api';
import { bansApi } from '@/api/bans.api';
import { anonIp } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import { CSV_EXPORT_MAX, csvExportError, downloadCsvExport } from '@/utils/download';

// ── URL state ────────────────────────────────────────────────────────────────
// ?status= ?search= ?page= ?sortBy= ?sortOrder= ?tenants= (god view). The
// unprefixed names are the deep-link contract (header chips, NetMap, live
// alerts link to /ip-reputation?status=…&search=…).

type StatusFilter = 'all' | IpStatus;

const STATUSES: readonly IpStatus[] = ['banned', 'suspicious', 'whitelisted', 'clean'];
const SORT_KEYS: readonly ReputationSortBy[] = ['lastSeen', 'failures', 'agents', 'country', 'firstSeen'];
const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

/** Reload the list when the server reports a ban / whitelist change. */
const BAN_SOCKET_EVENTS = [
  SOCKET_EVENTS.BAN_CREATED,
  SOCKET_EVENTS.BAN_UPDATED,
  SOCKET_EVENTS.BAN_LIFTED,
  SOCKET_EVENTS.BAN_AUTO,
  SOCKET_EVENTS.BAN_EXCLUDED,
  SOCKET_EVENTS.BAN_EXCLUSION_REMOVED,
  SOCKET_EVENTS.BAN_BULK_LIFTED,
  SOCKET_EVENTS.WHITELIST_CHANGED,
];

function parseStatus(v: string | null): StatusFilter {
  return v !== null && (STATUSES as readonly string[]).includes(v) ? (v as IpStatus) : 'all';
}

function parsePage(v: string | null): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function parseSortParam(by: string | null, order: string | null): SortState<ReputationSortBy> {
  if (by === null || !(SORT_KEYS as readonly string[]).includes(by)) return null;
  return { field: by as ReputationSortBy, dir: order === 'asc' ? 'asc' : 'desc' };
}

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
 * Activity tab of the IP Reputation hub: every IP the agents reported, with
 * server-side filters / sort / paging kept in the URL, explicit-selection
 * bulk actions and the shared IP drawer (?ip=).
 */
export default function ActivityTab() {
  const { t } = useTranslation();
  const perms = useIpsPermissions();
  const actions = useIpActions();
  const askConfirm = useConfirm();
  const askText = usePrompt();
  const { open: openIp } = useIpDrawer();
  const tenantFilter = useTenantFilter();

  const [searchParams, setSearchParams] = useSearchParams();
  const status = parseStatus(searchParams.get('status'));
  const urlSearch = (searchParams.get('search') ?? '').trim();
  const page = parsePage(searchParams.get('page'));
  const sort = parseSortParam(searchParams.get('sortBy'), searchParams.get('sortOrder'));
  const [pageSizeRaw, setPageSize] = usePersistedState<number>('og-ip-activity-page-size', DEFAULT_PAGE_SIZE);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(pageSizeRaw) ? pageSizeRaw : DEFAULT_PAGE_SIZE;
  // Tenant chips exist only in the god view: a stray ?tenants= (shared link) is ignored elsewhere.
  const tenantIds = useMemo(
    () => (perms.isGodView ? [...tenantFilter.value].sort((a, b) => a - b) : []),
    [perms.isGodView, tenantFilter.value],
  );
  const tenantsKey = tenantIds.join(',');

  /** One URL write (replace). Filter changes go back to page 1. */
  const updateParams = useCallback((mutate: (p: URLSearchParams) => void, resetPage = true) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      mutate(p);
      if (resetPage) p.delete('page');
      return p;
    }, { replace: true });
  }, [setSearchParams]);

  // ── Search box (debounced into ?search=) ──
  const [search, setSearch] = useState(urlSearch);
  const lastWrittenSearch = useRef(urlSearch);
  useEffect(() => {
    // External navigation (header chip, NetMap link, Back): adopt the URL.
    if (urlSearch === lastWrittenSearch.current) return;
    lastWrittenSearch.current = urlSearch;
    setSearch(urlSearch);
  }, [urlSearch]);
  useEffect(() => {
    const q = search.trim();
    if (q === lastWrittenSearch.current) return;
    const timer = setTimeout(() => {
      lastWrittenSearch.current = q;
      updateParams((p) => { if (q) p.set('search', q); else p.delete('search'); });
    }, 300);
    return () => clearTimeout(timer);
  }, [search, updateParams]);

  const setStatus = (next: StatusFilter) => updateParams((p) => {
    if (next === 'all') p.delete('status'); else p.set('status', next);
  });
  const setPage = (next: number) => updateParams((p) => {
    if (next <= 1) p.delete('page'); else p.set('page', String(next));
  }, false);
  const onSort = (field: ReputationSortBy) => {
    const next = nextSort(sort, field);
    updateParams((p) => {
      if (next) { p.set('sortBy', next.field); p.set('sortOrder', next.dir); } else { p.delete('sortBy'); p.delete('sortOrder'); }
    });
  };
  const setTenants = (next: Set<number>) => updateParams((p) => {
    if (next.size === 0) p.delete('tenants');
    else p.set('tenants', [...next].sort((a, b) => a - b).join(','));
  });
  const hasFilters = status !== 'all' || urlSearch !== '' || tenantIds.length > 0;
  const clearFilters = () => {
    lastWrittenSearch.current = '';
    setSearch('');
    updateParams((p) => { p.delete('status'); p.delete('search'); p.delete('tenants'); });
  };

  // ── Data ──
  const [rows, setRows] = useState<IpReputationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const res = await ipReputationApi.list({
        status: status === 'all' ? undefined : status,
        search: urlSearch || undefined,
        page,
        pageSize,
        sortBy: sort?.field,
        sortOrder: sort?.dir,
        tenantIds: tenantsKey ? tenantsKey.split(',').map(Number) : undefined,
      });
      if (seq !== requestSeq.current) return;
      setRows(res.data);
      setTotal(res.total);
      setLoadError(false);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(true);
      toast.error(apiErrorMessage(err, t('ipReputation.errors.load', { defaultValue: 'Failed to load the IP reputation list' })));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [status, urlSearch, page, pageSize, sort?.field, sort?.dir, tenantsKey, t]);

  // ── CSV export (current filters, server-side, capped) ──
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const params: Record<string, string | number> = {};
      if (status !== 'all') params.status = status;
      if (urlSearch) params.search = urlSearch;
      if (sort) { params.sortBy = sort.field; params.sortOrder = sort.dir; }
      if (tenantsKey) params.tenants = tenantsKey;
      const r = await downloadCsvExport('/ip-reputation/export', params, 'ip-reputation.csv');
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

  const loadLabels = useCallback(async () => {
    try {
      const list = await ipLabelsApi.list();
      const m = new Map<string, string>();
      for (const { ip, label } of list) if (label) m.set(ip, label);
      setLabels(m);
    } catch {
      // Labels are decoration: the list stays usable without them.
      setLabels(new Map());
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadLabels(); }, [loadLabels]);
  useSocketRefresh(BAN_SOCKET_EVENTS, load, { debounceMs: 1500 });
  useIpChanged(() => { void load(); void loadLabels(); });

  // A page past the end (rows removed meanwhile): go to the last page.
  useEffect(() => {
    if (!loading && rows.length === 0 && page > 1 && total > 0) {
      setPage(Math.max(1, Math.ceil(total / pageSize)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, rows.length, page, total, pageSize]);

  // ── Selection (cleared on any filter / page / sort change) ──
  const visibleIps = useMemo(() => rows.map((r) => r.ip), [rows]);
  const selection = useRowSelection(visibleIps, [status, urlSearch, tenantsKey, page, pageSize, sort]);
  const selectedRows = useMemo(() => rows.filter((r) => selection.selected.has(r.ip)), [rows, selection.selected]);
  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = selection.headerState === 'indeterminate';
  }, [selection.headerState]);

  const bulkBanRows = selectedRows.filter((r) => r.status !== 'banned' && r.status !== 'whitelisted');
  const bulkWhitelistRows = selectedRows.filter((r) => r.status !== 'whitelisted');
  const bulkLiftRows = selectedRows.filter((r) => r.status === 'banned' && r.activeBanId != null && !r.activeBanExcluded);
  const bulkClearRows = selectedRows.filter((r) => r.status === 'suspicious');
  const [bulkBusy, setBulkBusy] = useState(false);

  const countLabel = (eligible: number) => t('ipReputation.bulk.eligible', {
    defaultValue: '{{eligible}} of the {{selected}} selected IPs qualify.',
    eligible,
    selected: selection.count,
  });

  const finishBulk = () => {
    selection.clear();
    notifyIpChanged(null);
  };

  const bulkBan = async () => {
    const ips = bulkBanRows.map((r) => r.ip);
    if (ips.length === 0) return;
    const ok = await askConfirm({
      title: t('ipReputation.bulk.banTitle', { defaultValue: 'Ban selected IPs' }),
      message: <>
        <p>{perms.isGodView
          ? t('bans.bulkConfirmGlobal', { defaultValue: 'Ban {{count}} IPs globally (every agent of every tenant)?', count: ips.length })
          : t('bans.bulkConfirmLocal', { defaultValue: 'Ban {{count}} IPs on this tenant?', count: ips.length })}</p>
        {ips.length !== selection.count && <p className="mt-2 text-xs text-text-muted">{countLabel(ips.length)}</p>}
      </>,
      confirmLabel: t('ipReputation.actions.ban', { defaultValue: 'Ban' }),
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const r = await ipReputationApi.bulkBan(ips);
      toast.success(t('bans.bulkResult', {
        defaultValue: '{{created}} banned, {{skipped}} skipped (already banned or whitelisted), {{invalid}} invalid',
        created: r.created, skipped: r.skipped, invalid: r.invalid,
      }));
      if (r.invalid > 0) {
        toast.error(t('bans.bulkInvalid', {
          defaultValue: 'Ignored: {{list}}',
          list: r.invalidEntries.slice(0, 5).map((e) => `${e.ip} (${e.reason})`).join(', '),
        }));
      }
      finishBulk();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.bulkBan', { defaultValue: 'Bulk ban failed' })));
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkWhitelist = async () => {
    const ips = bulkWhitelistRows.map((r) => r.ip);
    if (ips.length === 0) return;
    const label = await askText({
      title: t('ipReputation.bulk.whitelistTitle', { defaultValue: 'Whitelist {{count}} IPs', count: ips.length }),
      message: <>
        <p>{perms.canWhitelistGlobally
          ? t('bans.whitelistGlobalHint', { defaultValue: 'Global whitelist entry: applies to every tenant and cannot be removed by other tenants.' })
          : t('bans.whitelistTenantHint', { defaultValue: 'Local whitelist entry: applies only to this tenant.' })}</p>
        {ips.length !== selection.count && <p className="mt-2 text-xs text-text-muted">{countLabel(ips.length)}</p>}
      </>,
      placeholder: t('ipReputation.whitelist.labelPlaceholder', { defaultValue: 'Label (optional), e.g. Office VPN' }),
      confirmLabel: t('ipReputation.actions.whitelist', { defaultValue: 'Whitelist' }),
    });
    if (label === null) return;
    setBulkBusy(true);
    try {
      const r = await ipReputationApi.bulkWhitelist(ips, label.trim() || undefined);
      toast.success(t('ipReputation.bulk.whitelistDone', {
        defaultValue: '{{created}} whitelisted, {{invalid}} invalid',
        created: r.created, invalid: r.invalid ?? 0,
      }));
      finishBulk();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.bulkWhitelist', { defaultValue: 'Bulk whitelist failed' })));
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkLift = async () => {
    const targets = bulkLiftRows.map((r) => ({ ip: r.ip, banId: r.activeBanId! }));
    if (targets.length === 0) return;
    const ok = await askConfirm({
      title: t('ipReputation.bulk.liftTitle', { defaultValue: 'Lift selected bans' }),
      message: <>
        <p>{perms.canLiftGlobally
          ? t('ipReputation.bulk.liftGlobal', { defaultValue: 'Lift the bans of {{count}} IPs for every tenant?', count: targets.length })
          : t('ipReputation.bulk.liftLocal', { defaultValue: 'Lift the bans of {{count}} IPs on this tenant? Other tenants keep their own decision.', count: targets.length })}</p>
        {targets.length !== selection.count && <p className="mt-2 text-xs text-text-muted">{countLabel(targets.length)}</p>}
      </>,
      confirmLabel: t('ipReputation.actions.lift', { defaultValue: 'Lift' }),
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      // One server batch (POST /bans/bulk-lift): global lift from Default,
      // local exclusions elsewhere, same rule as the single Lift.
      const r = await bansApi.bulkLift(targets.map((x) => x.banId));
      const done = r.lifted + r.excluded + r.skipped;
      const msg = t('ipReputation.bulk.liftDone', { defaultValue: '{{ok}} lifted, {{failed}} failed', ok: done, failed: r.refused });
      if (r.refused > 0) toast.error(msg); else toast.success(msg);
      finishBulk();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.bulkLift', { defaultValue: 'Bulk lift failed' })));
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkClear = async () => {
    const ips = bulkClearRows.map((r) => r.ip);
    if (ips.length === 0) return;
    const ok = await askConfirm({
      title: t('ipReputation.bulk.clearTitle', { defaultValue: 'Clear suspicious status' }),
      message: <>
        <p>{actions.clearsGlobally
          ? t('ipReputation.bulk.clearGlobal', { defaultValue: 'Reset the failure counter of {{count}} IPs to 0 for every tenant?', count: ips.length })
          : t('ipReputation.bulk.clearLocal', { defaultValue: 'Mark {{count}} IPs as reviewed on this tenant?', count: ips.length })}</p>
        {ips.length !== selection.count && <p className="mt-2 text-xs text-text-muted">{countLabel(ips.length)}</p>}
      </>,
      confirmLabel: t('ipReputation.actions.clear', { defaultValue: 'Clear' }),
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const r = await runBulk(ips, (ip) => ipReputationApi.clear(ip));
      const msg = t('ipReputation.bulk.clearDone', { defaultValue: '{{ok}} cleared, {{failed}} failed', ok: r.ok, failed: r.failed });
      if (r.failed > 0) toast.error(msg); else toast.success(msg);
      finishBulk();
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkLabel = async () => {
    const ips = selectedRows.map((r) => r.ip);
    if (ips.length === 0) return;
    const value = await askText({
      title: t('ipReputation.bulk.labelTitle', { defaultValue: 'Label {{count}} IPs', count: ips.length }),
      message: t('ipReputation.bulk.labelHint', { defaultValue: 'The same label is set on every selected IP. Leave empty to remove their labels.' }),
      placeholder: t('ipReputation.label.placeholder', { defaultValue: 'e.g. Home router, Office ISP…' }),
      confirmLabel: t('common.save', { defaultValue: 'Save' }),
    });
    if (value === null) return;
    const label = value.trim();
    const targets = label ? ips : ips.filter((ip) => labels.has(ip));
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      const r = await runBulk(targets, (ip) => (label ? ipLabelsApi.upsert(ip, label) : ipLabelsApi.remove(ip)));
      const msg = t('ipReputation.bulk.labelDone', { defaultValue: '{{ok}} updated, {{failed}} failed', ok: r.ok, failed: r.failed });
      if (r.failed > 0) toast.error(msg); else toast.success(msg);
      finishBulk();
    } finally {
      setBulkBusy(false);
    }
  };

  // ── Add IP ──
  const canAddAny = perms.canBan || perms.canWhitelist || perms.canClear;
  const [showAdd, setShowAdd] = useState(false);

  // ── Columns ──
  const showTenantCol = perms.isGodView && rows.some((r) => r.tenantId != null);
  const colCount = 9 + (showTenantCol ? 1 : 0);
  const statusFilters: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: t('ipReputation.filters.all', { defaultValue: 'All' }) },
    { key: 'banned', label: t('status.ip.banned', { defaultValue: 'Banned' }) },
    { key: 'suspicious', label: t('status.ip.suspicious', { defaultValue: 'Suspicious' }) },
    { key: 'whitelisted', label: t('status.ip.whitelisted', { defaultValue: 'Whitelisted' }) },
    { key: 'clean', label: t('status.ip.clean', { defaultValue: 'Clean' }) },
  ];
  const th = 'px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-text-muted';

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label={t('ipReputation.filters.status', { defaultValue: 'Status' })} className="flex flex-wrap items-center gap-1.5">
          {statusFilters.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={status === f.key}
              onClick={() => setStatus(f.key)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors coarse:min-h-10 coarse:px-4',
                status === f.key
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
            placeholder={t('ipReputation.searchPlaceholder', { defaultValue: 'IP, CIDR or text…' })}
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
          {canAddAny && (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus size={14} className="mr-1" />{t('ipReputation.addIp', { defaultValue: 'Add IP' })}
            </Button>
          )}
        </div>
      </div>

      <TenantFilterChips value={tenantFilter.value} onChange={setTenants} />

      {/* Bulk bar */}
      {selection.count > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/20 bg-accent/10 px-3 py-2">
          <span className="text-sm font-medium text-accent">
            {t('ipReputation.bulk.selected', { defaultValue: '{{count}} selected', count: selection.count })}
          </span>
          {perms.canBan && (
            <Button size="sm" variant="secondary" disabled={bulkBusy || bulkBanRows.length === 0} onClick={() => void bulkBan()}>
              <ShieldOff size={12} className="mr-1" />{t('ipReputation.actions.ban', { defaultValue: 'Ban' })}
              {bulkBanRows.length !== selection.count && <span className="ml-1 tabular-nums text-text-muted">({bulkBanRows.length})</span>}
            </Button>
          )}
          {perms.canWhitelist && (
            <Button size="sm" variant="secondary" disabled={bulkBusy || bulkWhitelistRows.length === 0} onClick={() => void bulkWhitelist()}>
              <ShieldCheck size={12} className="mr-1" />{t('ipReputation.actions.whitelist', { defaultValue: 'Whitelist' })}
              {bulkWhitelistRows.length !== selection.count && <span className="ml-1 tabular-nums text-text-muted">({bulkWhitelistRows.length})</span>}
            </Button>
          )}
          {perms.canLift && (
            <Button size="sm" variant="secondary" disabled={bulkBusy || bulkLiftRows.length === 0} onClick={() => void bulkLift()}>
              <Shield size={12} className="mr-1" />{t('ipReputation.actions.lift', { defaultValue: 'Lift' })}
              {bulkLiftRows.length !== selection.count && <span className="ml-1 tabular-nums text-text-muted">({bulkLiftRows.length})</span>}
            </Button>
          )}
          {perms.canClear && (
            <Button size="sm" variant="secondary" disabled={bulkBusy || bulkClearRows.length === 0} onClick={() => void bulkClear()}>
              <Eraser size={12} className="mr-1" />{t('ipReputation.actions.clear', { defaultValue: 'Clear' })}
              {bulkClearRows.length !== selection.count && <span className="ml-1 tabular-nums text-text-muted">({bulkClearRows.length})</span>}
            </Button>
          )}
          {perms.canLabel && (
            <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => void bulkLabel()}>
              <Tag size={12} className="mr-1" />{t('ipReputation.actions.label', { defaultValue: 'Label' })}
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
                    aria-label={t('ipReputation.bulk.selectPage', { defaultValue: 'Select every IP of this page' })}
                  />
                  <span>{t('ipReputation.columns.ip', { defaultValue: 'IP address' })}</span>
                </label>
              </th>
              <th scope="col" className={th}>{t('ipReputation.columns.status', { defaultValue: 'Status' })}</th>
              <SortableTh field="country" sort={sort} onSort={onSort} className={th}>
                {t('ipReputation.columns.location', { defaultValue: 'Location' })}
              </SortableTh>
              <SortableTh field="failures" sort={sort} onSort={onSort} align="right" className={th}>
                {t('ipReputation.columns.failures', { defaultValue: 'Failures' })}
              </SortableTh>
              <SortableTh field="agents" sort={sort} onSort={onSort} align="right" className={th}>
                {t('ipReputation.columns.agents', { defaultValue: 'Agents' })}
              </SortableTh>
              <th scope="col" className={th}>{t('ipReputation.columns.services', { defaultValue: 'Services' })}</th>
              <SortableTh field="firstSeen" sort={sort} onSort={onSort} className={th}>
                {t('ipReputation.columns.firstSeen', { defaultValue: 'First seen' })}
              </SortableTh>
              <SortableTh field="lastSeen" sort={sort} onSort={onSort} className={th}>
                {t('ipReputation.columns.lastSeen', { defaultValue: 'Last seen' })}
              </SortableTh>
              {showTenantCol && <th scope="col" className={th}>{t('ipReputation.columns.tenant', { defaultValue: 'Tenant' })}</th>}
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
                  title={t('ipReputation.loadFailed', { defaultValue: 'The list could not be loaded' })}
                  action={<Button size="sm" variant="secondary" onClick={() => void load()}>{t('common.refresh', { defaultValue: 'Refresh' })}</Button>}
                />
              ) : hasFilters ? (
                <EmptyState variant="filtered" colSpan={colCount} onClearFilters={clearFilters} />
              ) : (
                <EmptyState
                  colSpan={colCount}
                  icon={<Globe size={32} strokeWidth={1.5} />}
                  title={t('ipReputation.empty', { defaultValue: 'No IP activity yet' })}
                  description={t('ipReputation.emptyHint', { defaultValue: 'IPs appear here as soon as an agent reports an authentication event.' })}
                />
              )
            ) : rows.map((row) => (
              <ActivityRow
                key={row.ip}
                row={row}
                label={labels.get(row.ip)}
                selected={selection.selected.has(row.ip)}
                onToggle={() => selection.toggle(row.ip)}
                onOpen={() => openIp(row.ip)}
                showTenant={showTenantCol}
                perms={perms}
                actions={actions}
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

      <AddIpModal open={showAdd} onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); void load(); }} />
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

interface ActivityRowProps {
  row: IpReputationRow;
  label?: string;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  showTenant: boolean;
  perms: ReturnType<typeof useIpsPermissions>;
  actions: ReturnType<typeof useIpActions>;
}

function ActivityRow({ row, label, selected, onToggle, onOpen, showTenant, perms, actions }: ActivityRowProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const target = { ip: row.ip, banId: row.activeBanId ?? null };
  const banned = row.status === 'banned';
  const whitelisted = row.status === 'whitelisted';
  const excluded = !!row.activeBanExcluded;
  const canLift = perms.canLift && banned && !excluded && row.activeBanId != null;
  const canReEnable = perms.canLift && banned && excluded && row.activeBanId != null;
  const canBan = perms.canBan && !banned && !whitelisted;
  const canPromote = perms.canPromote && banned && row.activeBanId != null && !!row.activeBanScope && row.activeBanScope !== 'global';
  const canClear = perms.canClear && row.status === 'suspicious';

  // One primary action inline, the rest in the menu.
  let primary: ReactNode = null;
  if (canLift) {
    primary = (
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => actions.lift(target))}
        title={perms.canLiftGlobally
          ? t('ipReputation.actions.liftGlobal', { defaultValue: 'Lift for every tenant' })
          : t('ipReputation.actions.liftLocal', { defaultValue: 'Lift on this tenant' })}>
        <Shield size={12} className="mr-1" />{t('ipReputation.actions.lift', { defaultValue: 'Lift' })}
      </Button>
    );
  } else if (canReEnable) {
    primary = (
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => actions.reEnable(target))}>
        <Eye size={12} className="mr-1" />{t('ipReputation.actions.reEnable', { defaultValue: 'Re-enable' })}
      </Button>
    );
  } else if (canBan) {
    primary = (
      <Button size="sm" variant="danger" disabled={busy} onClick={() => run(() => actions.ban(target))}>
        <ShieldOff size={12} className="mr-1" />{t('ipReputation.actions.ban', { defaultValue: 'Ban' })}
      </Button>
    );
  }

  const items: ActionMenuItem[] = [
    { key: 'details', icon: <Globe size={14} />, label: t('ipReputation.actions.details', { defaultValue: 'Details' }), onClick: onOpen },
    { key: 'whitelist', icon: <ShieldCheck size={14} />, label: t('ipReputation.actions.whitelist', { defaultValue: 'Whitelist' }), onClick: () => run(() => actions.whitelist(target)), hidden: !perms.canWhitelist || whitelisted, separator: true },
    { key: 'unwhitelist', icon: <ShieldOff size={14} />, label: t('ipReputation.unwhitelist.title', { defaultValue: 'Remove from whitelist' }), onClick: () => run(() => actions.unwhitelist(target)), hidden: !perms.canWhitelist || !whitelisted, danger: true },
    { key: 'promote', icon: <Globe size={14} />, label: t('bans.promoteButton', { defaultValue: 'Promote to global' }), onClick: () => run(() => actions.promote(target)), hidden: !canPromote },
    { key: 'clear', icon: <Eraser size={14} />, label: t('ipReputation.actions.clear', { defaultValue: 'Clear' }), onClick: () => run(() => actions.clear(target)), hidden: !canClear },
    { key: 'label', icon: <Tag size={14} />, label: label ? t('ipReputation.actions.editLabel', { defaultValue: 'Edit label' }) : t('ipReputation.actions.addLabel', { defaultValue: 'Add label' }), onClick: () => run(() => actions.editLabel(target, label)), hidden: !perms.canLabel, separator: true },
  ];

  const services = row.affectedServices ?? [];
  const flag = countryFlag(row.geoCountryCode);
  const location = [row.geoCity, row.geoCountryCode].filter(Boolean).join(', ');

  return (
    <tr
      onClick={onOpen}
      className={cn('h-11 cursor-pointer transition-colors hover:bg-bg-hover', selected && 'bg-accent/5')}
    >
      <td className="px-3 py-2">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            className="accent-accent"
            checked={selected}
            onChange={onToggle}
            onClick={(e) => e.stopPropagation()}
            aria-label={t('ipReputation.bulk.selectIp', { defaultValue: 'Select {{ip}}', ip: row.ip })}
          />
          <div className="min-w-0">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpen(); }}
              className="font-mono text-text-primary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded"
            >
              {anonIp(row.ip)}
            </button>
            {label && (
              <div className="mt-0.5 flex items-center gap-1 text-xs text-accent">
                <Tag size={10} className="shrink-0" aria-hidden="true" /><span className="truncate">{label}</span>
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <IpStatusBadge status={resolveIpStatus(row)} />
          {row.clearedForTenant && (
            <span className="inline-flex items-center gap-1 rounded-full border border-blue-400/30 bg-blue-400/10 px-2 py-0.5 text-[11px] font-medium text-blue-400">
              <Eraser size={9} aria-hidden="true" />{t('ipReputation.cleared', { defaultValue: 'Cleared' })}
            </span>
          )}
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-text-secondary">
        {location ? <>{flag && <span className="mr-1.5">{flag}</span>}{location}</> : <span className="text-text-muted">—</span>}
      </td>
      <td className="px-4 py-2 text-right tabular-nums text-text-secondary">{row.totalFailures.toLocaleString()}</td>
      <td className="px-4 py-2 text-right tabular-nums text-text-muted">{row.affectedAgentsCount > 0 ? row.affectedAgentsCount : '—'}</td>
      <td className="px-4 py-2">
        <div className="flex flex-wrap gap-1">
          {services.slice(0, 3).map((svc) => (
            <span key={svc} className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[11px] text-text-secondary">{svc}</span>
          ))}
          {services.length > 3 && <span className="text-[11px] text-text-muted">+{services.length - 3}</span>}
          {services.length === 0 && <span className="text-text-muted">—</span>}
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-text-muted">{formatWhen(row.firstSeen)}</td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-text-muted">{formatWhen(row.lastSeen)}</td>
      {showTenant && (
        <td className="px-4 py-2"><TenantBadge tenantId={row.tenantId} tenantName={row.tenantName} /></td>
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

// ── Add IP ───────────────────────────────────────────────────────────────────

const STATUS_OPTION_COLORS: Record<IpStatus, string> = {
  banned: 'border-red-500/30 bg-red-500/10 text-red-400',
  suspicious: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  whitelisted: 'border-green-500/30 bg-green-500/10 text-green-400',
  clean: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
};

/**
 * Manually add an IP with a status. Options follow the server gates
 * (ipReputationAddCapabilities): banned → bans.create, whitelisted →
 * whitelist.write, clean → ip.reputation.clear, suspicious → that too and
 * the Default tenant only (it drops every tenant's clear baseline).
 */
function AddIpModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const { t } = useTranslation();
  const perms = useIpsPermissions();
  const options = useMemo(() => ([
    { value: 'banned' as const, allowed: perms.canBan },
    { value: 'whitelisted' as const, allowed: perms.canWhitelist },
    { value: 'suspicious' as const, allowed: perms.canClear && perms.isGodView },
    { value: 'clean' as const, allowed: perms.canClear },
  ]).filter((o) => o.allowed).map((o) => o.value), [perms.canBan, perms.canWhitelist, perms.canClear, perms.isGodView]);

  const [ip, setIp] = useState('');
  const [status, setStatus] = useState<IpStatus>(options[0] ?? 'banned');
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIp(''); setLabel(''); setReason(''); setExpiresAt('');
    setStatus(options[0] ?? 'banned');
    // Reset on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const value = ip.trim();
    if (!value) {
      toast.error(t('ipReputation.add.ipRequired', { defaultValue: 'The IP address is required' }));
      return;
    }
    const req: AddIpReputationRequest = { ip: value, status };
    if (status === 'banned') {
      req.reason = reason.trim() || null;
      req.expiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
    } else if (status === 'whitelisted') {
      req.label = label.trim() || null;
    }
    setSaving(true);
    try {
      await ipReputationApi.add(req);
      toast.success(t('ipReputation.add.done', { defaultValue: '{{ip}} added as {{status}}', ip: value, status: t(`status.ip.${status}`, { defaultValue: status }) }));
      notifyIpChanged(value);
      onAdded();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('ipReputation.errors.add', { defaultValue: 'Failed to add the IP' })));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={t('ipReputation.add.title', { defaultValue: 'Add an IP' })}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
          <Button loading={saving} disabled={options.length === 0} onClick={() => void submit()}>
            <Plus size={14} className="mr-1" />{t('ipReputation.addIp', { defaultValue: 'Add IP' })}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <Input
          label={t('ipReputation.columns.ip', { defaultValue: 'IP address' })}
          placeholder="203.0.113.10"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
        />

        <div className="space-y-1">
          <span className="block text-sm font-medium text-text-secondary">{t('ipReputation.columns.status', { defaultValue: 'Status' })}</span>
          <div role="radiogroup" className="grid grid-cols-2 gap-2">
            {options.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={status === value}
                onClick={() => setStatus(value)}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                  status === value ? STATUS_OPTION_COLORS[value] : 'border-border bg-bg-tertiary text-text-muted hover:text-text-primary',
                )}
              >
                {t(`status.ip.${value}`, { defaultValue: value })}
              </button>
            ))}
          </div>
        </div>

        {status === 'banned' && (
          <>
            <p className="text-xs text-text-muted">
              {perms.isGodView
                ? t('bans.scopeGlobalHint', { defaultValue: 'Global ban: enforced on every agent of every tenant.' })
                : t('bans.scopeTenantHint', { defaultValue: 'Local ban: enforced only on the agents of this tenant.' })}
            </p>
            <Input
              label={t('ipReputation.add.reason', { defaultValue: 'Reason (optional)' })}
              placeholder={t('ipReputation.banReasonPlaceholder', { defaultValue: 'Why is this IP being banned?' })}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="space-y-1">
              <label htmlFor="ip-add-expires" className="block text-sm font-medium text-text-secondary">
                {t('ipReputation.add.expiresAt', { defaultValue: 'Expires at (optional)' })}
              </label>
              <input
                id="ip-add-expires"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <p className="text-xs text-text-muted">{t('ipReputation.add.permanentHint', { defaultValue: 'Leave empty for a permanent ban.' })}</p>
            </div>
          </>
        )}

        {status === 'whitelisted' && (
          <>
            <p className="text-xs text-text-muted">
              {perms.canWhitelistGlobally
                ? t('bans.whitelistGlobalHint', { defaultValue: 'Global whitelist entry: applies to every tenant and cannot be removed by other tenants.' })
                : t('bans.whitelistTenantHint', { defaultValue: 'Local whitelist entry: applies only to this tenant.' })}
            </p>
            <Input
              label={t('ipReputation.add.label', { defaultValue: 'Label (optional)' })}
              placeholder={t('ipReputation.add.labelPlaceholder', { defaultValue: 'e.g. Office VPN' })}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </>
        )}

        {status === 'suspicious' && (
          <p className="text-xs text-text-muted">
            {t('ipReputation.add.suspiciousHint', { defaultValue: 'Marks the IP suspicious for every tenant (their previous reviews are dropped).' })}
          </p>
        )}
      </div>
    </Modal>
  );
}
