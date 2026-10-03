import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity, Building2, FlaskConical, FolderOpen, ShieldOff, Wifi, WifiOff } from 'lucide-react';
import type { DashboardGroupStats } from '@obliview/shared';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { Tip } from '@/components/common/Tip';
import { cn } from '@/utils/cn';

/**
 * One group row of the "By group" panel (Obliance DashboardPage GroupCard):
 * name (to the group page), connected / total agents with a presence bar,
 * then the last 24 h of attack events and bans on the group's own agents.
 * Unlabelled icons explain themselves in a <Tip> (hover, or tap on touch).
 */
export function GroupCard({ group, depth = 0 }: { group: DashboardGroupStats; depth?: number }) {
  const { t } = useTranslation();
  const offline = group.agents - group.connected;
  const upPct = group.agents > 0 ? Math.round((group.connected / group.agents) * 100) : 0;
  const tone = group.agents === 0 ? 'text-text-muted' : upPct >= 95 ? 'text-status-up' : upPct >= 70 ? 'text-amber-400' : 'text-status-down';
  const bar = upPct >= 95 ? 'bg-status-up' : upPct >= 70 ? 'bg-amber-400' : 'bg-status-down';
  const name = group.groupName ?? t('dashboard.ungrouped', { defaultValue: 'No group' });

  return (
    <div
      className={cn(
        'rounded-lg px-4 py-3 shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_4px_18px_-8px_rgba(0,0,0,0.45)] max-sm:px-3',
        depth > 0 ? 'bg-bg-tertiary' : 'bg-bg-secondary',
      )}
    >
      <div className="flex min-w-0 items-center gap-3 max-sm:flex-wrap max-sm:gap-y-2">
        {group.groupId != null ? (
          <Link to={`/group/${group.groupId}`} className="flex min-w-0 items-center gap-2 hover:opacity-90 max-sm:flex-1">
            <FolderOpen size={depth > 0 ? 14 : 16} className="shrink-0 text-accent" aria-hidden="true" />
            <span className="min-w-0 truncate text-[14px] font-semibold text-text-primary">{name}</span>
          </Link>
        ) : (
          <span className="flex min-w-0 items-center gap-2 max-sm:flex-1">
            <FolderOpen size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
            <span className="min-w-0 truncate text-[14px] font-semibold text-text-secondary">{name}</span>
          </span>
        )}
        {group.evaluateOnly && (
          <Tip content={t('dashboard.groupEvaluateOnly', { defaultValue: 'Evaluate-only: attacks are observed, never banned' })}>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
              <FlaskConical size={11} aria-hidden="true" />
              {t('dashboard.evaluateOnlyShort', { defaultValue: 'evaluate-only' })}
            </span>
          </Tip>
        )}

        <Tip content={t('dashboard.groupAgentsTip', {
          defaultValue: '{{connected}} connected · {{offline}} offline · {{total}} agents',
          connected: group.connected, offline, total: group.agents,
        })}
        >
          <span className="ml-2 flex items-center gap-1.5 font-mono text-[12px]">
            <Wifi size={13} className={tone} aria-hidden="true" />
            <span className={tone}>{group.connected}</span>
            <span className="text-text-muted">/ {group.agents}</span>
          </span>
        </Tip>

        <div className="mx-2 h-1.5 min-w-0 max-w-[300px] flex-1 overflow-hidden rounded bg-bg-tertiary max-sm:hidden">
          <div className={cn('h-full', bar)} style={{ width: `${upPct}%` }} />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3 max-sm:ml-0 max-sm:w-full max-sm:flex-wrap">
          {offline > 0 && (
            <Tip content={t('dashboard.groupOfflineTip', { defaultValue: '{{count}} offline', count: offline })}>
              <span className="flex items-center gap-1 font-mono text-[12px] text-text-muted">
                <WifiOff size={13} aria-hidden="true" /> {offline}
              </span>
            </Tip>
          )}
          <Tip content={t('dashboard.groupEventsTip', {
            defaultValue: '{{events}} events · {{failures}} auth failures (24h)',
            events: group.events24h, failures: group.failures24h,
          })}
          >
            <span className={cn('flex items-center gap-1 font-mono text-[12px]', group.failures24h > 0 ? 'text-orange-400' : 'text-text-muted')}>
              <Activity size={13} aria-hidden="true" /> {group.failures24h}
            </span>
          </Tip>
          <Tip content={t('dashboard.groupBansTip', { defaultValue: '{{count}} bans on IPs seen by these agents (24h)', count: group.bans24h })}>
            <span className={cn('flex items-center gap-1 font-mono text-[12px]', group.bans24h > 0 ? 'text-status-down' : 'text-text-muted')}>
              <ShieldOff size={13} aria-hidden="true" /> {group.bans24h}
            </span>
          </Tip>
        </div>
      </div>
    </div>
  );
}

