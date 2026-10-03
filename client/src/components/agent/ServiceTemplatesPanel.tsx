import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Shield, EyeOff, RotateCcw, Plus, ChevronDown, ChevronUp, Layers, Sliders, Check, X, FolderOpen } from 'lucide-react';
import { cn } from '@/utils/cn';
import { serviceTemplatesApi } from '@/api/serviceTemplates.api';
import type { ResolvedServiceConfig } from '@obliview/shared';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@/components/common/IconButton';

/** The server's `error` message of a failed request, if any. */
function apiErrorMessage(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

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
  const { t } = useTranslation();
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold',
      mode === 'ban'
        ? 'bg-red-500/10 text-red-400'
        : 'bg-amber-500/10 text-amber-400',
    )}>
      {mode === 'ban' ? <Shield size={8} /> : <EyeOff size={8} />}
      {mode === 'ban'
        ? t('agentDetail.templatesPanel.modeBan', { defaultValue: 'Ban' })
        : t('agentDetail.templatesPanel.modeTrack', { defaultValue: 'Track' })}
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
  /** Another tenant's agent (Default god view): list only — no create, edit, reset, bind or unbind. */
  readOnly?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// OverridesEditor — inline editor for threshold, window, and log path overrides
// ─────────────────────────────────────────────────────────────────────────────

