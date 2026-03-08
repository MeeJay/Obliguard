import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  ShieldCheck,
  Trash2,
  RefreshCw,
  X,
  AlertTriangle,
  Globe,
} from 'lucide-react';
import type { IpWhitelist, WhitelistScope, CreateWhitelistRequest } from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { cn } from '@/utils/cn';
import toast from 'react-hot-toast';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── ScopeBadge ─────────────────────────────────────────────────────────────────

const SCOPE_CLASSES: Record<WhitelistScope, string> = {
  global: 'bg-status-up/10 text-status-up',
  tenant: 'bg-yellow-500/10 text-yellow-400',
  group: 'bg-blue-500/10 text-blue-400',
  agent: 'bg-text-muted/15 text-text-muted',
};

function ScopeBadge({ scope }: { scope: WhitelistScope }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize', SCOPE_CLASSES[scope])}>
      {scope}
    </span>
  );
}

// ── Skeleton row ───────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr className="animate-pulse">
      <td className="px-4 py-3"><div className="h-4 w-28 rounded bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-4 w-32 rounded bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-5 w-14 rounded-full bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-4 w-16 rounded bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-4 w-24 rounded bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-6 w-8 rounded bg-bg-tertiary ml-auto" /></td>
    </tr>
  );
}

// ── ConfirmDialog ──────────────────────────────────────────────────────────────

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
          <Button variant="secondary" onClick={onCancel} className="flex-1">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── AddWhitelistModal ──────────────────────────────────────────────────────────

interface AddWhitelistModalProps {
  onSave: (req: CreateWhitelistRequest) => Promise<void>;
  onClose: () => void;
}

