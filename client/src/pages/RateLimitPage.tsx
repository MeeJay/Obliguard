import { useState, useEffect, useCallback } from 'react';
import { Plus, Gauge, Trash2, RefreshCw, X, AlertTriangle, Activity, Network } from 'lucide-react';
import type {
  RateLimitPolicy,
  RateLimitScope,
  RateLimitType,
  RateLimitAction,
  CreateRateLimitPolicyRequest,
  GroupTreeNode,
  AgentDevice,
} from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { TargetTreePicker } from '@/components/common/TargetTreePicker';
import { cn } from '@/utils/cn';
import { rateLimitPoliciesApi } from '@/api/rateLimitPolicies.api';
import { groupsApi } from '@/api/groups.api';
import { agentApi } from '@/api/agent.api';
import toast from 'react-hot-toast';

// ── Shared types ─────────────────────────────────────────────────────────────

/** A policy's config minus its target (scope/scopeId), supplied separately. */
type PolicyConfig = Omit<CreateRateLimitPolicyRequest, 'scope' | 'scopeId'>;
/** A single target a policy can be applied to. */
type Target =
  | { scope: 'global' | 'tenant' }
  | { scope: 'group' | 'agent'; scopeId: number };

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

const TYPE_META: Record<RateLimitType, { label: string; cls: string }> = {
  connection: { label: 'Connection limit', cls: 'bg-purple-500/10 text-purple-400' },
  rate:       { label: 'Rate limit',       cls: 'bg-cyan-500/10 text-cyan-400' },
  volume:     { label: 'Bandwidth limit',  cls: 'bg-emerald-500/10 text-emerald-400' },
};

function TypeBadge({ type }: { type: RateLimitType }) {
  const m = TYPE_META[type];
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', m.cls)}>{m.label}</span>;
}

function unitFor(type: RateLimitType): string {
  if (type === 'connection') return 'concurrent conns';
  if (type === 'rate') return 'conns/sec';
  return 'mbit/s';
}

function describeLimit(p: RateLimitPolicy): string {
  const where = p.port != null ? `port ${p.port}` : 'all inbound TCP';
  return `${p.maxValue} ${unitFor(p.type)} · ${where}`;
}

// ── Switch ─────────────────────────────────────────────────────────────────────

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-sm font-medium text-text-secondary"
    >
      <span className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-accent' : 'bg-bg-tertiary border border-border',
      )}>
        <span className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )} />
      </span>
      {label}
    </button>
  );
}

// ── ConfirmDialog ──────────────────────────────────────────────────────────────

function ConfirmDialog({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel, loading }: {
  title: string; message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void; loading?: boolean;
}) {
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
  onSave: (config: PolicyConfig, targets: Target[]) => Promise<void>;
  onClose: () => void;
  /** When set, the target is fixed (embedded in a group/agent view) and the picker is hidden. */
  lockedTarget?: Target;
  lockedLabel?: string;
}

