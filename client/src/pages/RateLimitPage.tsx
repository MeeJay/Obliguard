import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Gauge,
  Trash2,
  RefreshCw,
  X,
  AlertTriangle,
} from 'lucide-react';
import type {
  RateLimitPolicy,
  RateLimitScope,
  RateLimitType,
  RateLimitAction,
  CreateRateLimitPolicyRequest,
} from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { cn } from '@/utils/cn';
import { rateLimitPoliciesApi } from '@/api/rateLimitPolicies.api';
import toast from 'react-hot-toast';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const SCOPE_CLASSES: Record<RateLimitScope, string> = {
  global: 'bg-status-up/10 text-status-up',
  tenant: 'bg-yellow-500/10 text-yellow-400',
  group: 'bg-blue-500/10 text-blue-400',
  agent: 'bg-text-muted/15 text-text-muted',
};

function ScopeBadge({ scope }: { scope: RateLimitScope }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize', SCOPE_CLASSES[scope])}>
      {scope}
    </span>
  );
}

function TypeBadge({ type }: { type: RateLimitType }) {
  const isConn = type === 'connection';
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
      isConn ? 'bg-purple-500/10 text-purple-400' : 'bg-cyan-500/10 text-cyan-400',
    )}>
      {isConn ? 'Connection limit' : 'Rate limit'}
    </span>
  );
}

