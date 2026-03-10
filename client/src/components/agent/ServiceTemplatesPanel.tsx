import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Shield, EyeOff, RotateCcw, Plus, ChevronDown, ChevronUp, Layers } from 'lucide-react';
import { cn } from '@/utils/cn';
import { serviceTemplatesApi } from '@/api/serviceTemplates.api';
import type { ResolvedServiceConfig } from '@obliview/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ServiceTypeBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-mono text-text-muted border border-border">
      {type}
    </span>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold',
      mode === 'ban'
        ? 'bg-red-500/10 text-red-400'
        : 'bg-amber-500/10 text-amber-400',
    )}>
      {mode === 'ban' ? <Shield size={8} /> : <EyeOff size={8} />}
      {mode === 'ban' ? 'Ban' : 'Track'}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface ServiceTemplatesPanelProps {
  /**
   * 'group'  — shows group-level bind/unbind for GLOBAL templates only.
   *            Group-owned templates are managed in their own section.
   * 'device' — shows per-agent bind/unbind; includes both global and group-owned templates.
   *            An agent can bind/unbind independently of the group.
   */
  scope: 'group' | 'device';
  scopeId: number;
  className?: string;
  /** Allow creating local templates (device scope only). */
  onCreateLocal?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ServiceTemplatesPanel({
  scope,
  scopeId,
  className,
  onCreateLocal,
}: ServiceTemplatesPanelProps) {
  const [configs, setConfigs]   = useState<ResolvedServiceConfig[]>([]);
  const [loading, setLoading]   = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy]         = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = scope === 'group'
        ? await serviceTemplatesApi.getResolvedForGroup(scopeId)
        : await serviceTemplatesApi.getResolvedForDevice(scopeId);
      setConfigs(data);
    } finally {
      setLoading(false);
    }
  }, [scope, scopeId]);

  useEffect(() => { void load(); }, [load]);

  // ── API scope ─────────────────────────────────────────────────────────────
  // 'group' panel writes group-scope assignments; 'device' panel writes agent-scope.
  const apiScope = scope === 'device' ? 'agent' : 'group';

  // ── Actions ──────────────────────────────────────────────────────────────

  /**
   * Bind: explicitly enable this template at the current scope (enabledOverride = true).
   * For device scope this overrides a group unbind — setting true at agent level
   * takes precedence over any group-level false.
   */
  async function bind(cfg: ResolvedServiceConfig) {
    setBusy(b => ({ ...b, [cfg.templateId]: true }));
    try {
      await serviceTemplatesApi.upsertAssignment(
        cfg.templateId, apiScope, scopeId,
        { enabledOverride: true },
      );
      await load();
    } finally {
      setBusy(b => ({ ...b, [cfg.templateId]: false }));
    }
  }

  /**
   * Unbind: explicitly disable this template at the current scope (enabledOverride = false).
   * At group scope: all agents in this group will inherit disabled unless they Bind individually.
   * At device scope: only this agent is affected.
   */
  async function unbind(cfg: ResolvedServiceConfig) {
    setBusy(b => ({ ...b, [cfg.templateId]: true }));
    try {
      await serviceTemplatesApi.upsertAssignment(
        cfg.templateId, apiScope, scopeId,
        { enabledOverride: false },
      );
      await load();
    } finally {
      setBusy(b => ({ ...b, [cfg.templateId]: false }));
    }
  }

  /**
   * Reset: remove the explicit override at the current scope.
   * Falls back to the parent level (group assignment → template default).
   */
  async function reset(cfg: ResolvedServiceConfig) {
    setBusy(b => ({ ...b, [cfg.templateId]: true }));
    try {
      await serviceTemplatesApi.deleteAssignment(cfg.templateId, apiScope, scopeId);
      await load();
    } finally {
      setBusy(b => ({ ...b, [cfg.templateId]: false }));
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const boundCount   = configs.filter(c => c.enabled).length;
  const unboundCount = configs.filter(c => !c.enabled).length;

  return (
    <div className={cn('rounded-lg border border-border bg-bg-secondary', className)}>

      {/* Header */}
      <div
        className="px-4 py-3 border-b border-border flex items-center justify-between cursor-pointer select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center gap-2">
          {expanded
            ? <ChevronUp size={14} className="text-text-muted" />
            : <ChevronDown size={14} className="text-text-muted" />}
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
            Service Templates
          </h2>
          {!loading && (
            <span className="text-xs text-text-muted">
              {boundCount} bound{unboundCount > 0 ? `, ${unboundCount} unbound` : ''}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          {scope === 'device' && onCreateLocal && (
            <button
              onClick={onCreateLocal}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent hover:bg-accent/10 transition-colors"
              title="Create local template for this agent"
            >
              <Plus size={11} /> Local template
            </button>
          )}
          <button
            onClick={() => void load()}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div>
          {loading ? (
            <div className="py-8 text-center text-sm text-text-muted">Loading…</div>
          ) : configs.length === 0 ? (
            <div className="py-8 text-center text-sm text-text-muted">
              No service templates configured.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {configs.map(cfg => {
                const isBusy         = busy[cfg.templateId] ?? false;
                const overrideScope  = cfg.enabledOverrideScope;
                const isGroupTpl     = cfg.templateOwnerScope === 'group';

                // Whether THIS scope has set an explicit enabled_override
                const hasScopeOverride =
                  scope === 'device' ? overrideScope === 'agent' : overrideScope === 'group';

                return (
                  <div
                    key={cfg.templateId}
                    className={cn(
                      'flex items-center gap-3 px-4 py-3',
                      !cfg.enabled && 'opacity-60',
                    )}
                  >
                    {/* Status dot */}
                    <div className={cn(
                      'w-2 h-2 rounded-full flex-shrink-0',
                      cfg.enabled ? 'bg-status-up' : 'bg-bg-tertiary border border-border',
                    )} />

                    {/* Labels */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary">{cfg.name}</span>
                        <ServiceTypeBadge type={cfg.serviceType} />
                        <ModeBadge mode={cfg.mode} />

                        {/* Group-owned template badge */}
                        {isGroupTpl && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] font-medium text-purple-400">
                            <Layers size={8} />
                            Group template
                          </span>
                        )}

                        {/* ── State badges ── */}

                        {/* No override at all and template is off by default */}
                        {!cfg.enabled && overrideScope === null && (
                          <span className="text-[10px] text-text-muted">Template default: off</span>
                        )}

                        {/* Device scope: agent-level explicit override */}
                        {scope === 'device' && overrideScope === 'agent' && (
                          <span className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                            cfg.enabled
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-amber-500/10 text-amber-400',
                          )}>
                            {cfg.enabled ? 'Bound (agent)' : 'Unbound (agent)'}
                          </span>
                        )}

                        {/* Device scope: disabled by a group-level override (no agent override on top) */}
                        {scope === 'device' && overrideScope === 'group' && !cfg.enabled && (
                          <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                            Unbound (group)
                          </span>
                        )}

                        {/* Group scope: this group has an explicit override */}
                        {scope === 'group' && overrideScope === 'group' && (
                          <span className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                            cfg.enabled
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-amber-500/10 text-amber-400',
                          )}>
                            {cfg.enabled ? 'Bound (group)' : 'Unbound (group)'}
                          </span>
                        )}
                      </div>

                      {/* Details line */}
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-text-muted">
                        <span>Threshold: {cfg.threshold} / {cfg.windowSeconds}s</span>
                        {cfg.logPath && (
                          <span className="font-mono truncate max-w-[220px]" title={cfg.logPath}>
                            {cfg.logPath}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-1 flex-shrink-0">

                      {/* Reset: only shown when this scope has an explicit override */}
                      {hasScopeOverride && (
                        <button
                          onClick={() => void reset(cfg)}
                          disabled={isBusy}
                          title={
                            scope === 'device'
                              ? 'Remove agent override — inherit from group / template default'
                              : 'Remove group override — inherit from template default'
                          }
                          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-amber-500 hover:bg-amber-500/10 disabled:opacity-50 transition-colors flex items-center gap-1"
                        >
                          <RotateCcw size={11} />
                          Reset
                        </button>
                      )}

                      {/* Bind / Unbind — always shown based on current effective state */}
                      {cfg.enabled ? (
                        <button
                          onClick={() => void unbind(cfg)}
                          disabled={isBusy}
                          title={scope === 'group' ? 'Unbind for all agents in this group' : undefined}
                          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 transition-colors"
                        >
                          Unbind
                        </button>
                      ) : (
                        <button
                          onClick={() => void bind(cfg)}
                          disabled={isBusy}
                          title={
                            scope === 'device' && overrideScope === 'group'
                              ? 'Override group: bind for this agent only'
                              : undefined
                          }
                          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-50 transition-colors"
                        >
                          Bind
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