function AddPolicyModal({ onSave, onClose, lockedTarget, lockedLabel }: AddPolicyModalProps) {
  const [type, setType] = useState<RateLimitType>('connection');
  const [port, setPort] = useState('');
  const [maxValue, setMaxValue] = useState('');
  const [action, setAction] = useState<RateLimitAction>('drop');
  const [escalate, setEscalate] = useState(false);
  const [banMultiplier, setBanMultiplier] = useState('20');
  const [banTtl, setBanTtl] = useState('');
  const [saving, setSaving] = useState(false);

  // Target selection (only when not locked)
  const [scopeMode, setScopeMode] = useState<'global' | 'tenant' | 'specific'>('global');
  const [groupTree, setGroupTree] = useState<GroupTreeNode[]>([]);
  const [devices, setDevices] = useState<AgentDevice[]>([]);
  const [selGroups, setSelGroups] = useState<Set<number>>(new Set());
  const [selAgents, setSelAgents] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (lockedTarget || scopeMode !== 'specific') return;
    if (groupTree.length === 0) groupsApi.tree().then(setGroupTree).catch(() => {});
    if (devices.length === 0) agentApi.listDevices('approved').then(setDevices).catch(() => {});
  }, [lockedTarget, scopeMode, groupTree.length, devices.length]);

  const isVolume = type === 'volume';

  // Keep the action valid for the selected type:
  //   volume → 'drop' | 'shape' ; connection/rate → 'drop' | 'reject'
  useEffect(() => {
    if (isVolume && action === 'reject') setAction('drop');
    if (!isVolume && action === 'shape') setAction('drop');
  }, [isVolume, action]);

  const handleSubmit = async () => {
    const max = Number(maxValue);
    if (!maxValue.trim() || !Number.isFinite(max) || max < 1) {
      toast.error('Enter a valid limit (positive integer)');
      return;
    }

    let targets: Target[];
    if (lockedTarget) {
      targets = [lockedTarget];
    } else if (scopeMode === 'global') {
      targets = [{ scope: 'global' }];
    } else if (scopeMode === 'tenant') {
      targets = [{ scope: 'tenant' }];
    } else {
      targets = [
        ...[...selGroups].map(id => ({ scope: 'group' as const, scopeId: id })),
        ...[...selAgents].map(id => ({ scope: 'agent' as const, scopeId: id })),
      ];
      if (targets.length === 0) { toast.error('Select at least one group or agent'); return; }
    }

    const config: PolicyConfig = {
      type,
      port: port.trim() ? Number(port) : null,
      maxValue: max,
      action,
      banMultiplier: escalate && banMultiplier.trim() ? Number(banMultiplier) : null,
      banTtlSeconds: escalate && banTtl.trim() ? Number(banTtl) : null,
    };

    setSaving(true);
    try {
      await onSave(config, targets);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-bg-primary shadow-2xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-text-primary">Add network limit</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          {/* Type */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Limit type</label>
            <div className="grid grid-cols-3 gap-2">
              {(['connection', 'rate', 'volume'] as RateLimitType[]).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={cn('px-2 py-2 text-xs font-medium rounded-md border transition-colors',
                    type === t ? TYPE_META[t].cls + ' border-current' : 'bg-bg-tertiary text-text-muted border-border hover:text-text-primary')}
                >
                  {TYPE_META[t].label}
                </button>
              ))}
            </div>
            <p className="text-xs text-text-muted">
              {type === 'connection' && 'Caps concurrent connections per source IP.'}
              {type === 'rate' && 'Caps new connections per second per source IP.'}
              {type === 'volume' && 'Caps bandwidth (mbit/s) per source IP — traffic shaping (Linux tc / macOS dummynet).'}
            </p>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <Input
                label={`Max ${unitFor(type)} / IP`}
                placeholder={isVolume ? 'e.g. 100' : type === 'connection' ? 'e.g. 50' : 'e.g. 10'}
                type="number"
                min={1}
                value={maxValue}
                onChange={e => setMaxValue(e.target.value)}
                autoFocus
              />
            </div>
            <div className="w-28">
              <Input label="Port (opt.)" placeholder="all" type="number" value={port} onChange={e => setPort(e.target.value)} />
            </div>
          </div>

          {/* Action over limit */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Enforcement</label>
            <select
              value={action}
              onChange={e => setAction(e.target.value as RateLimitAction)}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {isVolume ? (
                <>
                  <option value="drop">Drop over limit (all platforms · Windows)</option>
                  <option value="shape">Traffic shaping (Linux / macOS)</option>
                </>
              ) : (
                <>
                  <option value="drop">Drop (silent)</option>
                  <option value="reject">Reject (send RST)</option>
                </>
              )}
            </select>
            {isVolume && action === 'shape' && (
              <p className="text-xs text-text-muted">True throttling. Not available on Windows — use "Drop over limit" there.</p>
            )}
            {isVolume && action === 'drop' && (
              <p className="text-xs text-text-muted">Drops connections exceeding the bandwidth cap. Works everywhere, incl. Windows.</p>
            )}
          </div>

          {/* Escalation */}
          <div className="rounded-md border border-border bg-bg-tertiary/50 p-3 space-y-3">
            <Switch checked={escalate} onChange={setEscalate} label="Escalate to auto-ban when far over the limit" />
            {escalate && (
              <div className="flex gap-3">
                <div className="flex-1">
                  <Input label="Ban at × limit" placeholder="20" type="number" min={2} value={banMultiplier} onChange={e => setBanMultiplier(e.target.value)} />
                </div>
                <div className="flex-1">
                  <Input label="Ban TTL (sec, opt.)" placeholder="permanent" type="number" value={banTtl} onChange={e => setBanTtl(e.target.value)} />
                </div>
              </div>
            )}
          </div>

          {/* Target */}
          {lockedTarget ? (
            <div className="space-y-1">
              <label className="block text-sm font-medium text-text-secondary">Applies to</label>
              <div className="rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary">{lockedLabel}</div>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-secondary">Apply to</label>
              <div className="flex items-center gap-1 rounded-lg bg-bg-secondary p-1 border border-border w-fit">
                {(['global', 'tenant', 'specific'] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setScopeMode(m)}
                    className={cn('px-3 py-1 text-xs font-medium rounded-md capitalize transition-colors',
                      scopeMode === m ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary')}
                  >
                    {m === 'specific' ? 'Groups / Agents' : m}
                  </button>
                ))}
              </div>
              {scopeMode === 'specific' && (
                <TargetTreePicker
                  tree={groupTree}
                  devices={devices}
                  selGroups={selGroups}
                  selAgents={selAgents}
                  onChange={(g, a) => { setSelGroups(g); setSelAgents(a); }}
                />
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-6">
          <Button loading={saving} onClick={handleSubmit} className="flex-1">
            <Gauge size={14} className="mr-1.5" />Add limit
          </Button>
          <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── NetworkLimitsPanel (embeddable, locked to one target) ───────────────────────

export function NetworkLimitsPanel({ scope, scopeId, label, title }: {
  scope: 'group' | 'agent';
  scopeId: number;
  label: string;
  title?: string;
}) {
  const [policies, setPolicies] = useState<RateLimitPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [deleting, setDeleting] = useState<RateLimitPolicy | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPolicies(await rateLimitPoliciesApi.list(scope, scopeId));
    } catch {
      toast.error('Failed to load network limits');
    } finally {
      setLoading(false);
    }
  }, [scope, scopeId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (config: PolicyConfig, targets: Target[]) => {
    try {
      await Promise.all(targets.map(t =>
        rateLimitPoliciesApi.create({ ...config, scope: t.scope, scopeId: 'scopeId' in t ? t.scopeId : null })));
      toast.success('Network limit added');
      setShowAdd(false);
      load();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Failed to add limit');
      throw err;
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setDeleteLoading(true);
    try {
      await rateLimitPoliciesApi.delete(deleting.id);
      toast.success('Limit removed');
      setDeleting(null);
      load();
    } catch {
      toast.error('Failed to remove limit');
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
          <Network size={14} className="text-text-muted" />{title ?? 'Network limits'}
        </h3>
        <Button size="sm" onClick={() => setShowAdd(true)}><Plus size={12} className="mr-1" />Add</Button>
      </div>

      {loading ? (
        <p className="text-xs text-text-muted">Loading…</p>
      ) : policies.length === 0 ? (
        <p className="text-xs text-text-muted">No limits set for this {scope}.</p>
      ) : (
        <div className="space-y-2">
          {policies.map(p => (
            <div key={p.id} className="flex items-center gap-2 rounded-md border border-border bg-bg-tertiary/40 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5"><TypeBadge type={p.type} /></div>
                <div className="font-mono text-[11px] text-text-secondary mt-1 truncate">{describeLimit(p)}</div>
                {p.banMultiplier != null && (
                  <div className="text-[10px] text-text-muted mt-0.5">ban at ×{p.banMultiplier}</div>
                )}
              </div>
              <button
                onClick={() => setDeleting(p)}
                className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-status-down/10 transition-colors shrink-0"
                title="Delete limit"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <AddPolicyModal onSave={handleSave} onClose={() => setShowAdd(false)} lockedTarget={{ scope, scopeId }} lockedLabel={label} />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete network limit"
          message="The agent will stop enforcing this limit on its next sync."
          confirmLabel="Delete"
          loading={deleteLoading}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

// ── RateLimitPage (full page) ────────────────────────────────────────────────

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

  // Name resolution for the target column
  const [groupNames, setGroupNames] = useState<Map<number, string>>(new Map());
  const [agentNames, setAgentNames] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    groupsApi.tree().then(tree => {
      const m = new Map<number, string>();
      const walk = (nodes: GroupTreeNode[]) => nodes.forEach(n => { m.set(n.id, n.name); walk(n.children); });
      walk(tree);
      setGroupNames(m);
    }).catch(() => {});
    agentApi.listDevices('approved').then(ds => {
      setAgentNames(new Map(ds.map(d => [d.id, d.name || d.hostname])));
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPolicies(await rateLimitPoliciesApi.list(scopeFilter));
    } catch {
      toast.error('Failed to load network limits');
    } finally {
      setLoading(false);
    }
  }, [scopeFilter]);

  useEffect(() => { load(); }, [load]);

  const targetLabel = (p: RateLimitPolicy): string => {
    if (p.scope === 'group' && p.scopeId != null) return groupNames.get(p.scopeId) ?? `Group #${p.scopeId}`;
    if (p.scope === 'agent' && p.scopeId != null) return agentNames.get(p.scopeId) ?? `Agent #${p.scopeId}`;
    return '';
  };

  const handleSave = async (config: PolicyConfig, targets: Target[]) => {
    try {
      await Promise.all(targets.map(t =>
        rateLimitPoliciesApi.create({ ...config, scope: t.scope, scopeId: 'scopeId' in t ? t.scopeId : null })));
      toast.success(targets.length > 1 ? `Limit applied to ${targets.length} targets` : 'Network limit added');
      setShowAddModal(false);
      load();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Failed to add limit');
      throw err;
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setDeleteLoading(true);
    try {
      await rateLimitPoliciesApi.delete(deleting.id);
      toast.success('Limit removed');
      setDeleting(null);
      load();
    } catch {
      toast.error('Failed to remove limit');
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Network Limiting</h1>
          <p className="text-sm text-text-muted mt-0.5">Per-IP connection, rate &amp; bandwidth limits enforced on agents</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title="Refresh">
            <RefreshCw size={14} />
          </button>
          <Button onClick={() => setShowAddModal(true)}><Plus size={14} className="mr-1.5" />Add limit</Button>
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
            <Activity size={32} className="mx-auto mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">No network limits yet</p>
            <Button className="mt-4" onClick={() => setShowAddModal(true)}><Plus size={14} className="mr-1.5" />Add first limit</Button>
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
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Target</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Added</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-text-muted uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      {Array.from({ length: 8 }).map((__, j) => (
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
                    <td className="px-4 py-3"><ScopeBadge scope={p.scope} /></td>
                    <td className="px-4 py-3 text-text-secondary text-xs truncate max-w-[180px]">{targetLabel(p) || '—'}</td>
                    <td className="px-4 py-3 text-text-muted text-xs">{formatDate(p.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setDeleting(p)}
                        className="p-1.5 rounded-md text-text-muted hover:text-status-down hover:bg-status-down/10 transition-colors"
                        title="Delete limit"
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

      {showAddModal && <AddPolicyModal onSave={handleSave} onClose={() => setShowAddModal(false)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete network limit"
          message="The agent will stop enforcing this limit on its next sync."
          confirmLabel="Delete"
          loading={deleteLoading}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
