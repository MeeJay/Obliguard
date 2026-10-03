import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Download, RefreshCw, ScrollText, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { auditApi, type AuditLogRow } from '@/api/audit.api';
import { Button } from '@/components/common/Button';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { Pagination } from '@/components/common/Pagination';
import { TableScroll } from '@/components/common/TableScroll';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { TenantBadge } from '@/components/common/TenantBadge';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { useIsPlatformAdmin } from '@/hooks/usePermission';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useTenantFilter } from '@/hooks/useTenantFilter';
import { anonHostname, anonIp, anonUsername } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import { saveCsv } from '@/utils/download';

// ── Audit log page ──────────────────────────────────────────────────────────
//
// Port of Obliance AuditLogPage: who did what, when, from where, on which
// agent. Filters live in the URL (shareable links, Back), the god view adds a
// tenant column + chips, rows expand to their details, CSV export through
// utils/download. Route guard: audit.read (App.tsx).

const PAGE_SIZE = 50;
const PAGE_SIZES = [25, 50, 100, 200] as const;
/** Most rows one CSV export pulls (the server's page cap). */
const EXPORT_MAX = 500;

/** URL parameters of the filters. */
const P = {
  search: 'q',
  action: 'action',
  actor: 'actor',
  status: 'status',
  from: 'from',
  to: 'to',
  /** Agent id (the agent detail Activity tab links here). */
  device: 'device',
  page: 'page',
  size: 'size',
} as const;

const selectClass = 'rounded-md border border-border bg-bg-tertiary px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent';

/** Destructive / security-relevant actions get a colour, the rest stay neutral. */
export function AuditActionPill({ action, success }: { action: string; success: boolean }) {
  const destructive = /deleted|wiped|purged|removed|refused|disabled|uninstall|lifted|pruned/.test(action);
  const security = /^(auth|profile|user|tenant|team|permission_set|app_config|agent_key|sso)\./.test(action);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium',
        !success ? 'border-status-down/40 bg-status-down/10 text-status-down'
          : destructive ? 'border-orange-400/30 bg-orange-400/10 text-orange-400'
          : security ? 'border-accent/30 bg-accent/10 text-accent'
          : 'border-transparent bg-bg-tertiary text-text-secondary',
      )}
    >
      {action}
    </span>
  );
}

/** Pretty-printed details of a row (already redacted server-side). */
export function AuditDetails({ row }: { row: AuditLogRow }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-text-secondary">
        {JSON.stringify(row.details ?? {}, null, 2)}
      </pre>
      {row.userAgent && (
        <div className="text-[11px] text-text-muted">
          {t('audit.userAgent', { defaultValue: 'User agent' })}: <span className="font-mono">{row.userAgent}</span>
        </div>
      )}
    </div>
  );
}

/** "type #id" of the row's target, or a dash. */
export function auditTargetLabel(row: Pick<AuditLogRow, 'targetType' | 'targetId'>): string {
  if (!row.targetType) return '—';
  return row.targetId ? `${row.targetType} #${row.targetId}` : row.targetType;
}

