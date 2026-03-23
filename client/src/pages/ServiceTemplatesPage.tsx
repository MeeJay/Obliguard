import { useState, useEffect, useCallback } from 'react';
import {
  ScanSearch, Plus, Pencil, Trash2, RefreshCw, X,
  AlertTriangle, ChevronDown, ChevronUp, Terminal,
  Lock, Unlock, Eye, Shield, EyeOff, Users, Server,
} from 'lucide-react';
import toast from 'react-hot-toast';
import type {
  ServiceTemplate,
  ServiceTemplateAssignment,
  ServiceTemplateMode,
  CreateServiceTemplateRequest,
  UpdateServiceTemplateRequest,
  UpsertServiceAssignmentRequest,
} from '@obliview/shared';
import type { GroupTreeNode } from '@obliview/shared';
import type { AgentDevice } from '@obliview/shared';
import { serviceTemplatesApi } from '@/api/serviceTemplates.api';
import { groupsApi } from '@/api/groups.api';
import { agentApi } from '@/api/agent.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';
import { anonPath } from '@/utils/anonymize';

const SERVICE_ICONS: Record<string, string> = {
  ssh: '🔐', rdp: '🖥', nginx: '🌐', apache: '🌐', iis: '🌐',
  ftp: '📁', mail: '✉️', mysql: '🗄', custom: '⚙️',
};

function ServiceTypeBadge({ type, isBuiltin }: { type: string; isBuiltin: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
      isBuiltin ? 'bg-blue-500/15 text-blue-400' : 'bg-purple-500/15 text-purple-400',
    )}>
      <span>{SERVICE_ICONS[type] ?? '📡'}</span>
      {type}
      {isBuiltin && <Lock size={9} className="opacity-60" />}
    </span>
  );
}

function ModeBadge({ mode }: { mode: ServiceTemplateMode }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold',
      mode === 'ban'
        ? 'bg-red-500/15 text-red-400'
        : 'bg-amber-500/15 text-amber-400',
    )}>
      {mode === 'ban' ? <Shield size={9} /> : <EyeOff size={9} />}
      {mode === 'ban' ? 'Ban' : 'Track only'}
    </span>
  );
}

// ── Confirm dialog ────────────────────────────────────────────────────────────

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

