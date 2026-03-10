import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Shield, EyeOff, RotateCcw, Plus, ChevronDown, ChevronUp, Layers, Sliders, Check, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { serviceTemplatesApi } from '@/api/serviceTemplates.api';
import type { ResolvedServiceConfig } from '@obliview/shared';
import toast from 'react-hot-toast';

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
// ThresholdEditor — inline editor shown when a row is expanded
// ─────────────────────────────────────────────────────────────────────────────

function ThresholdEditor({
  cfg,
  apiScope,
  scopeId,
  onSaved,
}: {
  cfg: ResolvedServiceConfig;
  apiScope: 'group' | 'agent';
  scopeId: number;
  onSaved: () => void;
}) {
  const [threshold,    setThreshold]    = useState(String(cfg.thresholdOverride ?? cfg.threshold));
  const [windowSecs,   setWindowSecs]   = useState(String(cfg.windowSecondsOverride ?? cfg.windowSeconds));
  const [saving,       setSaving]       = useState(false);

  // Reset local state when cfg changes (e.g. after load())
  useEffect(() => {
    setThreshold(String(cfg.thresholdOverride ?? cfg.threshold));
    setWindowSecs(String(cfg.windowSecondsOverride ?? cfg.windowSeconds));
  }, [cfg.thresholdOverride, cfg.windowSecondsOverride, cfg.threshold, cfg.windowSeconds]);

  async function save() {
    setSaving(true);
    try {
      const t = Math.max(1, Number(threshold) || cfg.threshold);
      const w = Math.max(10, Number(windowSecs) || cfg.windowSeconds);
      await serviceTemplatesApi.upsertAssignment(
        cfg.templateId, apiScope, scopeId,
        { thresholdOverride: t, windowSecondsOverride: w },
      );
      onSaved();
      toast.success('Threshold saved');
    } catch {
      toast.error('Failed to save threshold');
    } finally {
      setSaving(false);
    }
  }

  async function resetThreshold() {
    setSaving(true);
    try {
      await serviceTemplatesApi.upsertAssignment(
        cfg.templateId, apiScope, scopeId,
        { thresholdOverride: null, windowSecondsOverride: null },
      );
      onSaved();
      toast.success('Threshold reset to template default');
    } catch {
      toast.error('Failed to reset threshold');
    } finally {
      setSaving(false);
    }
  }

  const hasOverride = cfg.thresholdOverrideScope !== null;

  return (
    <div className="px-4 pb-3 pt-1 flex flex-wrap items-center gap-3 border-t border-border/50 bg-bg-tertiary/30">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted flex-shrink-0">
        Threshold override
      </span>

      {/* Failures input */}
      <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
        Failures
        <input
          type="number"
          min={1}
          value={threshold}
          onChange={e => setThreshold(e.target.value)}
          className="w-14 rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-accent"
        />
      </label>

      {/* Window input */}
      <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
        Window
        <input
          type="number"
          min={10}
          value={windowSecs}
          onChange={e => setWindowSecs(e.target.value)}
          className="w-18 rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-accent"
        />
        <span className="text-text-muted">s</span>
      </label>

      {/* Template default hint */}
      <span className="text-[10px] text-text-muted">
        (template default: {cfg.threshold}f / {cfg.windowSeconds}s)
      </span>

      {/* Override scope badge */}
      {hasOverride && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
          {cfg.thresholdOverrideScope} override
        </span>
      )}

      <div className="flex items-center gap-1 ml-auto">
        {/* Reset to template default */}
        {hasOverride && (
          <button
            onClick={() => void resetThreshold()}
            disabled={saving}
            title="Reset to template default"
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-amber-500 hover:bg-amber-500/10 disabled:opacity-50 transition-colors"
          >
            <RotateCcw size={10} />
            Reset
          </button>
        )}
        {/* Save */}
        <button
          onClick={() => void save()}
          disabled={saving}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-50 transition-colors"
        >
          <Check size={10} />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
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
  /** templateId that has its threshold editor open */
  const [editingThreshold, setEditingThreshold] = useState<number | null>(null);

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
              {boundCount} active{unboundCount > 0 ? `, ${unboundCount} inactive` : ''}
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
                const isEditingThis  = editingThreshold === cfg.templateId;

                // Whether THIS scope has set an explicit enabled_override
                const hasScopeOverride =
                  scope === 'device' ? overrideScope === 'agent' : overrideScope === 'group';

                return (
                  <div key={cfg.templateId} className={cn(!cfg.enabled && 'opacity-60')}>
                    {/* Main row */}
                    <div className="flex items-center gap-3 px-4 py-3">
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
                            <span className="text-[10px] text-text-muted">Inactive by default</span>
                          )}

                          {/* Device scope: agent-level explicit override */}
                          {scope === 'device' && overrideScope === 'agent' && (
                            <span className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                              cfg.enabled
                                ? 'bg-green-500/10 text-green-400'
                                : 'bg-amber-500/10 text-amber-400',
                            )}>
                              {cfg.enabled ? 'Active (agent)' : 'Disabled (agent)'}
                            </span>
                          )}

                          {/* Device scope: disabled by a group-level override (no agent override on top) */}
                          {scope === 'device' && overrideScope === 'group' && !cfg.enabled && (
                            <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                              Disabled (group)
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
                              {cfg.enabled ? 'Active (group)' : 'Disabled (group)'}
                            </span>
                          )}
                        </div>

                        {/* Details line */}
                        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-text-muted">
                          <span>
                            {cfg.threshold}f / {cfg.windowSeconds}s
                            {cfg.thresholdOverrideScope && (
                              <span className="text-amber-400 ml-1">
                                ({cfg.thresholdOverrideScope} override)
                              </span>
                            )}
                          </span>
                          {cfg.logPath && (
                            <span className="font-mono truncate max-w-[220px]" title={cfg.logPath}>
                              {cfg.logPath}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-1 flex-shrink-0">

                        {/* Threshold editor toggle — only when active at this scope */}
                        {cfg.enabled && (
                          <button
                            onClick={() => setEditingThreshold(isEditingThis ? null : cfg.templateId)}
                            title="Edit threshold override"
                            className={cn(
                              'shrink-0 rounded-md p-1.5 text-xs transition-colors',
                              isEditingThis
                                ? 'bg-accent/10 text-accent'
                                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
                            )}
                          >
                            {isEditingThis ? <X size={12} /> : <Sliders size={12} />}
                          </button>
                        )}

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
                            title={scope === 'group' ? 'Disable for all agents in this group' : undefined}
                            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 transition-colors"
                          >
                            Disable
                          </button>
                        ) : (
                          <button
                            onClick={() => void bind(cfg)}
                            disabled={isBusy}
                            title={
                              scope === 'device' && overrideScope === 'group'
                                ? 'Override group: activate for this agent only'
                                : scope === 'group'
                                ? 'Activate for all agents in this group'
                                : 'Activate for this agent'
                            }
                            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-50 transition-colors"
                          >
                            Activate
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Threshold editor (expanded row) */}
                    {isEditingThis && (
                      <ThresholdEditor
                        cfg={cfg}
                        apiScope={apiScope}
                        scopeId={scopeId}
                        onSaved={() => {
                          void load();
                          setEditingThreshold(null);
                        }}
                      />
                    )}
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