function OverridesEditor({
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
  const { t } = useTranslation();
  const [threshold,  setThreshold]  = useState(String(cfg.thresholdOverride ?? cfg.threshold));
  const [windowSecs, setWindowSecs] = useState(String(cfg.windowSecondsOverride ?? cfg.windowSeconds));
  const [logPath,    setLogPath]    = useState(cfg.logPath ?? '');
  const [saving,     setSaving]     = useState(false);

  // Reset local state when cfg changes (e.g. after load())
  useEffect(() => {
    setThreshold(String(cfg.thresholdOverride ?? cfg.threshold));
    setWindowSecs(String(cfg.windowSecondsOverride ?? cfg.windowSeconds));
    setLogPath(cfg.logPath ?? '');
  }, [cfg.thresholdOverride, cfg.windowSecondsOverride, cfg.threshold, cfg.windowSeconds, cfg.logPath]);

  async function save() {
    setSaving(true);
    try {
      const thr = Math.max(1, Number(threshold) || cfg.threshold);
      const w = Math.max(10, Number(windowSecs) || cfg.windowSeconds);
      await serviceTemplatesApi.upsertAssignment(
        cfg.templateId, apiScope, scopeId,
        {
          thresholdOverride: thr,
          windowSecondsOverride: w,
          logPathOverride: logPath.trim() || null,
        },
      );
      onSaved();
      toast.success(t('agentDetail.templatesPanel.overridesSaved', { defaultValue: 'Overrides saved' }));
    } catch {
      toast.error(t('agentDetail.templatesPanel.overridesSaveFailed', { defaultValue: 'Failed to save overrides' }));
    } finally {
      setSaving(false);
    }
  }

  async function resetOverrides() {
    setSaving(true);
    try {
      await serviceTemplatesApi.upsertAssignment(
        cfg.templateId, apiScope, scopeId,
        { thresholdOverride: null, windowSecondsOverride: null, logPathOverride: null },
      );
      onSaved();
      toast.success(t('agentDetail.templatesPanel.overridesReset', { defaultValue: 'Overrides reset to template defaults' }));
    } catch {
      toast.error(t('agentDetail.templatesPanel.overridesResetFailed', { defaultValue: 'Failed to reset overrides' }));
    } finally {
      setSaving(false);
    }
  }

  const hasOverride = cfg.thresholdOverrideScope !== null;

  return (
    <div className="px-4 pb-3 pt-2 space-y-2 border-t border-border/50 bg-bg-tertiary/30">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted block">
        {t('agentDetail.templatesPanel.overrides', { defaultValue: 'Overrides' })}
      </span>

      {/* Log path */}
      <label className="flex items-center gap-2 text-[11px] text-text-secondary">
        <FolderOpen size={11} className="text-text-muted flex-shrink-0" />
        <span className="flex-shrink-0">{t('agentDetail.templatesPanel.logPath', { defaultValue: 'Log path' })}</span>
        <input
          type="text"
          value={logPath}
          onChange={e => setLogPath(e.target.value)}
          placeholder={cfg.isBuiltin
            ? t('agentDetail.templatesPanel.builtinPath', { defaultValue: 'Built-in path' })
            : t('agentDetail.templatesPanel.logPathPlaceholder', { defaultValue: 'e.g. /var/log/app/auth.log' })}
          className="flex-1 min-w-0 rounded border border-border bg-bg-secondary px-2 py-1 text-xs font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
        />
      </label>

      {/* Threshold + window row */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          {t('agentDetail.templatesPanel.failures', { defaultValue: 'Failures' })}
          <input
            type="number"
            min={1}
            value={threshold}
            onChange={e => setThreshold(e.target.value)}
            className="w-14 rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-accent"
          />
        </label>

        <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          {t('agentDetail.templatesPanel.window', { defaultValue: 'Window' })}
          <input
            type="number"
            min={10}
            value={windowSecs}
            onChange={e => setWindowSecs(e.target.value)}
            className="w-18 rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-accent"
          />
          <span className="text-text-muted">s</span>
        </label>

        <span className="text-[10px] text-text-muted">
          {t('agentDetail.templatesPanel.templateDefault', { threshold: cfg.threshold, window: cfg.windowSeconds, defaultValue: '(template default: {{threshold}}f / {{window}}s)' })}
        </span>

        {hasOverride && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
            {(cfg.thresholdOverrideScope === 'agent' ? t('agentDetail.templatesPanel.agentOverride', { defaultValue: 'agent override' }) : t('agentDetail.templatesPanel.groupOverride', { defaultValue: 'group override' }))}
          </span>
        )}

        <div className="flex items-center gap-1 ml-auto">
          {hasOverride && (
            <button
              onClick={() => void resetOverrides()}
              disabled={saving}
              title={t('agentDetail.templatesPanel.resetAllHint', { defaultValue: 'Reset all overrides to template defaults' })}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-amber-500 hover:bg-amber-500/10 disabled:opacity-50 transition-colors"
            >
              <RotateCcw size={10} />
              {t('common.reset')}
            </button>
          )}
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-50 transition-colors"
          >
            <Check size={10} />
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
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
  readOnly = false,
}: ServiceTemplatesPanelProps) {
  const { t } = useTranslation();
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
    } catch (err) {
      // Page-load failure: say so, with a Retry (the panel would otherwise stay empty).
      toast.error((tst) => (
        <span className="flex items-center gap-3">
          <span>{apiErrorMessage(err) ?? t('agentDetail.templatesPanel.loadFailed', { defaultValue: 'Failed to load service templates' })}</span>
          <button
            type="button"
            className="shrink-0 text-xs font-medium text-accent hover:underline"
            onClick={() => { toast.dismiss(tst.id); void load(); }}
          >
            {t('common.retry')}
          </button>
        </span>
      ), { id: `service-templates-load:${scope}:${scopeId}` });
    } finally {
      setLoading(false);
    }
  }, [scope, scopeId, t]);

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
    } catch (err) {
      toast.error(apiErrorMessage(err) ?? t('agentDetail.templatesPanel.bindFailed', { defaultValue: 'Failed to bind the template' }));
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
    } catch (err) {
      toast.error(apiErrorMessage(err) ?? t('agentDetail.templatesPanel.unbindFailed', { defaultValue: 'Failed to unbind the template' }));
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
    } catch (err) {
      toast.error(apiErrorMessage(err) ?? t('agentDetail.templatesPanel.resetFailed', { defaultValue: 'Failed to reset the override' }));
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
            {t('agentDetail.templatesPanel.title', { defaultValue: 'Service Templates' })}
          </h2>
          {!loading && (
            <span className="text-xs text-text-muted">
              {t('agentDetail.templatesPanel.activeCount', { count: boundCount, defaultValue: '{{count}} active' })}
              {unboundCount > 0 ? `, ${t('agentDetail.templatesPanel.inactiveCount', { count: unboundCount, defaultValue: '{{count}} inactive' })}` : ''}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          {scope === 'device' && onCreateLocal && !readOnly && (
            <button
              onClick={onCreateLocal}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent hover:bg-accent/10 transition-colors"
              title={t('agentDetail.templatesPanel.createLocalHint', { defaultValue: 'Create local template for this agent' })}
            >
              <Plus size={11} /> {t('agentDetail.templatesPanel.localTemplate', { defaultValue: 'Local template' })}
            </button>
          )}
          <IconButton
            label={t('common.refresh')}
            icon={<RefreshCw size={12} className={loading ? 'animate-spin' : ''} />}
            onClick={() => void load()}
            size="sm"
          />
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div>
          {loading ? (
            <div className="py-8 text-center text-sm text-text-muted">{t('common.loading')}</div>
          ) : configs.length === 0 ? (
            <div className="py-8 text-center text-sm text-text-muted">
              {t('agentDetail.templatesPanel.empty', { defaultValue: 'No service templates configured.' })}
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
                              {t('agentDetail.templatesPanel.groupTemplate', { defaultValue: 'Group template' })}
                            </span>
                          )}

                          {/* ── State badges ── */}

                          {/* No override at all and template is off by default */}
                          {!cfg.enabled && overrideScope === null && (
                            <span className="text-[10px] text-text-muted">{t('agentDetail.templatesPanel.inactiveByDefault', { defaultValue: 'Inactive by default' })}</span>
                          )}

                          {/* Device scope: agent-level explicit override */}
                          {scope === 'device' && overrideScope === 'agent' && (
                            <span className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                              cfg.enabled
                                ? 'bg-green-500/10 text-green-400'
                                : 'bg-amber-500/10 text-amber-400',
                            )}>
                              {cfg.enabled
                                ? t('agentDetail.templatesPanel.boundAgent', { defaultValue: 'Bound (agent)' })
                                : t('agentDetail.templatesPanel.unboundAgent', { defaultValue: 'Unbound (agent)' })}
                            </span>
                          )}

                          {/* Device scope: unbound by a group-level override (no agent override on top) */}
                          {scope === 'device' && overrideScope === 'group' && !cfg.enabled && (
                            <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                              {t('agentDetail.templatesPanel.unboundGroup', { defaultValue: 'Unbound (group)' })}
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
                              {cfg.enabled
                                ? t('agentDetail.templatesPanel.boundGroup', { defaultValue: 'Bound (group)' })
                                : t('agentDetail.templatesPanel.unboundGroup', { defaultValue: 'Unbound (group)' })}
                            </span>
                          )}
                        </div>

                        {/* Details line */}
                        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-text-muted">
                          <span>
                            {cfg.threshold}f / {cfg.windowSeconds}s
                            {cfg.thresholdOverrideScope && (
                              <span className="text-amber-400 ml-1">
                                ({(cfg.thresholdOverrideScope === 'agent' ? t('agentDetail.templatesPanel.agentOverride', { defaultValue: 'agent override' }) : t('agentDetail.templatesPanel.groupOverride', { defaultValue: 'group override' }))})
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
                        {cfg.enabled && !readOnly && (
                          <IconButton
                            label={t('agentDetail.templatesPanel.editThreshold', { defaultValue: 'Edit threshold override' })}
                            icon={isEditingThis ? <X size={12} /> : <Sliders size={12} />}
                            onClick={() => setEditingThreshold(isEditingThis ? null : cfg.templateId)}
                            variant="accent"
                            active={isEditingThis}
                            className="shrink-0 rounded-md"
                          />
                        )}

                        {/* Reset: only shown when this scope has an explicit override */}
                        {hasScopeOverride && !readOnly && (
                          <button
                            onClick={() => void reset(cfg)}
                            disabled={isBusy}
                            title={
                              scope === 'device'
                                ? t('agentDetail.templatesPanel.resetAgentHint', { defaultValue: 'Remove agent override — inherit from group / template default' })
                                : t('agentDetail.templatesPanel.resetGroupHint', { defaultValue: 'Remove group override — inherit from template default' })
                            }
                            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-amber-500 hover:bg-amber-500/10 disabled:opacity-50 transition-colors flex items-center gap-1"
                          >
                            <RotateCcw size={11} />
                            {t('common.reset')}
                          </button>
                        )}

                        {/* Bind / Unbind — always shown based on current effective state */}
                        {readOnly ? null : cfg.enabled ? (
                          <button
                            onClick={() => void unbind(cfg)}
                            disabled={isBusy}
                            title={scope === 'group'
                              ? t('agentDetail.templatesPanel.unbindGroupHint', { defaultValue: 'Unbind for all agents in this group' })
                              : t('agentDetail.templatesPanel.unbindAgentHint', { defaultValue: 'Unbind for this agent' })}
                            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 transition-colors"
                          >
                            {t('agentDetail.templatesPanel.unbind', { defaultValue: 'Unbind' })}
                          </button>
                        ) : (
                          <button
                            onClick={() => void bind(cfg)}
                            disabled={isBusy}
                            title={
                              scope === 'device' && overrideScope === 'group'
                                ? t('agentDetail.templatesPanel.bindOverrideGroupHint', { defaultValue: 'Override group: bind for this agent only' })
                                : scope === 'group'
                                ? t('agentDetail.templatesPanel.bindGroupHint', { defaultValue: 'Bind for all agents in this group' })
                                : t('agentDetail.templatesPanel.bindAgentHint', { defaultValue: 'Bind for this agent' })
                            }
                            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-50 transition-colors"
                          >
                            {t('agentDetail.templatesPanel.bind', { defaultValue: 'Bind' })}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Threshold editor (expanded row) */}
                    {isEditingThis && !readOnly && (
                      <OverridesEditor
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
