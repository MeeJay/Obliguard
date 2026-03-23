import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  ShieldOff,
  Shield,
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Globe,
  X,
  AlertTriangle,
  EyeOff,
  Eye,
} from 'lucide-react';
import type { IpBan, BanScope, CreateBanRequest } from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';
import { anonIp } from '@/utils/anonymize';
import toast from 'react-hot-toast';

const PAGE_SIZE = 25;

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

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

// ── ScopeBadge ─────────────────────────────────────────────────────────────────

const SCOPE_CLASSES: Record<BanScope, string> = {
  global: 'bg-status-down/10 text-status-down',
  tenant: 'bg-yellow-500/10 text-yellow-400',
  group: 'bg-blue-500/10 text-blue-400',
  agent: 'bg-text-muted/15 text-text-muted',
};

function ScopeBadge({ scope }: { scope: BanScope }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize', SCOPE_CLASSES[scope])}>
      {scope}
    </span>
  );
}

// ── StatusBadge ────────────────────────────────────────────────────────────────

function BanStatusBadge({ ban }: { ban: IpBan }) {
  if (!ban.isActive) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-text-muted/15 text-text-muted">
        Lifted
      </span>
    );
  }
  if (isExpired(ban.expiresAt)) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-yellow-500/10 text-yellow-400">
        Expired
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-status-down/10 text-status-down">
      Active
    </span>
  );
}

// ── ExcludedBadge ──────────────────────────────────────────────────────────────

function ExcludedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-yellow-500/10 text-yellow-400">
      <EyeOff size={10} />Excluded
    </span>
  );
}

// ── Skeleton row ───────────────────────────────────────────────────────────────

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="animate-pulse">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 rounded bg-bg-tertiary" style={{ width: i === 0 ? '120px' : '60px' }} />
        </td>
      ))}
    </tr>
  );
}

// ── ConfirmDialog ──────────────────────────────────────────────────────────────

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