function AddWhitelistModal({ onSave, onClose }: AddWhitelistModalProps) {
  const [ip, setIp] = useState('');
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<WhitelistScope>('global');
  const [scopeId, setScopeId] = useState('');
  const [saving, setSaving] = useState(false);

  const needsScopeId = scope !== 'global';

  const handleSubmit = async () => {
    if (!ip.trim()) {
      toast.error('IP address or CIDR range is required');
      return;
    }
    if (needsScopeId && !scopeId.trim()) {
      toast.error('Scope ID is required for this scope');
      return;
    }
    setSaving(true);
    try {
      const req: CreateWhitelistRequest = {
        ip: ip.trim(),
        label: label.trim() || null,
        scope,
        scopeId: needsScopeId && scopeId ? Number(scopeId) : null,
      };
      await onSave(req);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-bg-primary shadow-2xl p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-text-primary">Add whitelist entry</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          <Input
            label="IP / CIDR"
            placeholder="e.g. 192.168.1.0/24 or 10.0.0.1"
            value={ip}
            onChange={e => setIp(e.target.value)}
            autoFocus
          />

          <Input
            label="Label (optional)"
            placeholder="e.g. Office network, Monitoring server"
            value={label}
            onChange={e => setLabel(e.target.value)}
          />

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Scope</label>
            <select
              value={scope}
              onChange={e => { setScope(e.target.value as WhitelistScope); setScopeId(''); }}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="global">Global</option>
              <option value="tenant">Tenant</option>
              <option value="group">Group</option>
              <option value="agent">Agent</option>
            </select>
          </div>

          {needsScopeId && (
            <Input
              label={`${scope.charAt(0).toUpperCase() + scope.slice(1)} ID`}
              placeholder={`Enter the ${scope} ID`}
              type="number"
              value={scopeId}
              onChange={e => setScopeId(e.target.value)}
            />
          )}
        </div>

        <div className="flex gap-2 mt-6">
          <Button loading={saving} onClick={handleSubmit} className="flex-1">
            <ShieldCheck size={14} className="mr-1.5" />Add entry
          </Button>
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── WhitelistPage ──────────────────────────────────────────────────────────────

const SCOPE_FILTERS: { key: WhitelistScope | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'global', label: 'Global' },
  { key: 'tenant', label: 'Tenant' },
  { key: 'group', label: 'Group' },
  { key: 'agent', label: 'Agent' },
];

export function WhitelistPage() {
  const [entries, setEntries] = useState<IpWhitelist[]>([]);
  const [loading, setLoading] = useState(true);
  const [scopeFilter, setScopeFilter] = useState<WhitelistScope | 'all'>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [deletingEntry, setDeletingEntry] = useState<IpWhitelist | null>(null);
  const [confirmDeleteLoading, setConfirmDeleteLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (scopeFilter !== 'all') params.set('scope', scopeFilter);

      const res = await fetch(`/api/whitelist?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load whitelist');
      const data: IpWhitelist[] = await res.json();
      setEntries(data);
    } catch {
      toast.error('Failed to load whitelist');
    } finally {
      setLoading(false);
    }
  }, [scopeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async (req: CreateWhitelistRequest) => {
    try {
      const res = await fetch('/api/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error('Failed to add whitelist entry');
      toast.success(`${req.ip} added to whitelist`);
      setShowAddModal(false);
      load();
    } catch {
      toast.error('Failed to add whitelist entry');
      throw new Error('Failed to add whitelist entry');
    }
  };

  const handleDelete = async () => {
    if (!deletingEntry) return;
    setConfirmDeleteLoading(true);
    try {
      const res = await fetch(`/api/whitelist/${deletingEntry.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove whitelist entry');
      toast.success(`${deletingEntry.ip} removed from whitelist`);
      setDeletingEntry(null);
      load();
    } catch {
      toast.error('Failed to remove whitelist entry');
    } finally {
      setConfirmDeleteLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">IP Whitelist</h1>
          <p className="text-sm text-text-muted mt-0.5">Manage trusted IP addresses and CIDR ranges</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <Button onClick={() => setShowAddModal(true)}>
            <Plus size={14} className="mr-1.5" />Add entry
          </Button>
        </div>
      </div>

      {/* Scope filter */}
      <div className="flex items-center gap-1 mb-5 rounded-lg bg-bg-secondary p-1 border border-border w-fit">
        {SCOPE_FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setScopeFilter(f.key)}
            className={cn(
              'px-4 py-1.5 text-sm font-medium rounded-md transition-colors',
              scopeFilter === f.key
                ? 'bg-accent text-white'
                : 'text-text-muted hover:text-text-primary',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        {!loading && entries.length === 0 ? (
          <div className="py-16 text-center">
            <ShieldCheck size={32} className="mx-auto mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">No whitelist entries found</p>
            {scopeFilter !== 'all' && (
              <p className="text-xs text-text-muted mt-1">Try selecting a different scope filter</p>
            )}
            <Button
              className="mt-4"
              onClick={() => setShowAddModal(true)}
            >
              <Plus size={14} className="mr-1.5" />Add first entry
            </Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">IP / CIDR</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Label</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Scope</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Added by</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Added at</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-text-muted uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading
                ? Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)
                : entries.map(entry => (
                  <tr key={entry.id} className="hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Globe size={13} className="text-text-muted shrink-0" />
                        <span className="font-mono text-text-primary">{entry.ip}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {entry.label || <span className="text-text-muted italic">No label</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <ScopeBadge scope={entry.scope} />
                        {entry.scopeId != null && (
                          <span className="text-xs text-text-muted font-mono">#{entry.scopeId}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs">
                      {entry.createdBy != null ? `User #${entry.createdBy}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs">
                      {formatDate(entry.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setDeletingEntry(entry)}
                        className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-status-down/10 transition-colors"
                        title="Remove from whitelist"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add modal */}
      {showAddModal && (
        <AddWhitelistModal
          onSave={handleAdd}
          onClose={() => setShowAddModal(false)}
        />
      )}

      {/* Delete confirmation */}
      {deletingEntry && (
        <ConfirmDialog
          title="Remove whitelist entry"
          message={`Are you sure you want to remove ${deletingEntry.ip} from the whitelist? This IP may be blocked again if it triggers security rules.`}
          confirmLabel="Remove"
          loading={confirmDeleteLoading}
          onConfirm={handleDelete}
          onCancel={() => setDeletingEntry(null)}
        />
      )}
    </div>
  );
}
