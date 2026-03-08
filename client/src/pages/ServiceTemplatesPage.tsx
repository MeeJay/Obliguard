import { useState, useEffect, useCallback } from 'react';
import {
  ScanSearch, Plus, Pencil, Trash2, RefreshCw, X,
  AlertTriangle, ChevronDown, ChevronUp, Terminal,
  Lock, Unlock, Eye,
} from 'lucide-react';
import toast from 'react-hot-toast';
import type { ServiceTemplate, CreateServiceTemplateRequest, UpdateServiceTemplateRequest } from '@obliview/shared';
import { serviceTemplatesApi } from '@/api/serviceTemplates.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';

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
  const [enabled, setEnabled] = useState(template?.enabled ?? true);
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
          <div className="grid grid-cols-2 gap-3">
            <Input label="Failure Threshold" type="number" min={1} value={threshold} onChange={e => setThreshold(e.target.value)} placeholder="5" />
            <Input label="Window (seconds)" type="number" min={60} value={windowSeconds} onChange={e => setWindowSeconds(e.target.value)} placeholder="300" />
          </div>
          <Input label="Default Log Path (optional)" value={defaultLogPath} onChange={e => setDefaultLogPath(e.target.value)} placeholder="/var/log/app/access.log" />
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
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="accent-accent w-4 h-4" />
            <span className="text-sm text-text-secondary">Enabled</span>
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

interface TemplateRowProps {
  template: ServiceTemplate;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}

function TemplateRow({ template, isAdmin, onEdit, onDelete, onToggle }: TemplateRowProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr className={cn('hover:bg-bg-hover transition-colors', !template.enabled && 'opacity-60')}>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button onClick={() => setExpanded(v => !v)} className="p-0.5 text-text-muted hover:text-text-primary">
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            <span className="font-medium text-text-primary text-sm">{template.name}</span>
          </div>
        </td>
        <td className="px-4 py-3">
          <ServiceTypeBadge type={template.serviceType} isBuiltin={template.isBuiltin} />
        </td>
        <td className="px-4 py-3 text-sm text-text-secondary">
          {template.threshold} failures / {template.windowSeconds}s
        </td>
        <td className="px-4 py-3">
          <span className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
            template.enabled ? 'bg-status-up/10 text-status-up' : 'bg-text-muted/15 text-text-muted',
          )}>
            {template.enabled ? <Unlock size={9} /> : <Lock size={9} />}
            {template.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-text-muted">
          {template.customRegex ? (
            <code className="font-mono text-[10px]" title={template.customRegex}>
              {template.customRegex.length > 40 ? template.customRegex.slice(0, 40) + '…' : template.customRegex}
            </code>
          ) : (
            <span className="italic">Built-in parser</span>
          )}
        </td>
        {isAdmin && (
          <td className="px-4 py-3">
            <div className="flex items-center justify-end gap-1">
              <button onClick={() => setExpanded(v => !v)} title="View details" className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
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
      {expanded && (
        <tr className="bg-bg-tertiary/50">
          <td colSpan={isAdmin ? 6 : 5} className="px-6 pb-4 pt-2">
            <div className="grid grid-cols-2 gap-4 text-xs">
              {template.defaultLogPath && (
                <div>
                  <p className="text-text-muted font-medium mb-1 uppercase tracking-wide text-[10px]">Default Log Path</p>
                  <code className="font-mono text-text-secondary">{template.defaultLogPath}</code>
                </div>
              )}
              {template.customRegex && (
                <div className="col-span-2">
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
          </td>
        </tr>
      )}
    </>
  );
}

export function ServiceTemplatesPage() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';

  const [templates, setTemplates] = useState<ServiceTemplate[]>([]);
  const [loading, setLoading] = useState(true);
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
                  onEdit={() => setEditingTemplate(t)}
                  onDelete={() => setDeletingTemplate(t)}
                  onToggle={() => void handleToggle(t)}
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
            <p>Built-in templates use hardcoded parsers. Custom templates use named-group regex patterns. Templates can be assigned to groups or individual agents to override thresholds and log paths.</p>
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