/** A datetime-local value (local time) for an ISO date, and back. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v: string): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function AuditLogPage() {
  const { t } = useTranslation();
  const askConfirm = useConfirm();
  const isMaster = useIsMasterTenant();
  const isPlatformAdmin = useIsPlatformAdmin();
  const tenantFilter = useTenantFilter();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Filters (URL) ──────────────────────────────────────────────────────────
  const search = searchParams.get(P.search) ?? '';
  const action = searchParams.get(P.action) ?? '';
  const actor = searchParams.get(P.actor) ?? '';
  const status = searchParams.get(P.status) ?? '';
  const from = searchParams.get(P.from) ?? '';
  const to = searchParams.get(P.to) ?? '';
  const deviceRaw = searchParams.get(P.device) ?? '';
  const device = /^[1-9][0-9]{0,9}$/.test(deviceRaw) ? deviceRaw : '';
  const pageRaw = Number.parseInt(searchParams.get(P.page) ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const sizeRaw = Number.parseInt(searchParams.get(P.size) ?? '', 10);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(sizeRaw) ? sizeRaw : PAGE_SIZE;
  const tenantKey = [...tenantFilter.ids].sort((a, b) => a - b).join(',');

  const [searchDraft, setSearchDraft] = useState(search);
  const [actorDraft, setActorDraft] = useState(actor);
  useEffect(() => { setSearchDraft(search); }, [search]);
  useEffect(() => { setActorDraft(actor); }, [actor]);

  /** Sets URL parameters; any filter change goes back to page 1. */
  const setParams = useCallback((patch: Record<string, string>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      if (!('page' in patch)) next.delete(P.page);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // A tenant chip change goes back to page 1 too (the chips write the URL themselves).
  const prevTenantKey = useRef(tenantKey);
  useEffect(() => {
    if (prevTenantKey.current === tenantKey) return;
    prevTenantKey.current = tenantKey;
    setSearchParams((prev) => {
      if (!prev.has(P.page)) return prev;
      const next = new URLSearchParams(prev);
      next.delete(P.page);
      return next;
    }, { replace: true });
  }, [tenantKey, setSearchParams]);

  const hasFilters = !!(search || action || actor || status || from || to || device || tenantKey);
  const clearFilters = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const k of Object.values(P)) if (k !== P.size) next.delete(k);
      next.delete('tenants');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const filters = useMemo(() => ({
    search: search || undefined,
    action: action || undefined,
    actor: actor || undefined,
    success: status === 'success' ? true : status === 'failure' ? false : undefined,
    from: from || undefined,
    to: to || undefined,
    deviceId: device ? Number(device) : undefined,
    tenantIds: tenantKey ? tenantKey.split(',').map(Number) : undefined,
  }), [search, action, actor, status, from, to, device, tenantKey]);

  // ── Data ───────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actions, setActions] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await auditApi.list({ ...filters, page, pageSize });
      setRows(res.items);
      setTotal(res.total);
      setLoadError(false);
    } catch {
      setLoadError(true);
      toast.error(t('audit.loadFailed', { defaultValue: 'Failed to load the audit log' }));
    } finally {
      setLoading(false);
    }
  }, [filters, page, pageSize, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setExpanded(new Set()); }, [filters, page, pageSize]);
  useEffect(() => {
    auditApi.distinctActions(tenantKey ? tenantKey.split(',').map(Number) : undefined)
      .then(setActions).catch(() => setActions([]));
  }, [tenantKey]);

  /** Distinct actions grouped by their root ("bans.lifted" → "bans"). */
  const groupedActions = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const a of actions) {
      const root = a.split('.')[0];
      groups.set(root, [...(groups.get(root) ?? []), a]);
    }
    return [...groups.entries()];
  }, [actions]);

  const toggle = (id: number) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  // ── CSV export (current filters, up to EXPORT_MAX rows) ─────────────────────
  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await auditApi.list({ ...filters, page: 1, pageSize: EXPORT_MAX });
      const headers = ['When', 'Tenant', 'Action', 'Result', 'Actor', 'Agent', 'Target', 'IP', 'User agent', 'Details'];
      const data = res.items.map((r) => [
        r.createdAt,
        r.tenantName ?? (r.tenantId != null ? `#${r.tenantId}` : ''),
        r.action,
        r.success ? 'success' : 'failure',
        r.username ?? '',
        r.deviceName ?? (r.deviceId ? `#${r.deviceId}` : ''),
        r.targetType ? auditTargetLabel(r) : '',
        r.ipAddress ?? '',
        r.userAgent ?? '',
        r.details ? JSON.stringify(r.details) : '',
      ]);
      const ok = await saveCsv(headers, data, `audit-log-${new Date().toISOString().slice(0, 10)}.csv`);
      if (!ok) toast.error(t('audit.exportFailed', { defaultValue: 'Export failed' }));
      else if (res.total > res.items.length) {
        toast(t('audit.exportTruncated', { count: res.items.length, total: res.total, defaultValue: 'Exported the {{count}} most recent of {{total}} entries' }));
      }
    } catch {
      toast.error(t('audit.exportFailed', { defaultValue: 'Export failed' }));
    } finally {
      setExporting(false);
    }
  };

  // ── Purge (platform admin, Default tenant) ─────────────────────────────────
  const canPurge = isPlatformAdmin && isMaster;
  const purge = async () => {
    const ok = await askConfirm({
      title: t('audit.purgeTitle', { defaultValue: 'Purge the audit log' }),
      message: t('audit.purgeMessage', {
        defaultValue: 'Delete every audit entry older than 90 days for the selected tenants (all tenants when none is selected)? An "audit.purged" entry records who did it.',
      }),
      danger: true,
      confirmLabel: t('audit.purge', { defaultValue: 'Purge' }),
    });
    if (!ok) return;
    try {
      const res = await auditApi.purge(90, filters.tenantIds);
      toast.success(t('audit.purged', { count: res.deleted, defaultValue: '{{count}} entries deleted' }));
      void load();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg ?? t('audit.purgeFailed', { defaultValue: 'Purge failed' }));
    }
  };

  const colCount = isMaster ? 8 : 7;

  return (
    <PageContainer className="space-y-4">
      <PageHeader
        icon={<ScrollText size={20} />}
        title={t('audit.title', { defaultValue: 'Audit log' })}
        description={t('audit.description', { defaultValue: 'Who did what, when, from where, and on which agent.' })}
        actions={(
          <>
            <Button variant="secondary" size="sm" onClick={() => void exportCsv()} disabled={exporting || rows.length === 0}>
              <Download size={14} className="mr-1.5" />
              CSV
            </Button>
            {canPurge && (
              <Button variant="secondary" size="sm" onClick={() => void purge()}>
                <Trash2 size={14} className="mr-1.5" />
                {t('audit.purge', { defaultValue: 'Purge' })}
              </Button>
            )}
            <IconButton
              label={t('common.refresh', { defaultValue: 'Refresh' })}
              icon={<RefreshCw size={15} className={cn(loading && 'animate-spin')} />}
              variant="solid"
              onClick={() => void load()}
              disabled={loading}
            />
          </>
        )}
      />

      {isMaster && <TenantFilterChips value={tenantFilter.value} onChange={tenantFilter.setValue} />}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') setParams({ [P.search]: searchDraft.trim() }); }}
          onBlur={() => { if (searchDraft.trim() !== search) setParams({ [P.search]: searchDraft.trim() }); }}
          placeholder={t('audit.searchPlaceholder', { defaultValue: 'Target, IP, details…' })}
          aria-label={t('audit.search', { defaultValue: 'Search' })}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={cn(selectClass, 'w-52')}
        />
        <input
          type="search"
          value={actorDraft}
          onChange={(e) => setActorDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') setParams({ [P.actor]: actorDraft.trim() }); }}
          onBlur={() => { if (actorDraft.trim() !== actor) setParams({ [P.actor]: actorDraft.trim() }); }}
          placeholder={t('audit.actorPlaceholder', { defaultValue: 'Actor' })}
          aria-label={t('audit.actor', { defaultValue: 'Actor' })}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={cn(selectClass, 'w-36')}
        />
        <select
          value={action}
          onChange={(e) => setParams({ [P.action]: e.target.value })}
          aria-label={t('audit.action', { defaultValue: 'Action' })}
          className={cn(selectClass, 'max-w-[16rem]')}
        >
          <option value="">{t('audit.allActions', { defaultValue: 'All actions' })}</option>
          {groupedActions.map(([root, list]) => (
            <optgroup key={root} label={root}>
              <option value={`${root}.`}>{t('audit.allOf', { root, defaultValue: 'All {{root}}.*' })}</option>
              {list.map((a) => <option key={a} value={a}>{a}</option>)}
            </optgroup>
          ))}
          {action && !actions.includes(action) && !action.endsWith('.') && <option value={action}>{action}</option>}
        </select>
        <select
          value={status}
          onChange={(e) => setParams({ [P.status]: e.target.value })}
          aria-label={t('audit.result', { defaultValue: 'Result' })}
          className={selectClass}
        >
          <option value="">{t('audit.allResults', { defaultValue: 'All results' })}</option>
          <option value="success">{t('audit.success', { defaultValue: 'Succeeded' })}</option>
          <option value="failure">{t('audit.failure', { defaultValue: 'Failed' })}</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-text-muted">
          {t('audit.from', { defaultValue: 'From' })}
          <input
            type="datetime-local"
            value={from ? toLocalInput(from) : ''}
            onChange={(e) => setParams({ [P.from]: fromLocalInput(e.target.value) })}
            className={selectClass}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-text-muted">
          {t('audit.to', { defaultValue: 'To' })}
          <input
            type="datetime-local"
            value={to ? toLocalInput(to) : ''}
            onChange={(e) => setParams({ [P.to]: fromLocalInput(e.target.value) })}
            className={selectClass}
          />
        </label>
        {device && (
          <button
            type="button"
            onClick={() => setParams({ [P.device]: '' })}
            className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-xs text-accent hover:bg-accent/20"
          >
            {t('audit.agentFilter', { id: device, defaultValue: 'Agent #{{id}}' })}
            <X size={12} />
          </button>
        )}
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X size={14} className="mr-1" />
            {t('audit.clearFilters', { defaultValue: 'Clear filters' })}
          </Button>
        )}
      </div>

      <TableScroll className="border border-border bg-bg-secondary">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase text-text-muted">
              <th className="whitespace-nowrap px-3 py-2 text-left font-medium">{t('audit.colWhen', { defaultValue: 'When' })}</th>
              {isMaster && <th className="px-3 py-2 text-left font-medium">{t('audit.colTenant', { defaultValue: 'Tenant' })}</th>}
              <th className="px-3 py-2 text-left font-medium">{t('audit.colAction', { defaultValue: 'Action' })}</th>
              <th className="px-3 py-2 text-left font-medium">{t('audit.colActor', { defaultValue: 'Actor' })}</th>
              <th className="px-3 py-2 text-left font-medium">{t('audit.colAgent', { defaultValue: 'Agent' })}</th>
              <th className="px-3 py-2 text-left font-medium">{t('audit.colTarget', { defaultValue: 'Target' })}</th>
              <th className="px-3 py-2 text-left font-medium">{t('audit.colIp', { defaultValue: 'IP' })}</th>
              <th className="w-6 px-2 py-2"><span className="sr-only">{t('audit.details', { defaultValue: 'Details' })}</span></th>
            </tr>
          </thead>
          <tbody className={cn('divide-y divide-border', loading && rows.length > 0 && 'opacity-60')}>
            {loading && rows.length === 0 ? (
              <TableSkeleton rows={10} cols={colCount} rowClassName="h-10" />
            ) : loadError && rows.length === 0 ? (
              <EmptyState
                colSpan={colCount}
                title={t('audit.loadFailed', { defaultValue: 'Failed to load the audit log' })}
                action={<Button variant="secondary" size="sm" onClick={() => void load()}>{t('common.retry', { defaultValue: 'Retry' })}</Button>}
              />
            ) : rows.length === 0 ? (
              hasFilters
                ? <EmptyState variant="filtered" colSpan={colCount} onClearFilters={clearFilters} />
                : <EmptyState colSpan={colCount} title={t('audit.empty', { defaultValue: 'No audit entries yet' })} />
            ) : rows.map((row) => {
              const open = expanded.has(row.id);
              return (
                <Fragment key={row.id}>
                  <tr
                    className="cursor-pointer transition-colors hover:bg-bg-hover"
                    onClick={() => toggle(row.id)}
                    aria-expanded={open}
                  >
                    <td className="whitespace-nowrap px-3 py-2 text-text-muted" title={row.createdAt}>
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    {isMaster && (
                      <td className="px-3 py-2">
                        {row.tenantId != null
                          ? <TenantBadge tenantId={row.tenantId} tenantName={row.tenantName} />
                          : <span className="text-text-muted">{t('audit.instance', { defaultValue: 'Instance' })}</span>}
                      </td>
                    )}
                    <td className="px-3 py-2"><AuditActionPill action={row.action} success={row.success} /></td>
                    <td className="max-w-[10rem] truncate px-3 py-2 text-text-primary">
                      {row.username
                        ? anonUsername(row.username)
                        : <span className="italic text-text-muted">{t('audit.system', { defaultValue: 'system' })}</span>}
                    </td>
                    <td className="max-w-[10rem] truncate px-3 py-2">
                      {row.deviceId ? (
                        <Link
                          to={`/agents/${row.deviceId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-accent hover:underline"
                        >
                          {row.deviceName ? anonHostname(row.deviceName) : `#${row.deviceId}`}
                        </Link>
                      ) : <span className="text-text-muted">—</span>}
                    </td>
                    <td className="max-w-[14rem] truncate px-3 py-2 font-mono text-text-secondary" title={auditTargetLabel(row)}>
                      {auditTargetLabel(row)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-text-muted">
                      {row.ipAddress ? anonIp(row.ipAddress) : '—'}
                    </td>
                    <td className="px-2 py-2 text-text-muted">
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-bg-primary/40">
                      <td colSpan={colCount} className="px-6 py-3">
                        <AuditDetails row={row} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </TableScroll>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onChange={(p) => setParams({ [P.page]: p > 1 ? String(p) : '' })}
        pageSizeOptions={PAGE_SIZES}
        onPageSizeChange={(s) => setParams({ [P.size]: s === PAGE_SIZE ? '' : String(s) })}
        disabled={loading}
      />
    </PageContainer>
  );
}
