import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RefreshCw, Search, Terminal, X } from 'lucide-react';
import type { ServiceTemplate } from '@obliview/shared';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { useTenantFilter } from '@/hooks/useTenantFilter';
import { useTenantStore } from '@/store/tenantStore';
import { cn } from '@/utils/cn';
import { EnabledChip, ModeChip, OriginBadge, serviceIcon } from './TemplateBadges';

export type TemplateListFilter = 'all' | 'builtin' | 'custom' | 'disabled';

interface TemplateListProps {
  templates: ServiceTemplate[];
  loading: boolean;
  /** Selected template id, 'new' while creating, null when nothing is selected. */
  selectedId: number | 'new' | null;
  onSelect: (id: number) => void;
  onRefresh: () => void;
  /** Shown only when set (templates.write). */
  onCreate?: () => void;
  /** Overflow actions of a row (hidden items are filtered out by ActionMenu). */
  rowActions: (template: ServiceTemplate) => ActionMenuItem[];
}

/**
 * Searchable template list (master pane): origin badge, mode chip and the
 * default enabled state on every row, Built-in / Custom / Disabled filter,
 * tenant chips in the god view.
 */
export function TemplateList({ templates, loading, selectedId, onSelect, onRefresh, onCreate, rowActions }: TemplateListProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TemplateListFilter>('all');
  const tenantFilter = useTenantFilter();
  const tenants = useTenantStore((s) => s.tenants);

  const counts = useMemo(() => ({
    all: templates.length,
    builtin: templates.filter((tpl) => tpl.isBuiltin).length,
    custom: templates.filter((tpl) => !tpl.isBuiltin).length,
    disabled: templates.filter((tpl) => !tpl.enabled).length,
  }), [templates]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter((tpl) => {
      if (filter === 'builtin' && !tpl.isBuiltin) return false;
      if (filter === 'custom' && tpl.isBuiltin) return false;
      if (filter === 'disabled' && tpl.enabled) return false;
      // Tenant chips narrow tenant templates; shared templates stay listed.
      if (!tenantFilter.isEmpty && tpl.tenantId != null && !tenantFilter.value.has(tpl.tenantId)) return false;
      if (!q) return true;
      const tenantName = tpl.tenantId != null ? tenants.find((tn) => tn.id === tpl.tenantId)?.name ?? '' : '';
      return [tpl.name, tpl.serviceType, tpl.customRegex ?? '', tenantName]
        .some((field) => field.toLowerCase().includes(q));
    });
  }, [templates, filter, search, tenantFilter.isEmpty, tenantFilter.value, tenants]);

  const hasFilters = search.trim() !== '' || filter !== 'all' || !tenantFilter.isEmpty;
  const clearFilters = () => {
    setSearch('');
    setFilter('all');
    tenantFilter.setValue(new Set());
  };

  const filterTabs = [
    { id: 'all' as const, label: t('serviceTemplates.filter.all', { defaultValue: 'All' }), badge: <Count n={counts.all} /> },
    { id: 'builtin' as const, label: t('serviceTemplates.filter.builtin', { defaultValue: 'Built-in' }), badge: <Count n={counts.builtin} /> },
    { id: 'custom' as const, label: t('serviceTemplates.filter.custom', { defaultValue: 'Custom' }), badge: <Count n={counts.custom} /> },
    { id: 'disabled' as const, label: t('serviceTemplates.filter.disabled', { defaultValue: 'Off' }), badge: <Count n={counts.disabled} /> },
  ];

  return (
    <div className="flex flex-col rounded-xl bg-bg-secondary">
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('serviceTemplates.list.title', { defaultValue: 'Templates' })}
          </h2>
          <div className="flex items-center gap-1">
            <IconButton
              label={t('common.refresh', { defaultValue: 'Refresh' })}
              icon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />}
              onClick={onRefresh}
            />
            {onCreate && (
              <IconButton
                label={t('serviceTemplates.actions.new', { defaultValue: 'New template' })}
                icon={<Plus className="h-4 w-4" />}
                variant="primary"
                active={selectedId === 'new'}
                onClick={onCreate}
              />
            )}
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('serviceTemplates.list.searchPlaceholder', { defaultValue: 'Search name, service, regex…' })}
            aria-label={t('common.search', { defaultValue: 'Search' })}
            className="w-full rounded-lg bg-bg-tertiary py-1.5 pl-8 pr-8 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/60"
          />
          {search && (
            <IconButton
              label={t('serviceTemplates.list.clearSearch', { defaultValue: 'Clear search' })}
              icon={<X className="h-3.5 w-3.5" />}
              size="xs"
              variant="plain"
              touchTarget="overlay"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2"
            />
          )}
        </div>
        <SegmentedTabs
          tabs={filterTabs}
          value={filter}
          onChange={setFilter}
          size="sm"
          ariaLabel={t('serviceTemplates.filter.label', { defaultValue: 'Filter templates' })}
          tabClassName="px-2"
        />
        <TenantFilterChips
          value={tenantFilter.value}
          onChange={tenantFilter.setValue}
          availableTenantIds={[...new Set(templates.map((tpl) => tpl.tenantId).filter((id): id is number => id != null))]}
        />
      </div>

      <div className="px-1.5 pb-1.5" role="list" aria-label={t('serviceTemplates.list.title', { defaultValue: 'Templates' })}>
        {loading && templates.length === 0 ? (
          <div className="flex h-24 items-center justify-center">
            <RefreshCw className="h-4 w-4 animate-spin text-text-muted" aria-hidden="true" />
          </div>
        ) : filtered.length === 0 ? (
          hasFilters ? (
            <EmptyState variant="filtered" compact onClearFilters={clearFilters} />
          ) : (
            <EmptyState
              compact
              icon={<Terminal size={24} strokeWidth={1.5} />}
              title={t('serviceTemplates.list.empty', { defaultValue: 'No templates yet' })}
            />
          )
        ) : (
          filtered.map((tpl) => {
            const selected = selectedId === tpl.id;
            const actions = rowActions(tpl);
            return (
              <div
                key={tpl.id}
                role="listitem"
                className={cn(
                  'group mb-0.5 flex items-start gap-1 rounded-lg border transition-colors',
                  selected ? 'border-accent/30 bg-accent/10' : 'border-transparent hover:bg-bg-tertiary',
                  !tpl.enabled && !selected && 'opacity-70',
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(tpl.id)}
                  aria-current={selected ? 'true' : undefined}
                  className="min-w-0 flex-1 rounded-lg p-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span aria-hidden="true">{serviceIcon(tpl.serviceType)}</span>
                    <span className="min-w-0 truncate text-sm font-medium text-text-primary">{tpl.name}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <OriginBadge template={tpl} />
                    <ModeChip mode={tpl.mode ?? 'ban'} />
                    <EnabledChip enabled={tpl.enabled} />
                  </div>
                  <div className="mt-1 truncate text-xs text-text-muted">
                    {tpl.serviceType}
                    {' · '}
                    {t('serviceTemplates.list.thresholdShort', {
                      defaultValue: '{{threshold}} fail / {{window}}s',
                      threshold: tpl.threshold,
                      window: tpl.windowSeconds,
                    })}
                  </div>
                </button>
                {actions.some((a) => !a.hidden) && (
                  <div className="shrink-0 pr-1 pt-1.5 can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:group-focus-within:opacity-100">
                    <ActionMenu
                      items={actions}
                      triggerSize="sm"
                      label={t('serviceTemplates.list.rowActions', { defaultValue: 'Actions for {{name}}', name: tpl.name })}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="text-[10px] opacity-70">{n}</span>;
}