/** Human-readable description of a policy's threshold. */
function describeLimit(p: RateLimitPolicy): string {
  const unit = p.type === 'connection' ? 'concurrent conns' : 'conns/sec';
  const where = p.port != null ? `port ${p.port}` : 'all inbound TCP';
  return `${p.maxValue} ${unit} · ${where}`;
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
          <Button variant="danger" loading={loading} onClick={onConfirm} className="flex-1">{confirmLabel}</Button>
          <Button variant="secondary" onClick={onCancel} className="flex-1">Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── AddPolicyModal ─────────────────────────────────────────────────────────────

interface AddPolicyModalProps {
  onSave: (req: CreateRateLimitPolicyRequest) => Promise<void>;
  onClose: () => void;
}

function AddPolicyModal({ onSave, onClose }: AddPolicyModalProps) {
  const [type, setType] = useState<RateLimitType>('connection');
  const [scope, setScope] = useState<RateLimitScope>('global');
  const [scopeId, setScopeId] = useState('');
  const [port, setPort] = useState('');
  const [maxValue, setMaxValue] = useState('');
  const [action, setAction] = useState<RateLimitAction>('drop');
  const [escalate, setEscalate] = useState(false);
  const [banMultiplier, setBanMultiplier] = useState('20');
  const [banTtl, setBanTtl] = useState('');
  const [saving, setSaving] = useState(false);

  const needsScopeId = scope !== 'global' && scope !== 'tenant';

  const handleSubmit = async () => {
    const max = Number(maxValue);
    if (!maxValue.trim() || !Number.isFinite(max) || max < 1) {
      toast.error('Enter a valid limit (positive integer)');
      return;
    }
    if (needsScopeId && !scopeId.trim()) {
      toast.error('Scope ID is required for this scope');
      return;
    }
    setSaving(true);
    try {
      const req: CreateRateLimitPolicyRequest = {
        type,
        scope,
        scopeId: needsScopeId && scopeId ? Number(scopeId) : null,
        port: port.trim() ? Number(port) : null,
        maxValue: max,
        action,
        banMultiplier: escalate && banMultiplier.trim() ? Number(banMultiplier) : null,
        banTtlSeconds: escalate && banTtl.trim() ? Number(banTtl) : null,
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
          <h2 className="text-base font-semibold text-text-primary">Add rate limit policy</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          {/* Type switch */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Limit type</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setType('connection')}
                className={cn('px-3 py-2 text-sm font-medium rounded-md border transition-colors',
                  type === 'connection' ? 'bg-purple-500/10 text-purple-400 border-purple-500/30' : 'bg-bg-tertiary text-text-muted border-border hover:text-text-primary')}
              >
                Connection limit
              </button>
              <button
                type="button"
                onClick={() => setType('rate')}
                className={cn('px-3 py-2 text-sm font-medium rounded-md border transition-colors',
                  type === 'rate' ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' : 'bg-bg-tertiary text-text-muted border-border hover:text-text-primary')}
              >
                Rate limit
              </button>
            </div>
            <p className="text-xs text-text-muted">
              {type === 'connection'
                ? 'Caps concurrent connections per source IP.'
                : 'Caps new connections per second per source IP.'}
            </p>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <Input
                label={type === 'connection' ? 'Max concurrent conns / IP' : 'Max conns / sec / IP'}
                placeholder={type === 'connection' ? 'e.g. 50' : 'e.g. 10'}
                type="number"
                min={1}
                value={maxValue}
                onChange={e => setMaxValue(e.target.value)}
                autoFocus
              />
            </div>
            <div className="w-28">
              <Input
                label="Port (opt.)"
                placeholder="all"
                type="number"
                value={port}
                onChange={e => setPort(e.target.value)}
              />
            </div>
          </div>

          {/* Soft action */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Action over limit</label>
            <select
              value={action}
              onChange={e => setAction(e.target.value as RateLimitAction)}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="drop">Drop (silent)</option>
              <option value="reject">Reject (send RST)</option>
            </select>
          </div>

          {/* Escalation */}
          <div className="rounded-md border border-border bg-bg-tertiary/50 p-3 space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium text-text-secondary cursor-pointer">
              <input type="checkbox" checked={escalate} onChange={e => setEscalate(e.target.checked)} className="accent-accent" />
              Escalate to auto-ban when far over the limit
            </label>
            {escalate && (
              <div className="flex gap-3">
                <div className="flex-1">
                  <Input
                    label="Ban at × limit"
                    placeholder="20"
                    type="number"
                    min={2}
                    value={banMultiplier}
                    onChange={e => setBanMultiplier(e.target.value)}
                  />
                </div>
                <div className="flex-1">
                  <Input
                    label="Ban TTL (sec, opt.)"
                    placeholder="permanent"
                    type="number"
                    value={banTtl}
                    onChange={e => setBanTtl(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Scope */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Scope</label>
            <select
              value={scope}
              onChange={e => { setScope(e.target.value as RateLimitScope); setScopeId(''); }}
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
            <Gauge size={14} className="mr-1.5" />Add policy
          </Button>
          <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── RateLimitPage ──────────────────────────────────────────────────────────────

const SCOPE_FILTERS: { key: RateLimitScope | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'global', label: 'Global' },
  { key: 'tenant', label: 'Tenant' },
  { key: 'group', label: 'Group' },
  { key: 'agent', label: 'Agent' },
];

export function RateLimitPage() {
  const [policies, setPolicies] = useState<RateLimitPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [scopeFilter, setScopeFilter] = useState<RateLimitScope | 'all'>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [deleting, setDeleting] = useState<RateLimitPolicy | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await rateLimitPoliciesApi.list(scopeFilter);
      setPolicies(data);
    } catch {
      toast.error('Failed to load rate limit policies');
    } finally {
      setLoading(false);
    }
  }, [scopeFilter]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (req: CreateRateLimitPolicyRequest) => {
    try {
      await rateLimitPoliciesApi.create(req);
      toast.success('Rate limit policy added');
      setShowAddModal(false);
      load();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Failed to add policy');
      throw err;
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setDeleteLoading(true);
    try {
      await rateLimitPoliciesApi.delete(deleting.id);
      toast.success('Policy removed');
      setDeleting(null);
      load();
    } catch {
      toast.error('Failed to remove policy');
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Rate Limiting</h1>
          <p className="text-sm text-text-muted mt-0.5">Per-IP connection &amp; rate limits enforced in the agent firewall</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title="Refresh">
            <RefreshCw size={14} />
          </button>
          <Button onClick={() => setShowAddModal(true)}>
            <Plus size={14} className="mr-1.5" />Add policy
          </Button>
        </div>
      </div>

      {/* Scope filter */}
      <div className="flex items-center gap-1 mb-5 rounded-lg bg-bg-secondary p-1 border border-border w-fit">
        {SCOPE_FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setScopeFilter(f.key)}
            className={cn('px-4 py-1.5 text-sm font-medium rounded-md transition-colors',
              scopeFilter === f.key ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary')}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        {!loading && policies.length === 0 ? (
          <div className="py-16 text-center">
            <Gauge size={32} className="mx-auto mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">No rate limit policies yet</p>
            <Button className="mt-4" onClick={() => setShowAddModal(true)}>
              <Plus size={14} className="mr-1.5" />Add first policy
            </Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Type</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Limit</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">On exceed</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Escalation</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Scope</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Added</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-text-muted uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      {Array.from({ length: 7 }).map((__, j) => (
                        <td key={j} className="px-4 py-3"><div className="h-4 w-20 rounded bg-bg-tertiary" /></td>
                      ))}
                    </tr>
                  ))
                : policies.map(p => (
                  <tr key={p.id} className={cn('hover:bg-bg-hover transition-colors', !p.enabled && 'opacity-50')}>
                    <td className="px-4 py-3"><TypeBadge type={p.type} /></td>
                    <td className="px-4 py-3 font-mono text-text-primary text-xs">{describeLimit(p)}</td>
                    <td className="px-4 py-3 text-text-secondary capitalize">{p.action}</td>
                    <td className="px-4 py-3 text-text-muted text-xs">
                      {p.banMultiplier != null
                        ? `Ban at ×${p.banMultiplier}${p.banTtlSeconds != null ? ` (${p.banTtlSeconds}s)` : ' (permanent)'}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <ScopeBadge scope={p.scope} />
                        {p.scopeId != null && <span className="text-xs text-text-muted font-mono">#{p.scopeId}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs">{formatDate(p.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setDeleting(p)}
                        className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-status-down/10 transition-colors"
                        title="Delete policy"
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

      {showAddModal && <AddPolicyModal onSave={handleAdd} onClose={() => setShowAddModal(false)} />}

      {deleting && (
        <ConfirmDialog
          title="Delete rate limit policy"
          message="Agents will stop enforcing this limit on their next sync."
          confirmLabel="Delete"
          loading={deleteLoading}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