function ConfirmDialog({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel, loading }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-primary shadow-2xl p-6">
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle size={18} className="text-status-down shrink-0 mt-0.5" />
          <div>
            <h2 className="text-base font-semibold text-text-primary">{title}</h2>
            <p className="text-sm text-text-muted mt-1">{message}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="danger" loading={loading} onClick={onConfirm} className="flex-1">
            {confirmLabel}
          </Button>
          <Button variant="secondary" onClick={onCancel} className="flex-1">Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── Template form modal ───────────────────────────────────────────────────────

interface TemplateFormModalProps {
  template?: ServiceTemplate;
  onSave: (data: CreateServiceTemplateRequest | UpdateServiceTemplateRequest) => Promise<void>;
  onClose: () => void;
}

function TemplateFormModal({ template, onSave, onClose }: TemplateFormModalProps) {
  const [name, setName] = useState(template?.name ?? '');
  const [serviceType, setServiceType] = useState<string>(template?.serviceType ?? 'custom');
  const [threshold, setThreshold] = useState(String(template?.threshold ?? 5));
  const [windowSeconds, setWindowSeconds] = useState(String(template?.windowSeconds ?? 300));
  const [defaultLogPath, setDefaultLogPath] = useState(template?.defaultLogPath ?? '');
  const [customRegex, setCustomRegex] = useState(template?.customRegex ?? '');
  const [enabled, setEnabled] = useState(template?.enabled ?? false);
  const [mode, setMode] = useState<ServiceTemplateMode>(template?.mode ?? 'ban');
  const [saving, setSaving] = useState(false);
  const isEdit = !!template;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const data = {
        name: name.trim(),
        ...(!isEdit && { serviceType }),
        defaultLogPath: defaultLogPath.trim() || null,
        customRegex: customRegex.trim() || null,
        threshold: Number(threshold),
        windowSeconds: Number(windowSeconds),
        enabled,
        mode,
      };
      await onSave(data);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-bg-primary shadow-2xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-text-primary">
            {isEdit ? 'Edit Template' : 'Create Custom Template'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Custom App" required autoFocus />
          {!isEdit && (
            <div className="space-y-1">
              <label className="block text-sm font-medium text-text-secondary">Service Type</label>
              <select
                value={serviceType}
                onChange={e => setServiceType(e.target.value)}
                className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="custom">Custom</option>
                <option value="ssh">SSH</option>
                <option value="rdp">RDP</option>
                <option value="nginx">Nginx</option>
                <option value="apache">Apache</option>
                <option value="iis">IIS</option>
                <option value="ftp">FTP</option>
                <option value="mail">Mail</option>
                <option value="mysql">MySQL</option>
              </select>
            </div>
          )}

          {/* Mode toggle */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text-secondary">Mode</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('ban')}
                className={cn(
                  'flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                  mode === 'ban'
                    ? 'border-red-500 bg-red-500/10 text-red-400'
                    : 'border-border bg-bg-tertiary text-text-muted hover:text-text-primary',
                )}
              >
                <Shield size={14} />
                Ban
              </button>
              <button
                type="button"
                onClick={() => setMode('track')}
                className={cn(
                  'flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                  mode === 'track'
                    ? 'border-amber-500 bg-amber-500/10 text-amber-400'
                    : 'border-border bg-bg-tertiary text-text-muted hover:text-text-primary',
                )}
              >
                <EyeOff size={14} />
                Track only
              </button>
            </div>
            <p className="text-xs text-text-muted">
              {mode === 'ban'
                ? 'Events count toward BanEngine thresholds and trigger automatic bans.'
                : 'Events are stored for visibility and reputation, but never trigger automatic bans.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input label="Failure Threshold" type="number" min={1} value={threshold} onChange={e => setThreshold(e.target.value)} placeholder="5" />
            <Input label="Window (seconds)" type="number" min={60} value={windowSeconds} onChange={e => setWindowSeconds(e.target.value)} placeholder="300" />
          </div>
          <Input
            label="Default Log Path (optional)"
            value={defaultLogPath}
            onChange={e => setDefaultLogPath(e.target.value)}
            placeholder="/var/log/app/access.log  or use $logpath as placeholder"
          />
          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Custom Regex (optional)</label>
            <textarea
              value={customRegex}
              onChange={e => setCustomRegex(e.target.value)}
              placeholder="(?P<ip>\\d+\\.\\d+\\.\\d+\\.\\d+).*(?P<username>\\S+).*Failed"
              rows={3}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent resize-none"
            />
            <p className="text-xs text-text-muted">
              Use named groups: <code className="font-mono bg-bg-tertiary px-1 rounded">{'(?P<ip>...)'}</code> and <code className="font-mono bg-bg-tertiary px-1 rounded">{'(?P<username>...)'}</code>
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <div className="relative h-4 w-4 shrink-0">
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
                className="peer appearance-none h-4 w-4 rounded border cursor-pointer transition-colors bg-bg-tertiary border-border checked:bg-accent checked:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30" />
              <svg className="pointer-events-none absolute top-0 left-0 hidden h-4 w-4 text-white peer-checked:block" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 8L6 11.5L13.5 4.5" />
              </svg>
            </div>
            <span className="text-sm text-text-secondary">
              Enabled globally
              <span className="ml-1 text-xs text-text-muted">(activate per group / agent otherwise)</span>
            </span>
          </label>
          <div className="flex gap-2 pt-2">
            <Button type="submit" loading={saving} className="flex-1">{isEdit ? 'Save Changes' : 'Create Template'}</Button>
            <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Recursively find a group in a GroupTreeNode[] by id */
function findInTree(tree: GroupTreeNode[], id: number): GroupTreeNode | undefined {
  for (const n of tree) {
    if (n.id === id) return n;
    const found = findInTree(n.children, id);
    if (found) return found;
  }
  return undefined;
}

// ── ScopeTreePicker — unified tree showing groups + agents ────────────────────

interface ScopeSelection {
  scope: 'group' | 'agent';
  scopeId: number;
}

function ScopeTreePicker({
  groups,
  agents,
  value,
  onChange,
}: {
  groups: GroupTreeNode[];
  agents: AgentDevice[];
  value: ScopeSelection | null;
  onChange: (v: ScopeSelection | null) => void;
}) {
  function renderGroup(group: GroupTreeNode, depth: number) {
    const isSelected = value?.scope === 'group' && value.scopeId === group.id;
    const groupAgents = agents.filter(a => a.groupId === group.id);

    return (
      <div key={group.id}>
        <button
          type="button"
          onClick={() => onChange({ scope: 'group', scopeId: group.id })}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          className={cn(
            'w-full flex items-center gap-2 rounded-md py-1.5 pr-2 text-sm text-left transition-colors',
            isSelected
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          <Users size={12} className="shrink-0" />
          <span className="flex-1 truncate font-medium">{group.name}</span>
          {(groupAgents.length > 0 || group.children.length > 0) && (
            <span className={cn('text-[10px]', isSelected ? 'text-white/70' : 'text-text-muted')}>
              {groupAgents.length}a{group.children.length > 0 ? ` ${group.children.length}sg` : ''}
            </span>
          )}
        </button>
        {/* Agents under this group */}
        {groupAgents.map(a => renderAgent(a, depth + 1))}
        {/* Child groups */}
        {group.children.map(child => renderGroup(child, depth + 1))}
      </div>
    );
  }

  function renderAgent(agent: AgentDevice, depth: number) {
    const isSelected = value?.scope === 'agent' && value.scopeId === agent.id;
    return (
      <button
        key={agent.id}
        type="button"
        onClick={() => onChange({ scope: 'agent', scopeId: agent.id })}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className={cn(
          'w-full flex items-center gap-2 rounded-md py-1.5 pr-2 text-sm text-left transition-colors',
          isSelected
            ? 'bg-accent text-white'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        )}
      >
        <Server size={11} className="shrink-0" />
        <span className="flex-1 truncate">{agent.name ?? agent.hostname}</span>
      </button>
    );
  }

  const ungroupedAgents = agents.filter(a => a.groupId === null);

  return (
    <div className="max-h-52 overflow-y-auto rounded-md border border-border bg-bg-tertiary p-1 space-y-0.5">
      {groups.length === 0 && agents.length === 0 && (
        <p className="py-4 text-center text-xs text-text-muted">No groups or agents available</p>
      )}
      {groups.map(g => renderGroup(g, 0))}
      {ungroupedAgents.length > 0 && (
        <>
          <div className="px-2 py-1 text-[10px] text-text-muted uppercase font-semibold tracking-wide border-t border-border/50 mt-1 pt-2">
            Ungrouped agents
          </div>
          {ungroupedAgents.map(a => renderAgent(a, 0))}
        </>
      )}
    </div>
  );
}

// ── Assignment modal ──────────────────────────────────────────────────────────

interface AssignmentModalProps {
  templateId: number;
  existing?: ServiceTemplateAssignment;
  groups: GroupTreeNode[];
  agents: AgentDevice[];
  onSave: () => void;
  onClose: () => void;
}

function AssignmentModal({ templateId, existing, groups, agents, onSave, onClose }: AssignmentModalProps) {
  const [selection, setSelection]   = useState<ScopeSelection | null>(
    existing ? { scope: existing.scope, scopeId: existing.scopeId } : null,
  );
  const [logPathOverride, setLogPathOverride] = useState(existing?.logPathOverride ?? '');
  const [thresholdOverride, setThresholdOverride] = useState(
    existing?.thresholdOverride != null ? String(existing.thresholdOverride) : '',
  );
  const [windowOverride, setWindowOverride] = useState(
    existing?.windowSecondsOverride != null ? String(existing.windowSecondsOverride) : '',
  );
  const [enabledOverride, setEnabledOverride] = useState<'' | 'true' | 'false'>(
    existing?.enabledOverride != null ? (existing.enabledOverride ? 'true' : 'false') : '',
  );
  const [saving, setSaving] = useState(false);

  const isEdit = !!existing;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selection) return;
    setSaving(true);
    try {
      const data: UpsertServiceAssignmentRequest = {
        logPathOverride: logPathOverride.trim() || null,
        thresholdOverride: thresholdOverride ? Number(thresholdOverride) : null,
        windowSecondsOverride: windowOverride ? Number(windowOverride) : null,
        enabledOverride: enabledOverride === '' ? null : enabledOverride === 'true',
      };
      await serviceTemplatesApi.upsertAssignment(templateId, selection.scope, selection.scopeId, data);
      toast.success(isEdit ? 'Assignment updated' : 'Assignment created');
      onSave();
    } catch {
      toast.error('Failed to save assignment');
    } finally {
      setSaving(false);
    }
  }

  /** Human-readable label for the existing assignment scope (edit mode) */
  function existingLabel() {
    if (!existing) return '';
    if (existing.scope === 'agent') {
      const ag = agents.find(a => a.id === existing.scopeId);
      return ag ? `Agent — ${ag.name ?? ag.hostname}` : `Agent #${existing.scopeId}`;
    }
    const gr = findInTree(groups, existing.scopeId);
    return gr ? `Group — ${gr.name}` : `Group #${existing.scopeId}`;
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-bg-primary shadow-2xl p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-text-primary">
            {isEdit ? 'Edit Assignment' : 'Assign Template'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Target selector */}
          {isEdit ? (
            <div className="rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-muted">
              {existingLabel()}
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-text-secondary">
                Assign to
                {selection && (
                  <span className={cn(
                    'ml-2 text-xs px-1.5 py-0.5 rounded font-normal',
                    selection.scope === 'agent' ? 'bg-accent/15 text-accent' : 'bg-purple-500/15 text-purple-400',
                  )}>
                    {selection.scope === 'agent' ? 'Agent' : 'Group'} selected
                  </span>
                )}
              </label>
              <ScopeTreePicker
                groups={groups}
                agents={agents}
                value={selection}
                onChange={setSelection}
              />
              {!selection && (
                <p className="text-xs text-text-muted">Click a group or agent above to select the target.</p>
              )}
            </div>
          )}

          <div className="border-t border-border pt-3 space-y-3">
            <p className="text-xs text-text-muted font-medium uppercase tracking-wide">Overrides (leave blank to inherit from template)</p>
            <Input
              label="Log Path Override"
              value={logPathOverride}
              onChange={e => setLogPathOverride(e.target.value)}
              placeholder="/var/log/myapp/access.log"
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Threshold Override"
                type="number"
                min={1}
                value={thresholdOverride}
                onChange={e => setThresholdOverride(e.target.value)}
                placeholder="Inherit"
              />
              <Input
                label="Window Override (s)"
                type="number"
                min={60}
                value={windowOverride}
                onChange={e => setWindowOverride(e.target.value)}
                placeholder="Inherit"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium text-text-secondary">Enabled Override</label>
              <select
                value={enabledOverride}
                onChange={e => setEnabledOverride(e.target.value as '' | 'true' | 'false')}
                className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">Inherit from template</option>
                <option value="true">Bound (enabled)</option>
                <option value="false">Unbound (disabled)</option>
              </select>
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button type="submit" loading={saving} disabled={!selection && !isEdit} className="flex-1">
              {isEdit ? 'Save Changes' : 'Assign'}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Template row ──────────────────────────────────────────────────────────────

interface TemplateRowProps {
  template: ServiceTemplate;
  isAdmin: boolean;
  groups: GroupTreeNode[];
  agents: AgentDevice[];
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onReload: () => void;
}

function TemplateRow({ template, isAdmin, groups, agents, onEdit, onDelete, onToggle, onReload }: TemplateRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [fullTemplate, setFullTemplate] = useState<ServiceTemplate | null>(null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [addingAssignment, setAddingAssignment] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState<ServiceTemplateAssignment | null>(null);
  const [deletingAssignment, setDeletingAssignment] = useState<ServiceTemplateAssignment | null>(null);
  const [deleteAssignmentLoading, setDeleteAssignmentLoading] = useState(false);

  const loadFull = useCallback(async () => {
    setAssignmentsLoading(true);
    try {
      const data = await serviceTemplatesApi.get(template.id);
      setFullTemplate(data);
    } finally {
      setAssignmentsLoading(false);
    }
  }, [template.id]);

  function handleExpand() {
    const newExpanded = !expanded;
    setExpanded(newExpanded);
    if (newExpanded && !fullTemplate) {
      void loadFull();
    }
  }

  async function handleDeleteAssignment() {
    if (!deletingAssignment) return;
    setDeleteAssignmentLoading(true);
    try {
      await serviceTemplatesApi.deleteAssignment(
        template.id,
        deletingAssignment.scope,
        deletingAssignment.scopeId,
      );
      toast.success('Assignment removed');
      setDeletingAssignment(null);
      void loadFull();
      onReload();
    } catch {
      toast.error('Failed to remove assignment');
    } finally {
      setDeleteAssignmentLoading(false);
    }
  }

  const assignments = fullTemplate?.assignments ?? [];

  function scopeLabel(a: ServiceTemplateAssignment) {
    if (a.scope === 'agent') {
      const ag = agents.find(x => x.id === a.scopeId);
      return ag ? (ag.name ?? ag.hostname) : `Agent #${a.scopeId}`;
    }
    const gr = findInTree(groups, a.scopeId);
    return gr ? gr.name : `Group #${a.scopeId}`;
  }

  return (
    <>
      <tr className={cn('hover:bg-bg-hover transition-colors', !template.enabled && 'opacity-60')}>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button onClick={handleExpand} className="p-0.5 text-text-muted hover:text-text-primary">
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            <span className="font-medium text-text-primary text-sm">{template.name}</span>
          </div>
        </td>
        <td className="px-4 py-3">
          <ServiceTypeBadge type={template.serviceType} isBuiltin={template.isBuiltin} />
        </td>
        <td className="px-4 py-3">
          <ModeBadge mode={template.mode ?? 'ban'} />
        </td>
        <td className="px-4 py-3 text-sm text-text-secondary">
          {template.threshold} fail / {template.windowSeconds}s
        </td>
        <td className="px-4 py-3">
          <span className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
            template.enabled ? 'bg-status-up/10 text-status-up' : 'bg-text-muted/15 text-text-muted',
          )}>
            {template.enabled ? <Unlock size={9} /> : <Lock size={9} />}
            {template.enabled ? 'On' : 'Off'}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-text-muted">
          {template.customRegex ? (
            <code className="font-mono text-[10px]" title={template.customRegex}>
              {template.customRegex.length > 36 ? template.customRegex.slice(0, 36) + '…' : template.customRegex}
            </code>
          ) : (
            <span className="italic">Built-in parser</span>
          )}
        </td>
        {isAdmin && (
          <td className="px-4 py-3">
            <div className="flex items-center justify-end gap-1">
              <button onClick={handleExpand} title="View details / assignments" className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
                <Eye size={14} />
              </button>
              <button onClick={onToggle} title={template.enabled ? 'Disable' : 'Enable'} className="p-1.5 rounded text-text-muted hover:text-accent hover:bg-accent/10 transition-colors">
                {template.enabled ? <Lock size={14} /> : <Unlock size={14} />}
              </button>
              {!template.isBuiltin && (
                <>
                  <button onClick={onEdit} title="Edit" className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
                    <Pencil size={14} />
                  </button>
                  <button onClick={onDelete} title="Delete" className="p-1.5 rounded text-text-muted hover:text-status-down hover:bg-status-down/10 transition-colors">
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          </td>
        )}
      </tr>

      {/* Expanded detail + assignments */}
      {expanded && (
        <tr className="bg-bg-tertiary/50">
          <td colSpan={isAdmin ? 7 : 6} className="px-6 pb-5 pt-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs mb-4">
              {template.defaultLogPath && (
                <div>
                  <p className="text-text-muted font-medium mb-1 uppercase tracking-wide text-[10px]">Default Log Path</p>
                  <code className="font-mono text-text-secondary">{template.defaultLogPath}</code>
                </div>
              )}
              {template.customRegex && (
                <div className="md:col-span-2">
                  <p className="text-text-muted font-medium mb-1 uppercase tracking-wide text-[10px]">Regex Pattern</p>
                  <pre className="font-mono text-text-secondary bg-bg-secondary border border-border rounded p-2 overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
                    {template.customRegex}
                  </pre>
                </div>
              )}
              <div>
                <p className="text-text-muted font-medium mb-1 uppercase tracking-wide text-[10px]">Threshold</p>
                <p className="text-text-secondary">{template.threshold} failures in {template.windowSeconds}s window</p>
              </div>
              <div>
                <p className="text-text-muted font-medium mb-1 uppercase tracking-wide text-[10px]">Created</p>
                <p className="text-text-secondary">{new Date(template.createdAt).toLocaleDateString()}</p>
              </div>
            </div>

            {/* Assignments section */}
            <div className="border-t border-border pt-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
                  Assignments {!assignmentsLoading && `(${assignments.length})`}
                </p>
                {isAdmin && (
                  <button
                    onClick={() => setAddingAssignment(true)}
                    className="flex items-center gap-1 text-xs text-accent hover:underline"
                  >
                    <Plus size={11} />Assign to agent/group
                  </button>
                )}
              </div>

              {assignmentsLoading ? (
                <p className="text-xs text-text-muted">Loading…</p>
              ) : assignments.length === 0 ? (
                <p className="text-xs text-text-muted italic">No assignments — template is not active on any agent or group.</p>
              ) : (
                <div className="space-y-1.5">
                  {assignments.map(a => (
                    <div key={a.id} className="flex items-start gap-3 rounded-md border border-border bg-bg-secondary px-3 py-2 text-xs">
                      <span className={cn(
                        'mt-0.5 flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium',
                        a.scope === 'agent' ? 'bg-accent/15 text-accent' : 'bg-purple-500/15 text-purple-400',
                      )}>
                        {a.scope === 'agent' ? <Server size={9} className="inline mr-0.5" /> : <Users size={9} className="inline mr-0.5" />}
                        {a.scope}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-text-primary">{scopeLabel(a)}</span>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-text-muted">
                          {a.logPathOverride && (
                            <span className="font-mono truncate max-w-[200px]" title={anonPath(a.logPathOverride)}>
                              path: {anonPath(a.logPathOverride)}
                            </span>
                          )}
                          {a.thresholdOverride != null && <span>threshold: {a.thresholdOverride}</span>}
                          {a.windowSecondsOverride != null && <span>window: {a.windowSecondsOverride}s</span>}
                          {a.enabledOverride != null && (
                            <span className={a.enabledOverride ? 'text-status-up' : 'text-text-muted'}>
                              {a.enabledOverride ? 'enabled' : 'disabled'}
                            </span>
                          )}
                          {!a.logPathOverride && a.thresholdOverride == null && a.windowSecondsOverride == null && a.enabledOverride == null && (
                            <span className="italic">all inherited</span>
                          )}
                        </div>
                      </div>
                      {isAdmin && (
                        <div className="flex gap-1 flex-shrink-0">
                          <button
                            onClick={() => setEditingAssignment(a)}
                            title="Edit override"
                            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            onClick={() => setDeletingAssignment(a)}
                            title="Remove assignment"
                            className="p-1 rounded text-text-muted hover:text-status-down hover:bg-status-down/10 transition-colors"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}

      {/* Modals */}
      {addingAssignment && (
        <AssignmentModal
          templateId={template.id}
          groups={groups}
          agents={agents}
          onSave={() => { setAddingAssignment(false); void loadFull(); onReload(); }}
          onClose={() => setAddingAssignment(false)}
        />
      )}
      {editingAssignment && (
        <AssignmentModal
          templateId={template.id}
          existing={editingAssignment}
          groups={groups}
          agents={agents}
          onSave={() => { setEditingAssignment(null); void loadFull(); onReload(); }}
          onClose={() => setEditingAssignment(null)}
        />
      )}
      {deletingAssignment && (
        <ConfirmDialog
          title="Remove assignment"
          message={`Remove this template assignment from ${scopeLabel(deletingAssignment)}?`}
          confirmLabel="Remove"
          loading={deleteAssignmentLoading}
          onConfirm={handleDeleteAssignment}
          onCancel={() => setDeletingAssignment(null)}
        />
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ServiceTemplatesPage() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';

  const [templates, setTemplates] = useState<ServiceTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<GroupTreeNode[]>([]);
  const [agents, setAgents] = useState<AgentDevice[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ServiceTemplate | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<ServiceTemplate | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'builtin' | 'custom' | 'disabled'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await serviceTemplatesApi.list();
      setTemplates(data);
    } catch {
      toast.error('Failed to load service templates');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load group tree and agents once for assignment picker
  useEffect(() => {
    if (!isAdmin) return;
    void groupsApi.tree().then(setGroups).catch(() => {});
    void agentApi.listDevices().then(setAgents).catch(() => {});
  }, [isAdmin]);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate(data: CreateServiceTemplateRequest | UpdateServiceTemplateRequest) {
    try {
      await serviceTemplatesApi.create(data as CreateServiceTemplateRequest);
      toast.success('Template created');
      setShowCreate(false);
      void load();
    } catch {
      toast.error('Failed to create template');
    }
  }

  async function handleUpdate(data: CreateServiceTemplateRequest | UpdateServiceTemplateRequest) {
    if (!editingTemplate) return;
    try {
      await serviceTemplatesApi.update(editingTemplate.id, data as UpdateServiceTemplateRequest);
      toast.success('Template updated');
      setEditingTemplate(null);
      void load();
    } catch {
      toast.error('Failed to update template');
    }
  }

  async function handleDelete() {
    if (!deletingTemplate) return;
    setDeleteLoading(true);
    try {
      await serviceTemplatesApi.delete(deletingTemplate.id);
      toast.success('Template deleted');
      setDeletingTemplate(null);
      void load();
    } catch {
      toast.error('Failed to delete template');
    } finally {
      setDeleteLoading(false);
    }
  }

  async function handleToggle(template: ServiceTemplate) {
    try {
      await serviceTemplatesApi.update(template.id, { enabled: !template.enabled });
      toast.success(template.enabled ? 'Template disabled' : 'Template enabled');
      void load();
    } catch {
      toast.error('Failed to update template');
    }
  }

  const filtered = templates.filter(t => {
    if (filter === 'builtin') return t.isBuiltin;
    if (filter === 'custom') return !t.isBuiltin;
    if (filter === 'disabled') return !t.enabled;
    return true;
  });

  const FILTERS = [
    { key: 'all' as const, label: `All (${templates.length})` },
    { key: 'builtin' as const, label: `Built-in (${templates.filter(t => t.isBuiltin).length})` },
    { key: 'custom' as const, label: `Custom (${templates.filter(t => !t.isBuiltin).length})` },
    { key: 'disabled' as const, label: `Disabled (${templates.filter(t => !t.enabled).length})` },
  ];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Service Templates</h1>
          <p className="text-sm text-text-muted mt-0.5">Log parsing rules and thresholds for each service type</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void load()} className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          {isAdmin && (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={14} className="mr-1" />New Template
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 mb-5 rounded-lg bg-bg-secondary p-1 border border-border w-fit">
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
              filter === f.key ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        {loading ? (
          <div className="py-10 text-center text-text-muted text-sm">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 flex flex-col items-center justify-center text-center">
            <Terminal size={40} className="text-text-muted mb-3" />
            <p className="text-sm text-text-muted">No templates found.</p>
            {isAdmin && filter === 'custom' && (
              <Button className="mt-4" size="sm" onClick={() => setShowCreate(true)}>
                <Plus size={14} className="mr-1" />Create first custom template
              </Button>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Name</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Service</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Mode</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Threshold</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Status</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Regex</th>
                {isAdmin && <th className="px-4 py-2.5 text-right text-xs font-medium text-text-muted uppercase tracking-wide">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(t => (
                <TemplateRow
                  key={t.id}
                  template={t}
                  isAdmin={isAdmin}
                  groups={groups}
                  agents={agents}
                  onEdit={() => setEditingTemplate(t)}
                  onDelete={() => setDeletingTemplate(t)}
                  onToggle={() => void handleToggle(t)}
                  onReload={() => void load()}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-4 rounded-lg border border-border bg-bg-secondary px-4 py-3">
        <div className="flex items-start gap-3">
          <ScanSearch size={16} className="text-text-muted shrink-0 mt-0.5" />
          <div className="text-xs text-text-muted">
            <p className="font-medium text-text-secondary mb-0.5">How templates work</p>
            <p>
              Built-in templates use hardcoded parsers. Custom templates use named-group regex patterns.
              Expand a template to manage assignments — assign to groups or specific agents with per-agent log path, threshold, and window overrides.
              <strong className="text-text-secondary"> Ban</strong> mode triggers auto-bans;
              <strong className="text-amber-400"> Track only</strong> mode stores events for visibility without banning.
            </p>
          </div>
        </div>
      </div>

      {showCreate && <TemplateFormModal onSave={handleCreate} onClose={() => setShowCreate(false)} />}
      {editingTemplate && (
        <TemplateFormModal template={editingTemplate} onSave={handleUpdate} onClose={() => setEditingTemplate(null)} />
      )}
      {deletingTemplate && (
        <ConfirmDialog
          title="Delete template"
          message={`Are you sure you want to delete "${deletingTemplate.name}"? This will remove all assignments.`}
          confirmLabel="Delete"
          loading={deleteLoading}
          onConfirm={handleDelete}
          onCancel={() => setDeletingTemplate(null)}
        />
      )}
    </div>
  );
}