function ConfirmDialog({ title, message, confirmLabel = 'Confirm', variant = 'danger', onConfirm, onCancel, loading }: ConfirmDialogProps) {
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
          <Button variant={variant} loading={loading} onClick={onConfirm} className="flex-1">
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

// ── AddBanModal ────────────────────────────────────────────────────────────────

interface AddBanModalProps {
  onSave: (req: CreateBanRequest) => Promise<void>;
  onClose: () => void;
}

function AddBanModal({ onSave, onClose }: AddBanModalProps) {
  const [ip, setIp] = useState('');
  const [cidrPrefix, setCidrPrefix] = useState('');
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<BanScope>('global');
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!ip.trim()) {
      toast.error('IP address is required');
      return;
    }
    setSaving(true);
    try {
      const req: CreateBanRequest = {
        ip: ip.trim(),
        reason: reason.trim() || null,
        scope,
        cidrPrefix: cidrPrefix ? Number(cidrPrefix) : null,
        expiresAt: expiresAt || null,
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
          <h2 className="text-base font-semibold text-text-primary">Add ban manually</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex gap-3">
            <div className="flex-1">
              <Input
                label="IP Address"
                placeholder="192.168.1.1"
                value={ip}
                onChange={e => setIp(e.target.value)}
                autoFocus
              />
            </div>
            <div className="w-24">
              <Input
                label="CIDR prefix"
                placeholder="32"
                type="number"
                min={0}
                max={128}
                value={cidrPrefix}
                onChange={e => setCidrPrefix(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Scope</label>
            <select
              value={scope}
              onChange={e => setScope(e.target.value as BanScope)}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="global">Global</option>
              <option value="tenant">Tenant</option>
              <option value="group">Group</option>
              <option value="agent">Agent</option>
            </select>
          </div>

          <Input
            label="Reason (optional)"
            placeholder="Why is this IP being banned?"
            value={reason}
            onChange={e => setReason(e.target.value)}
          />

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">Expires at (optional)</label>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={e => setExpiresAt(e.target.value)}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <p className="text-xs text-text-muted">Leave blank for a permanent ban.</p>
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <Button variant="danger" loading={saving} onClick={handleSubmit} className="flex-1">
            <ShieldOff size={14} className="mr-1.5" />Add ban
          </Button>
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── BansPage ───────────────────────────────────────────────────────────────────

interface BanListResponse {
  data: IpBan[];
  total: number;
}

export function BansPage() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';

  const [bans, setBans] = useState<IpBan[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showExpired, setShowExpired] = useState(false);
  const [page, setPage] = useState(0);
  const [showAddModal, setShowAddModal] = useState(false);
  const [liftingBan, setLiftingBan] = useState<IpBan | null>(null);
  const [confirmLiftLoading, setConfirmLiftLoading] = useState(false);
  const [promotingBanId, setPromotingBanId] = useState<number | null>(null);
  const [excludingBanId, setExcludingBanId] = useState<number | null>(null);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset page on filter change
  useEffect(() => {
    setPage(0);
  }, [showExpired, debouncedSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page + 1),
        pageSize: String(PAGE_SIZE),
        active: showExpired ? 'false' : 'true',
      });
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());

      const res = await fetch(`/api/bans?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load bans');
      const json: BanListResponse = await res.json();
      setBans(json.data);
      setTotal(json.total);
    } catch {
      toast.error('Failed to load bans');
    } finally {
      setLoading(false);
    }
  }, [page, showExpired, debouncedSearch]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAddBan = async (req: CreateBanRequest) => {
    try {
      const res = await fetch('/api/bans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error('Failed to create ban');
      toast.success(`${req.ip} banned`);
      setShowAddModal(false);
      load();
    } catch {
      toast.error('Failed to create ban');
      throw new Error('Failed to create ban');
    }
  };

  const handleLiftBan = async () => {
    if (!liftingBan) return;
    setConfirmLiftLoading(true);
    try {
      const res = await fetch(`/api/bans/${liftingBan.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to lift ban');
      toast.success(`Ban on ${liftingBan.ip} lifted`);
      setLiftingBan(null);
      load();
    } catch {
      toast.error('Failed to lift ban');
    } finally {
      setConfirmLiftLoading(false);
    }
  };

  const handleExclude = async (ban: IpBan) => {
    setExcludingBanId(ban.id);
    try {
      const res = await fetch(`/api/bans/${ban.id}/exclude`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to exclude ban');
      toast.success(`${ban.ip} excluded from your network`);
      load();
    } catch {
      toast.error('Failed to exclude ban');
    } finally {
      setExcludingBanId(null);
    }
  };

  const handleRemoveExclusion = async (ban: IpBan) => {
    setExcludingBanId(ban.id);
    try {
      const res = await fetch(`/api/bans/${ban.id}/exclude`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove exclusion');
      toast.success(`Exclusion on ${ban.ip} removed`);
      load();
    } catch {
      toast.error('Failed to remove exclusion');
    } finally {
      setExcludingBanId(null);
    }
  };

  const handlePromoteGlobal = async (ban: IpBan) => {
    setPromotingBanId(ban.id);
    try {
      const res = await fetch(`/api/bans/${ban.id}/promote-global`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to promote ban');
      toast.success(`Ban on ${ban.ip} promoted to global`);
      load();
    } catch {
      toast.error('Failed to promote ban');
    } finally {
      setPromotingBanId(null);
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const colCount = isAdmin ? 9 : 8;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Active Bans</h1>
          <p className="text-sm text-text-muted mt-0.5">Manage IP bans across all scopes</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            <input
              type="text"
              placeholder="Search IP or reason..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-3 py-2 text-sm rounded-md border border-border bg-bg-secondary text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent w-56"
            />
          </div>
          <button
            onClick={load}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <Button onClick={() => setShowAddModal(true)}>
            <Plus size={14} className="mr-1.5" />Add ban manually
          </Button>
        </div>
      </div>

      {/* Show expired toggle */}
      <div className="flex items-center gap-2 mb-5">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <div className="relative h-4 w-4 shrink-0">
            <input
              type="checkbox"
              checked={showExpired}
              onChange={e => setShowExpired(e.target.checked)}
              className="peer appearance-none h-4 w-4 rounded border cursor-pointer transition-colors bg-bg-tertiary border-border checked:bg-accent checked:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <svg className="pointer-events-none absolute top-0 left-0 hidden h-4 w-4 text-white peer-checked:block" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 8L6 11.5L13.5 4.5" />
            </svg>
          </div>
          <span className="text-sm text-text-secondary">Show expired &amp; lifted bans</span>
        </label>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        {!loading && bans.length === 0 ? (
          <div className="py-16 text-center">
            <ShieldOff size={32} className="mx-auto mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">No bans found</p>
            {(debouncedSearch || !showExpired) && (
              <p className="text-xs text-text-muted mt-1">
                {debouncedSearch ? 'Try a different search term' : 'Enable "Show expired" to see past bans'}
              </p>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">IP</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Scope</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Reason</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Type</th>
                {isAdmin && (
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Origin</th>
                )}
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Banned at</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Expires</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Status</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-text-muted uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading
                ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={colCount} />)
                : bans.map(ban => (
                  <tr key={ban.id} className="hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Globe size={13} className="text-text-muted shrink-0" />
                        <span className="font-mono text-text-primary">
                          {anonIp(ban.ip)}{ban.cidrPrefix != null && ban.cidrPrefix !== 32 ? `/${ban.cidrPrefix}` : ''}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <ScopeBadge scope={ban.scope} />
                    </td>
                    <td className="px-4 py-3 text-text-secondary max-w-[200px]">
                      <span className="truncate block" title={ban.reason ?? undefined}>
                        {ban.reason || <span className="text-text-muted italic">No reason</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
                        ban.banType === 'auto'
                          ? 'bg-blue-500/10 text-blue-400'
                          : 'bg-text-muted/15 text-text-muted',
                      )}>
                        {ban.banType}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3 text-text-muted text-xs">
                        {ban.originTenantName ?? (ban.originTenantId ? `Tenant #${ban.originTenantId}` : '—')}
                      </td>
                    )}
                    <td className="px-4 py-3 text-text-muted text-xs">{formatDate(ban.bannedAt)}</td>
                    <td className="px-4 py-3 text-text-muted text-xs">
                      {ban.expiresAt
                        ? <span className={cn(isExpired(ban.expiresAt) ? 'text-status-down' : '')}>{formatDate(ban.expiresAt)}</span>
                        : <span className="italic">Never</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <BanStatusBadge ban={ban} />
                        {ban.isExcludedByTenant && <ExcludedBadge />}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1 flex-wrap">
                        {/* Lift ban: admin always; non-admin only for own tenant-scoped bans */}
                        {ban.isActive && !isExpired(ban.expiresAt) &&
                          (isAdmin || ban.scope === 'tenant') && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setLiftingBan(ban)}
                          >
                            <Shield size={11} className="mr-1" />Lift ban
                          </Button>
                        )}
                        {/* Promote: admin only, non-global bans */}
                        {isAdmin && ban.scope !== 'global' && ban.isActive && !isExpired(ban.expiresAt) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={promotingBanId === ban.id}
                            onClick={() => handlePromoteGlobal(ban)}
                          >
                            <Globe size={11} className="mr-1" />Promote global
                          </Button>
                        )}
                        {/* Exclude / Remove exclusion: non-admin on global bans */}
                        {!isAdmin && ban.scope === 'global' && ban.isActive && !isExpired(ban.expiresAt) && (
                          ban.isExcludedByTenant ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={excludingBanId === ban.id}
                              onClick={() => handleRemoveExclusion(ban)}
                              title="Re-enable enforcement of this ban on your network"
                            >
                              <Eye size={11} className="mr-1" />Re-enable
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={excludingBanId === ban.id}
                              onClick={() => handleExclude(ban)}
                              title="Exclude this ban from your network without lifting it globally"
                            >
                              <EyeOff size={11} className="mr-1" />Exclude
                            </Button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-text-muted">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1.5 rounded-md border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm text-text-secondary px-2">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-1.5 rounded-md border border-border text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Add ban modal */}
      {showAddModal && (
        <AddBanModal
          onSave={handleAddBan}
          onClose={() => setShowAddModal(false)}
        />
      )}

      {/* Lift ban confirmation */}
      {liftingBan && (
        <ConfirmDialog
          title="Lift ban"
          message={`Are you sure you want to lift the ban on ${liftingBan.ip}? This will allow the IP to connect again.`}
          confirmLabel="Lift ban"
          variant="primary"
          loading={confirmLiftLoading}
          onConfirm={handleLiftBan}
          onCancel={() => setLiftingBan(null)}
        />
      )}
    </div>
  );
}
