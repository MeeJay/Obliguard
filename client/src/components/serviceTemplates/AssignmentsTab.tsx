import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Eraser, Pencil, Plus, Search, Server, Trash2, Users } from 'lucide-react';
import type {
  AgentDevice,
  GroupTreeNode,
  ServiceTemplate,
  ServiceTemplateAssignment,
  UpsertServiceAssignmentRequest,
} from '@obliview/shared';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { serviceTemplatesApi, templateApiError, type ServiceTemplateScope } from '@/api/serviceTemplates.api';
import { anonHostname, anonPath } from '@/utils/anonymize';
import { cn } from '@/utils/cn';

export interface ScopeTarget {
  scope: ServiceTemplateScope;
  scopeId: number;
}

interface AssignmentsTabProps {
  template: ServiceTemplate;
  /** templates.write: create / edit / remove assignments. */
  canAssign: boolean;
  /** Every group / agent the caller can see (labels). */
  groups: GroupTreeNode[];
  agents: AgentDevice[];
  /** Assignable targets: the operating tenant's groups / writable agents only. */
  ownGroups: GroupTreeNode[];
  ownAgents: AgentDevice[];
  /** Reload the template (assignments) after a change. */
  onChanged: () => void;
}

export function findGroup(tree: GroupTreeNode[], id: number): GroupTreeNode | undefined {
  for (const n of tree) {
    if (n.id === id) return n;
    const found = findGroup(n.children, id);
    if (found) return found;
  }
  return undefined;
}

export function agentLabel(agent: AgentDevice): string {
  return agent.name || anonHostname(agent.hostname);
}

/**
 * Group / agent assignments of a template. Targets are limited to the
 * operating tenant (the server refuses others: 404, or 403 from Default), so
 * rows on another tenant's targets (god view) are read-only. Log path
 * overrides are never offered (an arbitrary file read on the agent): an
 * existing one is shown and can only be cleared.
 */