type GroupNode = DashboardGroupStats & { children: GroupNode[] };

function renderNode(node: GroupNode, depth: number): ReactNode {
  return (
    <div
      key={node.groupId ?? 'none'}
      className="pl-[var(--gi-sm)] sm:pl-[var(--gi)]"
      style={{
        ['--gi' as string]: `${Math.min(depth, 4) * 18}px`,
        ['--gi-sm' as string]: `${Math.min(depth, 4) * 8}px`,
      } as CSSProperties}
    >
      <GroupCard group={node} depth={depth} />
      {node.children.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-2.5">
          {node.children.map((c) => renderNode(c, depth + 1))}
        </div>
      )}
    </div>
  );
}

/**
 * The group rows as a tree (parentId, sibling sortOrder then name), indented
 * by depth. From the Default tenant (rows tagged with their tenant) the roots
 * are bucketed under a tenant header, Default first then by name. The
 * "no group" row comes last.
 */
export function GroupTree({ groups }: { groups: DashboardGroupStats[] }) {
  const { t } = useTranslation();
  const { roots, loose } = useMemo(() => {
    const nodes = new Map<number, GroupNode>();
    for (const g of groups) if (g.groupId != null) nodes.set(g.groupId, { ...g, children: [] });
    const list: GroupNode[] = [];
    for (const n of nodes.values()) {
      if (n.parentId != null && nodes.has(n.parentId)) nodes.get(n.parentId)!.children.push(n);
      else list.push(n);
    }
    const sortRec = (l: GroupNode[]) => {
      l.sort((a, b) => a.sortOrder - b.sortOrder || (a.groupName ?? '').localeCompare(b.groupName ?? ''));
      for (const n of l) sortRec(n.children);
    };
    sortRec(list);
    const none = groups.find((g) => g.groupId == null);
    return { roots: list, loose: none ? { ...none, children: [] } as GroupNode : null };
  }, [groups]);

  const buckets = useMemo(() => {
    if (!roots.some((g) => g.tenantId != null)) return null;
    const byTenant = new Map<number, { name: string; roots: GroupNode[] }>();
    for (const r of roots) {
      const id = r.tenantId ?? 0;
      if (!byTenant.has(id)) byTenant.set(id, { name: r.tenantName ?? `#${id}`, roots: [] });
      byTenant.get(id)!.roots.push(r);
    }
    return [...byTenant.entries()].sort(([a, x], [b, y]) => {
      if (a === MASTER_TENANT_ID) return -1;
      if (b === MASTER_TENANT_ID) return 1;
      return x.name.localeCompare(y.name);
    });
  }, [roots]);

  return (
    <div className="flex flex-col gap-2.5">
      {buckets
        ? buckets.map(([id, b]) => (
          <div key={`tenant-${id}`} className="space-y-2">
            <div className="flex items-center gap-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-accent">
              <Building2 size={11} aria-hidden="true" />
              <span>{b.name}</span>
              <span className="text-text-muted">·</span>
              <span className="text-text-muted">
                {t('dashboard.tenantAgents', {
                  defaultValue: '{{count}} agents',
                  count: b.roots.reduce((sum, g) => sum + subtreeAgents(g), 0),
                })}
              </span>
            </div>
            {b.roots.map((g) => renderNode(g, 0))}
          </div>
        ))
        : roots.map((g) => renderNode(g, 0))}
      {loose && renderNode(loose, 0)}
    </div>
  );
}

function subtreeAgents(n: GroupNode): number {
  return n.agents + n.children.reduce((sum, c) => sum + subtreeAgents(c), 0);
}
