import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Shield, EyeOff, RotateCcw, Plus, ChevronDown, ChevronUp } from 'lucide-react';
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
   * 'group'  — shows group-level overrides; "Disable for group" / "Re-enable" buttons.
   * 'device' — shows per-agent overrides; can override/reset independently of group.
   */
  scope: 'group' | 'device';
  scopeId: number;

  /**
   * For 'group' scope: the group ID.
   * For 'device' scope: the device ID.
   */
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

  // ── Actions ──────────────────────────────────────────────────────────────

  async function disable(cfg: ResolvedServiceConfig) {
    setBusy(b => ({ ...b, [cfg.templateId]: true }));
    try {
      await serviceTemplatesApi.upsertAssignment(
        cfg.templateId,
        scope === 'device' ? 'agent' : 'group',
        scopeId,
        { enabledOverride: false },
      );
      await load();
    } finally {
      setBusy(b => ({ ...b, [cfg.templateId]: false }));
    }
  }

  /**
   * Re-enable: set enabledOverride = null (inherit from parent / template default).
   * If the row has no other overrides, delete the assignment entirely to keep DB clean.
   */
  async function reenable(cfg: ResolvedServiceConfig) {
    setBusy(b => ({ ...b, [cfg.templateId]: true }));
    try {
      await serviceTemplatesApi.upsertAssignment(
        cfg.templateId,
        scope === 'device' ? 'agent' : 'group',
        scopeId,
        { enabledOverride: null },
      );
      await load();
    } finally {
      setBusy(b => ({ ...b, [cfg.templateId]: false }));
    }
  }

  /**
   * Device-only: reset agent-level override entirely (delete agent assignment).
   * Falls back to group / template default.
   */
  async function reset(cfg: ResolvedServiceConfig) {
    setBusy(b => ({ ...b, [cfg.templateId]: true }));
    try {
      await serviceTemplatesApi.deleteAssignment(cfg.templateId, 'agent', scopeId);
      await load();
    } finally {
      setBusy(b => ({ ...b, [cfg.templateId]: false }));
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const enabledCount   = configs.filter(c => c.enabled).length;
  const disabledCount  = configs.filter(c => !c.enabled).length;

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
              {enabledCount} active{disabledCount > 0 ? `, ${disabledCount} disabled` : ''}
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
              No global service templates configured.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {configs.map(cfg => {
                const isBusy           = busy[cfg.templateId] ?? false;
                const overrideScope    = cfg.enabledOverrideScope;
                // For device scope: is there an agent-level enabled override?
                const hasAgentOverride = scope === 'device' && overrideScope === 'agent';
                // Is disabled by group (and not re-enabled at agent level)?
                const disabledByGroup  = scope === 'device' && !cfg.enabled && overrideScope === 'group';

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

                        {/* State badges */}
                        {!cfg.enabled && overrideScope === null && (
                          <span className="text-[10px] text-text-muted">Template default: off</span>
                        )}
                        {hasAgentOverride && (
                          <span className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                            cfg.enabled
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-amber-500/10 text-amber-400',
                          )}>
                            {cfg.enabled ? 'Re-enabled (Agent)' : 'Disabled (Agent)'}
                          </span>
                        )}
                        {scope === 'group' && overrideScope === 'group' && !cfg.enabled && (
                          <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                            Disabled (Group)
                          </span>
                        )}
                        {disabledByGroup && (
                          <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                            Disabled (Group)
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
                      {scope === 'group' && (
                        <>
                          {cfg.enabled ? (
                            // Active → offer "Disable for group"
                            <button
                              onClick={() => void disable(cfg)}
                              disabled={isBusy}
                              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 transition-colors"
                            >
                              Disable
                            </button>
                          ) : overrideScope === 'group' ? (
                            // Group-disabled → offer "Re-enable"
                            <button
                              onClick={() => void reenable(cfg)}
                              disabled={isBusy}
                              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-amber-500 hover:bg-amber-500/10 disabled:opacity-50 transition-colors flex items-center gap-1"
                            >
                              <RotateCcw size={11} />
                              Re-enable
                            </button>
                          ) : null}
                        </>
                      )}

                      {scope === 'device' && (
                        <>
                          {hasAgentOverride ? (
                            // Agent has an override → offer Reset (remove agent override, inherit group/template)
                            <button
                              onClick={() => void reset(cfg)}
                              disabled={isBusy}
                              title="Remove agent override — inherit from group / template"
                              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-amber-500 hover:bg-amber-500/10 disabled:opacity-50 transition-colors flex items-center gap-1"
                            >
                              <RotateCcw size={11} />
                              Reset
                            </button>
                          ) : cfg.enabled ? (
                            // Active (no agent override) → offer "Disable for this agent"
                            <button
                              onClick={() => void disable(cfg)}
                              disabled={isBusy}
                              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 transition-colors"
                            >
                              Disable
                            </button>
                          ) : disabledByGroup ? (
                            // Disabled by group → offer "Enable for this agent" (override the group)
                            <button
                              onClick={() => void reenable(cfg)}
                              disabled={isBusy}
                              title="Override group: re-enable for this agent only"
                              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 transition-colors"
                            >
                              Enable (override)
                            </button>
                          ) : null}
                        </>
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