export function AssignmentsTab({ template, canAssign, groups, agents, ownGroups, ownAgents, onChanged }: AssignmentsTabProps) {
  const { t } = useTranslation();
  const confirmAction = useConfirm();
  const [editing, setEditing] = useState<ServiceTemplateAssignment | 'new' | null>(null);
  const assignments = template.assignments ?? [];

  const ownGroupIds = useMemo(() => {
    const ids = new Set<number>();
    const walk = (nodes: GroupTreeNode[]) => { for (const n of nodes) { ids.add(n.id); walk(n.children); } };
    walk(ownGroups);
    return ids;
  }, [ownGroups]);
  const ownAgentIds = useMemo(() => new Set(ownAgents.map((a) => a.id)), [ownAgents]);

  const isOwnTarget = (a: ServiceTemplateAssignment) =>
    a.scope === 'group' ? ownGroupIds.has(a.scopeId) : ownAgentIds.has(a.scopeId);

  const targetLabel = (a: Pick<ServiceTemplateAssignment, 'scope' | 'scopeId'>) => {
    if (a.scope === 'agent') {
      const agent = agents.find((x) => x.id === a.scopeId);
      return agent ? agentLabel(agent) : t('serviceTemplates.assignments.agentFallback', { defaultValue: 'Agent #{{id}}', id: a.scopeId });
    }
    const group = findGroup(groups, a.scopeId);
    return group ? group.name : t('serviceTemplates.assignments.groupFallback', { defaultValue: 'Group #{{id}}', id: a.scopeId });
  };

  const remove = async (a: ServiceTemplateAssignment) => {
    const ok = await confirmAction({
      title: t('serviceTemplates.assignments.removeTitle', { defaultValue: 'Remove assignment' }),
      message: t('serviceTemplates.assignments.removeConfirm', {
        defaultValue: 'Remove "{{template}}" from {{target}}? The target falls back to the inherited setting.',
        template: template.name,
        target: targetLabel(a),
      }),
      confirmLabel: t('serviceTemplates.assignments.remove', { defaultValue: 'Remove' }),
      danger: true,
    });
    if (!ok) return;
    try {
      await serviceTemplatesApi.deleteAssignment(template.id, a.scope, a.scopeId);
      toast.success(t('serviceTemplates.assignments.removed', { defaultValue: 'Assignment removed' }));
      onChanged();
    } catch (err) {
      toast.error(templateApiError(err, t('serviceTemplates.assignments.removeFailed', { defaultValue: 'Failed to remove the assignment' })));
    }
  };

  const clearLogPath = async (a: ServiceTemplateAssignment) => {
    try {
      await serviceTemplatesApi.upsertAssignment(template.id, a.scope, a.scopeId, { logPathOverride: null });
      toast.success(t('serviceTemplates.assignments.logPathCleared', { defaultValue: 'Log path override cleared' }));
      onChanged();
    } catch (err) {
      toast.error(templateApiError(err, t('serviceTemplates.assignments.saveFailed', { defaultValue: 'Failed to save the assignment' })));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-muted">
          {template.enabled
            ? t('serviceTemplates.assignments.hintEnabled', { defaultValue: 'Enabled by default: active on every agent unless an assignment turns it off.' })
            : t('serviceTemplates.assignments.hintDisabled', { defaultValue: 'Off by default: active only where an assignment turns it on.' })}
        </p>
        {canAssign && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus size={14} className="mr-1" />
            {t('serviceTemplates.assignments.add', { defaultValue: 'Assign' })}
          </Button>
        )}
      </div>

      {assignments.length === 0 ? (
        <EmptyState
          compact
          title={t('serviceTemplates.assignments.empty', { defaultValue: 'No assignments' })}
          description={t('serviceTemplates.assignments.emptyHint', { defaultValue: 'Assign the template to a group or an agent to turn it on or off there, or to change its threshold.' })}
        />
      ) : (
        <ul className="space-y-1.5">
          {assignments.map((a) => {
            const own = isOwnTarget(a);
            const writable = canAssign && own;
            const inherited = !a.logPathOverride && a.thresholdOverride == null && a.windowSecondsOverride == null && a.enabledOverride == null;
            return (
              <li key={a.id} className="flex items-start gap-3 rounded-lg bg-bg-tertiary/60 px-3 py-2 text-xs">
                <span className={cn(
                  'mt-0.5 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                  a.scope === 'agent' ? 'bg-accent/15 text-accent' : 'bg-purple-500/15 text-purple-400',
                )}>
                  {a.scope === 'agent' ? <Server size={9} aria-hidden="true" /> : <Users size={9} aria-hidden="true" />}
                  {a.scope === 'agent'
                    ? t('serviceTemplates.assignments.scopeAgent', { defaultValue: 'Agent' })
                    : t('serviceTemplates.assignments.scopeGroup', { defaultValue: 'Group' })}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-text-primary">{targetLabel(a)}</span>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-text-muted">
                    {a.enabledOverride != null && (
                      <span className={a.enabledOverride ? 'text-status-up' : 'text-text-muted'}>
                        {a.enabledOverride
                          ? t('serviceTemplates.assignments.forcedOn', { defaultValue: 'turned on' })
                          : t('serviceTemplates.assignments.forcedOff', { defaultValue: 'turned off' })}
                      </span>
                    )}
                    {a.thresholdOverride != null && (
                      <span>{t('serviceTemplates.assignments.thresholdValue', { defaultValue: 'threshold: {{value}}', value: a.thresholdOverride })}</span>
                    )}
                    {a.windowSecondsOverride != null && (
                      <span>{t('serviceTemplates.assignments.windowValue', { defaultValue: 'window: {{value}}s', value: a.windowSecondsOverride })}</span>
                    )}
                    {a.logPathOverride && (
                      <span className="max-w-[16rem] truncate font-mono text-amber-400" title={anonPath(a.logPathOverride)}>
                        {t('serviceTemplates.assignments.logPathValue', { defaultValue: 'log path: {{value}}', value: anonPath(a.logPathOverride) })}
                      </span>
                    )}
                    {inherited && (
                      <span className="italic">{t('serviceTemplates.assignments.allInherited', { defaultValue: 'all inherited' })}</span>
                    )}
                    {!own && (
                      <span className="italic">{t('serviceTemplates.assignments.foreign', { defaultValue: 'other tenant (read-only)' })}</span>
                    )}
                  </div>
                </div>
                {writable && (
                  <ActionMenu
                    triggerSize="sm"
                    label={t('serviceTemplates.assignments.rowActions', { defaultValue: 'Actions for {{target}}', target: targetLabel(a) })}
                    items={[
                      {
                        key: 'edit',
                        icon: <Pencil className="h-4 w-4" />,
                        label: t('serviceTemplates.assignments.edit', { defaultValue: 'Edit overrides' }),
                        onClick: () => setEditing(a),
                      },
                      {
                        key: 'clear-path',
                        icon: <Eraser className="h-4 w-4" />,
                        label: t('serviceTemplates.assignments.clearLogPath', { defaultValue: 'Clear log path override' }),
                        onClick: () => void clearLogPath(a),
                        hidden: !a.logPathOverride,
                      },
                      {
                        key: 'remove',
                        icon: <Trash2 className="h-4 w-4" />,
                        label: t('serviceTemplates.assignments.remove', { defaultValue: 'Remove' }),
                        onClick: () => void remove(a),
                        danger: true,
                        separator: true,
                      },
                    ]}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AssignmentModal
        open={editing !== null}
        template={template}
        existing={editing === 'new' ? null : editing}
        existingLabel={editing && editing !== 'new' ? targetLabel(editing) : ''}
        assigned={assignments}
        groups={ownGroups}
        agents={ownAgents}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); onChanged(); }}
      />
    </div>
  );
}

// ── Assignment dialog ────────────────────────────────────────────────────────

type EnabledOverride = '' | 'true' | 'false';

function AssignmentModal({ open, template, existing, existingLabel, assigned, groups, agents, onClose, onSaved }: {
  open: boolean;
  template: ServiceTemplate;
  existing: ServiceTemplateAssignment | null;
  existingLabel: string;
  assigned: ServiceTemplateAssignment[];
  groups: GroupTreeNode[];
  agents: AgentDevice[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<ScopeTarget | null>(null);
  const [threshold, setThreshold] = useState('');
  const [windowSeconds, setWindowSeconds] = useState('');
  const [enabled, setEnabled] = useState<EnabledOverride>('');
  const [saving, setSaving] = useState(false);
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  // Reset the form each time the dialog opens (for a new row or another one).
  const openKey = open ? (existing ? `edit-${existing.id}` : 'new') : null;
  if (openKey !== openedFor) {
    setOpenedFor(openKey);
    if (openKey) {
      setTarget(existing ? { scope: existing.scope, scopeId: existing.scopeId } : null);
      setThreshold(existing?.thresholdOverride != null ? String(existing.thresholdOverride) : '');
      setWindowSeconds(existing?.windowSecondsOverride != null ? String(existing.windowSecondsOverride) : '');
      setEnabled(existing?.enabledOverride != null ? (existing.enabledOverride ? 'true' : 'false') : '');
    }
  }

  const thresholdNum = threshold.trim() === '' ? null : Number(threshold);
  const windowNum = windowSeconds.trim() === '' ? null : Number(windowSeconds);
  const thresholdError = thresholdNum != null && (!Number.isInteger(thresholdNum) || thresholdNum < 1)
    ? t('serviceTemplates.validation.threshold', { defaultValue: 'Whole number, 1 or more' })
    : undefined;
  const windowError = windowNum != null && (!Number.isInteger(windowNum) || windowNum < 10)
    ? t('serviceTemplates.validation.window', { defaultValue: 'Whole number of seconds, 10 or more' })
    : undefined;
  const alreadyAssigned = !existing && target != null
    && assigned.some((a) => a.scope === target.scope && a.scopeId === target.scopeId);

  const submit = async () => {
    if (!target || thresholdError || windowError) return;
    // Log path overrides are never sent from here (left untouched on edit).
    const data: UpsertServiceAssignmentRequest = {
      thresholdOverride: thresholdNum,
      windowSecondsOverride: windowNum,
      enabledOverride: enabled === '' ? null : enabled === 'true',
    };
    setSaving(true);
    try {
      await serviceTemplatesApi.upsertAssignment(template.id, target.scope, target.scopeId, data);
      toast.success(existing
        ? t('serviceTemplates.assignments.updated', { defaultValue: 'Assignment updated' })
        : t('serviceTemplates.assignments.created', { defaultValue: 'Assignment created' }));
      onSaved();
    } catch (err) {
      toast.error(templateApiError(err, t('serviceTemplates.assignments.saveFailed', { defaultValue: 'Failed to save the assignment' })));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      closeOnBackdrop={false}
      size="md"
      title={existing
        ? t('serviceTemplates.assignments.editTitle', { defaultValue: 'Edit assignment' })
        : t('serviceTemplates.assignments.addTitle', { defaultValue: 'Assign "{{name}}"', name: template.name })}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            onClick={() => void submit()}
            loading={saving}
            disabled={!target || !!thresholdError || !!windowError}
          >
            {existing
              ? t('common.save', { defaultValue: 'Save' })
              : t('serviceTemplates.assignments.add', { defaultValue: 'Assign' })}
          </Button>
        </>
      )}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        {existing ? (
          <div className="rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-secondary">{existingLabel}</div>
        ) : (
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-text-secondary">
              {t('serviceTemplates.assignments.target', { defaultValue: 'Assign to' })}
            </span>
            <ScopePicker groups={groups} agents={agents} value={target} onChange={setTarget} />
            {alreadyAssigned && (
              <p className="text-xs text-amber-400">
                {t('serviceTemplates.assignments.alreadyAssigned', { defaultValue: 'Already assigned: saving replaces its overrides.' })}
              </p>
            )}
          </div>
        )}

        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
            {t('serviceTemplates.assignments.overrides', { defaultValue: 'Overrides (leave blank to inherit from the template)' })}
          </p>
          <div className="space-y-1">
            <label htmlFor="st-assign-enabled" className="block text-sm font-medium text-text-secondary">
              {t('serviceTemplates.assignments.enabledOverride', { defaultValue: 'State' })}
            </label>
            <select
              id="st-assign-enabled"
              value={enabled}
              onChange={(e) => setEnabled(e.target.value as EnabledOverride)}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">{t('serviceTemplates.assignments.enabledInherit', { defaultValue: 'Inherit from template' })}</option>
              <option value="true">{t('serviceTemplates.assignments.enabledOn', { defaultValue: 'Turned on here' })}</option>
              <option value="false">{t('serviceTemplates.assignments.enabledOff', { defaultValue: 'Turned off here' })}</option>
            </select>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              id="st-assign-threshold"
              label={t('serviceTemplates.assignments.thresholdOverride', { defaultValue: 'Threshold' })}
              type="number"
              inputMode="numeric"
              min={1}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder={t('serviceTemplates.assignments.inheritValue', { defaultValue: 'Inherit ({{value}})', value: template.threshold })}
              error={thresholdError}
            />
            <Input
              id="st-assign-window"
              label={t('serviceTemplates.assignments.windowOverride', { defaultValue: 'Window (seconds)' })}
              type="number"
              inputMode="numeric"
              min={10}
              value={windowSeconds}
              onChange={(e) => setWindowSeconds(e.target.value)}
              placeholder={t('serviceTemplates.assignments.inheritValue', { defaultValue: 'Inherit ({{value}})', value: template.windowSeconds })}
              error={windowError}
            />
          </div>
          {existing?.logPathOverride && (
            <p className="text-xs text-amber-400">
              {t('serviceTemplates.assignments.logPathKept', { defaultValue: 'This assignment has a log path override; it is kept. Use "Clear log path override" to remove it.' })}
            </p>
          )}
        </div>
        {/* Enter submits from the inputs. */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

// ── Single-target picker (groups + agents of the operating tenant) ───────────

function ScopePicker({ groups, agents, value, onChange }: {
  groups: GroupTreeNode[];
  agents: AgentDevice[];
  value: ScopeTarget | null;
  onChange: (v: ScopeTarget) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const agentsByGroup = useMemo(() => {
    const groupIds = new Set<number>();
    const walk = (nodes: GroupTreeNode[]) => { for (const n of nodes) { groupIds.add(n.id); walk(n.children); } };
    walk(groups);
    const map = new Map<number | null, AgentDevice[]>();
    for (const a of agents) {
      // An agent whose group is not listed (hidden, other tenant) shows as ungrouped.
      const key = a.groupId != null && groupIds.has(a.groupId) ? a.groupId : null;
      const list = map.get(key) ?? [];
      list.push(a);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((x, y) => agentLabel(x).localeCompare(agentLabel(y)));
    return map;
  }, [agents, groups]);

  const agentMatches = (a: AgentDevice) => !q || agentLabel(a).toLowerCase().includes(q) || a.hostname.toLowerCase().includes(q);
  // A group is shown when it, one of its agents or one of its sub-groups matches.
  const groupVisible = (g: GroupTreeNode): boolean =>
    !q || g.name.toLowerCase().includes(q)
    || (agentsByGroup.get(g.id) ?? []).some(agentMatches)
    || g.children.some(groupVisible);

  const row = (selected: boolean, depth: number) => cn(
    'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors coarse:py-2.5',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60',
    selected ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
    depth === 0 && 'font-medium',
  );

  const renderAgent = (a: AgentDevice, depth: number) => {
    if (!agentMatches(a)) return null;
    const selected = value?.scope === 'agent' && value.scopeId === a.id;
    return (
      <button
        key={`a-${a.id}`}
        type="button"
        role="option"
        aria-selected={selected}
        onClick={() => onChange({ scope: 'agent', scopeId: a.id })}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className={row(selected, depth + 1)}
      >
        <Server size={11} className="shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate">{agentLabel(a)}</span>
      </button>
    );
  };

  const renderGroup = (g: GroupTreeNode, depth: number): JSX.Element | null => {
    if (!groupVisible(g)) return null;
    const selected = value?.scope === 'group' && value.scopeId === g.id;
    return (
      <div key={`g-${g.id}`}>
        <button
          type="button"
          role="option"
          aria-selected={selected}
          onClick={() => onChange({ scope: 'group', scopeId: g.id })}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          className={row(selected, 0)}
        >
          <Users size={12} className="shrink-0" aria-hidden="true" />
          <span className="flex-1 truncate">{g.name}</span>
        </button>
        {(agentsByGroup.get(g.id) ?? []).map((a) => renderAgent(a, depth + 1))}
        {g.children.map((c) => renderGroup(c, depth + 1))}
      </div>
    );
  };

  const ungrouped = (agentsByGroup.get(null) ?? []).filter(agentMatches);
  const nothing = groups.length === 0 && agents.length === 0;

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('serviceTemplates.assignments.searchTargets', { defaultValue: 'Search groups and agents…' })}
          aria-label={t('serviceTemplates.assignments.searchTargets', { defaultValue: 'Search groups and agents…' })}
          className="w-full rounded-md bg-bg-tertiary py-1.5 pl-8 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/60"
        />
      </div>
      <div
        role="listbox"
        aria-label={t('serviceTemplates.assignments.target', { defaultValue: 'Assign to' })}
        className="max-h-60 space-y-0.5 overflow-y-auto overscroll-contain rounded-md bg-bg-tertiary p-1"
      >
        {nothing && (
          <p className="py-4 text-center text-xs text-text-muted">
            {t('serviceTemplates.assignments.noTargets', { defaultValue: 'No group or agent of this tenant can be assigned.' })}
          </p>
        )}
        {groups.map((g) => renderGroup(g, 0))}
        {ungrouped.length > 0 && (
          <>
            <div className="mt-1 border-t border-border/50 px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
              {t('serviceTemplates.assignments.ungrouped', { defaultValue: 'Ungrouped agents' })}
            </div>
            {ungrouped.map((a) => renderAgent(a, 0))}
          </>
        )}
      </div>
    </div>
  );
}
