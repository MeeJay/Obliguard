import { useState, useEffect, useCallback } from 'react';
import {
  Search,
  Shield,
  ShieldOff,
  ShieldCheck,
  Globe,
  X,
  Copy,
  Check,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Clock,
  User,
  Server,
} from 'lucide-react';
import type {
  IpReputation,
  IpEvent,
  IpStatus,
  BanScope,
} from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { cn } from '@/utils/cn';
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

function formatDateShort(dateStr: string | null | undefined) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function countryCodeToFlag(code: string | null): string {
  if (!code || code.length !== 2) return '';
  const offset = 127397;
  return Array.from(code.toUpperCase())
    .map(c => String.fromCodePoint(c.codePointAt(0)! + offset))
    .join('');
}

// ── CopyButton ─────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
      title="Copy"
    >
      {copied ? <Check size={14} className="text-status-up" /> : <Copy size={14} />}
    </button>
  );
}

// ── StatusBadge ────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | IpStatus;

const STATUS_LABELS: Record<IpStatus, string> = {
  banned: 'Banned',
  suspicious: 'Suspicious',
  whitelisted: 'Whitelisted',
  clean: 'Clean',
};

const STATUS_CLASSES: Record<IpStatus, string> = {
  banned: 'bg-status-down/10 text-status-down',
  suspicious: 'bg-yellow-500/10 text-yellow-400',
  whitelisted: 'bg-status-up/10 text-status-up',
  clean: 'bg-text-muted/15 text-text-muted',
};

function StatusBadge({ status }: { status: IpStatus | undefined }) {
  if (!status) return null;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', STATUS_CLASSES[status])}>
      {STATUS_LABELS[status]}
    </span>
  );
}

// ── Skeleton row ───────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr className="animate-pulse">
      <td className="px-4 py-3"><div className="h-4 w-28 rounded bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-4 w-20 rounded bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-4 w-10 rounded bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-4 w-24 rounded bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-4 w-8 rounded bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-4 w-20 rounded bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-5 w-16 rounded-full bg-bg-tertiary" /></td>
      <td className="px-4 py-3"><div className="h-6 w-16 rounded bg-bg-tertiary ml-auto" /></td>
    </tr>
  );
}

// ── IPDetailDrawer ─────────────────────────────────────────────────────────────

interface IPDetailDrawerProps {
  ip: IpReputation;
  onClose: () => void;
  onBan: (ip: string, scope: BanScope, reason: string) => Promise<void>;
  onWhitelist: (ip: string, label: string) => Promise<void>;
  onLiftBan: () => Promise<void>;
}

function IPDetailDrawer({ ip, onClose, onBan, onWhitelist, onLiftBan }: IPDetailDrawerProps) {
  const [events, setEvents] = useState<IpEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [banScope, setBanScope] = useState<BanScope>('global');
  const [banReason, setBanReason] = useState('');
  const [whitelistLabel, setWhitelistLabel] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [showBanForm, setShowBanForm] = useState(false);
  const [showWhitelistForm, setShowWhitelistForm] = useState(false);

  const loadEvents = useCallback(async () => {
    setLoadingEvents(true);
    try {
      const res = await fetch(`/api/ip-events/${encodeURIComponent(ip.ip)}?limit=20`);
      if (!res.ok) throw new Error('Failed to load events');
      const data: IpEvent[] = await res.json();
      setEvents(data);
    } catch {
      toast.error('Failed to load IP events');
    } finally {
      setLoadingEvents(false);
    }
  }, [ip.ip]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const handleBan = async () => {
    if (!banReason.trim()) {
      toast.error('Please enter a reason for the ban');
      return;
    }
    setActionLoading(true);
    try {
      await onBan(ip.ip, banScope, banReason.trim());
      setShowBanForm(false);
      setBanReason('');
    } finally {
      setActionLoading(false);
    }
  };

  const handleWhitelist = async () => {
    setActionLoading(true);
    try {
      await onWhitelist(ip.ip, whitelistLabel.trim());
      setShowWhitelistForm(false);
      setWhitelistLabel('');
    } finally {
      setActionLoading(false);
    }
  };

  const flag = countryCodeToFlag(ip.geoCountryCode);
  const services = ip.affectedServices ?? [];
  const usernames = ip.attemptedUsernames ?? [];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Drawer */}
      <div className="fixed inset-y-0 right-0 z-50 flex flex-col w-full max-w-2xl bg-bg-primary border-l border-border shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border shrink-0">
          <Globe size={18} className="text-text-muted" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg font-mono font-semibold text-text-primary">{ip.ip}</span>
              <CopyButton text={ip.ip} />
              <StatusBadge status={ip.status} />
            </div>
            {(ip.geoCountryCode || ip.geoCity || ip.asn) && (
              <p className="text-xs text-text-muted mt-0.5">
                {flag && <span className="mr-1">{flag}</span>}
                {[ip.geoCity, ip.geoCountryCode].filter(Boolean).join(', ')}
                {ip.asn && <span className="ml-2 font-mono">· {ip.asn}</span>}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3 p-6 border-b border-border">
            {([
              { label: 'Total failures', value: ip.totalFailures },
              { label: 'Total successes', value: ip.totalSuccesses },
              { label: 'First seen', value: formatDate(ip.firstSeen) },
              { label: 'Last seen', value: formatDate(ip.lastSeen) },
            ] as { label: string; value: string | number }[]).map(({ label, value }) => (
              <div key={label} className="rounded-lg bg-bg-secondary border border-border p-3">
                <p className="text-xs text-text-muted mb-1">{label}</p>
                <p className="text-sm font-semibold text-text-primary">{value}</p>
              </div>
            ))}
          </div>

          {/* Services targeted */}
          {services.length > 0 && (
            <div className="px-6 py-4 border-b border-border">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Services targeted</p>
              <div className="flex flex-wrap gap-1.5">
                {services.map(svc => (
                  <span key={svc} className="rounded-md bg-bg-secondary border border-border px-2 py-0.5 text-xs text-text-secondary">
                    {svc}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Affected agents count */}
          {ip.affectedAgentsCount > 0 && (
            <div className="px-6 py-4 border-b border-border">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Affected agents</p>
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <Server size={14} className="text-text-muted" />
                <span>{ip.affectedAgentsCount} agent{ip.affectedAgentsCount !== 1 ? 's' : ''} reported this IP</span>
              </div>
            </div>
          )}

          {/* Usernames attempted */}
          {usernames.length > 0 && (
            <div className="px-6 py-4 border-b border-border">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Usernames attempted</p>
              <ul className="space-y-1">
                {usernames.slice(0, 10).map(u => (
                  <li key={u} className="flex items-center gap-2 text-sm text-text-secondary">
                    <User size={12} className="text-text-muted shrink-0" />
                    <span className="font-mono">{u}</span>
                  </li>
                ))}
                {usernames.length > 10 && (
                  <li className="text-xs text-text-muted">+ {usernames.length - 10} more</li>
                )}
              </ul>
            </div>
          )}

          {/* Recent events */}
          <div className="px-6 py-4 border-b border-border">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-3">Recent events</p>
            {loadingEvents ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-10 rounded bg-bg-secondary animate-pulse" />
                ))}
              </div>
            ) : events.length === 0 ? (
              <p className="text-sm text-text-muted">No events found.</p>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-bg-tertiary border-b border-border">
                      <th className="px-3 py-2 text-left font-medium text-text-muted">Time</th>
                      <th className="px-3 py-2 text-left font-medium text-text-muted">Service</th>
                      <th className="px-3 py-2 text-left font-medium text-text-muted">Username</th>
                      <th className="px-3 py-2 text-left font-medium text-text-muted">Agent</th>
                      <th className="px-3 py-2 text-left font-medium text-text-muted">Log</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {events.map(ev => (
                      <tr key={ev.id} className="hover:bg-bg-hover transition-colors">
                        <td className="px-3 py-2 text-text-muted whitespace-nowrap">
                          <Clock size={10} className="inline mr-1" />
                          {formatDateShort(ev.timestamp)}
                        </td>
                        <td className="px-3 py-2 text-text-secondary">{ev.service ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-text-secondary">{ev.username ?? '—'}</td>
                        <td className="px-3 py-2 text-text-muted">{ev.deviceHostname ?? '—'}</td>
                        <td className="px-3 py-2 text-text-muted max-w-[180px]">
                          <span className="truncate block" title={ev.rawLog ?? undefined}>
                            {ev.rawLog ? ev.rawLog.slice(0, 60) + (ev.rawLog.length > 60 ? '…' : '') : '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="px-6 py-4 space-y-3">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide">Actions</p>

            {/* Ban form */}
            {ip.status !== 'banned' && (
              <div>
                {!showBanForm ? (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => { setShowBanForm(true); setShowWhitelistForm(false); }}
                  >
                    <ShieldOff size={13} className="mr-1.5" />Ban IP
                  </Button>
                ) : (
                  <div className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
                    <p className="text-sm font-medium text-text-primary">Ban {ip.ip}</p>
                    <div className="space-y-1">
                      <label className="block text-sm font-medium text-text-secondary">Scope</label>
                      <select
                        value={banScope}
                        onChange={e => setBanScope(e.target.value as BanScope)}
                        className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                      >
                        <option value="global">Global</option>
                        <option value="tenant">Tenant</option>
                        <option value="group">Group</option>
                        <option value="agent">Agent</option>
                      </select>
                    </div>
                    <Input
                      label="Reason"
                      placeholder="Why is this IP being banned?"
                      value={banReason}
                      onChange={e => setBanReason(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button variant="danger" size="sm" loading={actionLoading} onClick={handleBan}>
                        Confirm ban
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setShowBanForm(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Whitelist form */}
            {ip.status !== 'whitelisted' && (
              <div>
                {!showWhitelistForm ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => { setShowWhitelistForm(true); setShowBanForm(false); }}
                  >
                    <ShieldCheck size={13} className="mr-1.5" />Whitelist IP
                  </Button>
                ) : (
                  <div className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
                    <p className="text-sm font-medium text-text-primary">Whitelist {ip.ip}</p>
                    <Input
                      label="Label (optional)"
                      placeholder="e.g. Office IP"
                      value={whitelistLabel}
                      onChange={e => setWhitelistLabel(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" loading={actionLoading} onClick={handleWhitelist}>
                        Confirm whitelist
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setShowWhitelistForm(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Lift ban */}
            {ip.status === 'banned' && (
              <Button
                variant="secondary"
                size="sm"
                loading={actionLoading}
                onClick={async () => {
                  setActionLoading(true);
                  try {
                    await onLiftBan();
                  } finally {
                    setActionLoading(false);
                  }
                }}
              >
                <Shield size={13} className="mr-1.5" />Lift ban
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ── IPReputationPage ───────────────────────────────────────────────────────────

interface IpReputationListResponse {
  data: IpReputation[];
  total: number;
}

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'banned', label: 'Banned' },
  { key: 'suspicious', label: 'Suspicious' },
  { key: 'whitelisted', label: 'Whitelisted' },
  { key: 'clean', label: 'Clean' },
];

export function IPReputationPage() {
  const [rows, setRows] = useState<IpReputation[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(0);
  const [selectedIp, setSelectedIp] = useState<IpReputation | null>(null);
  // Track the active ban ID for the selected IP so the drawer can lift it
  const [selectedBanId, setSelectedBanId] = useState<number | null>(null);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset page on filter/search change
  useEffect(() => {
    setPage(0);
  }, [statusFilter, debouncedSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());

      const res = await fetch(`/api/ip-reputation?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load IP reputation data');
      const json: IpReputationListResponse = await res.json();
      setRows(json.data);
      setTotal(json.total);
    } catch {
      toast.error('Failed to load IP reputation data');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, debouncedSearch, page]);

  useEffect(() => {
    load();
  }, [load]);

  const handleBan = async (ipAddr: string, scope: BanScope, reason: string) => {
    try {
      const res = await fetch('/api/bans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: ipAddr, reason, scope }),
      });
      if (!res.ok) throw new Error('Failed to ban IP');
      const created: { id?: number; data?: { id: number } } = await res.json();
      const banId = created.id ?? created.data?.id ?? null;
      toast.success(`${ipAddr} banned`);
      setRows(prev => prev.map(r => r.ip === ipAddr ? { ...r, status: 'banned' } : r));
      if (selectedIp?.ip === ipAddr) {
        setSelectedIp(prev => prev ? { ...prev, status: 'banned' } : prev);
        if (banId != null) setSelectedBanId(banId);
      }
    } catch {
      toast.error('Failed to ban IP');
      throw new Error('Failed to ban IP');
    }
  };

  const handleWhitelist = async (ipAddr: string, label: string) => {
    try {
      const res = await fetch('/api/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: ipAddr, label: label || null }),
      });
      if (!res.ok) throw new Error('Failed to whitelist IP');
      toast.success(`${ipAddr} whitelisted`);
      setRows(prev => prev.map(r => r.ip === ipAddr ? { ...r, status: 'whitelisted' } : r));
      if (selectedIp?.ip === ipAddr) {
        setSelectedIp(prev => prev ? { ...prev, status: 'whitelisted' } : prev);
      }
    } catch {
      toast.error('Failed to whitelist IP');
      throw new Error('Failed to whitelist IP');
    }
  };

  const handleLiftBanById = async (banId: number, ipAddr?: string) => {
    try {
      const res = await fetch(`/api/bans/${banId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to lift ban');
      toast.success('Ban lifted');
      setRows(prev => prev.map(r => (!ipAddr || r.ip === ipAddr) ? { ...r, status: 'clean' } : r));
      if (selectedIp && (!ipAddr || selectedIp.ip === ipAddr)) {
        setSelectedIp(prev => prev ? { ...prev, status: 'clean' } : prev);
        setSelectedBanId(null);
      }
    } catch {
      toast.error('Failed to lift ban');
      throw new Error('Failed to lift ban');
    }
  };

  const handleQuickBan = async (row: IpReputation) => {
    const reason = window.prompt(`Ban reason for ${row.ip}:`);
    if (!reason) return;
    await handleBan(row.ip, 'global', reason);
  };

  const handleRowClick = (row: IpReputation) => {
    setSelectedIp(row);
    setSelectedBanId(null);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">IP Reputation</h1>
          <p className="text-sm text-text-muted mt-0.5">Monitor and manage IP reputation across all agents</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            <input
              type="text"
              placeholder="Search IP or country..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-3 py-2 text-sm rounded-md border border-border bg-bg-secondary text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent w-64"
            />
          </div>
          <button
            onClick={load}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 mb-5 rounded-lg bg-bg-secondary p-1 border border-border w-fit">
        {STATUS_FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setStatusFilter(f.key)}
            className={cn(
              'px-4 py-1.5 text-sm font-medium rounded-md transition-colors',
              statusFilter === f.key
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
        {!loading && rows.length === 0 ? (
          <div className="py-16 text-center">
            <Globe size={32} className="mx-auto mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">No IP reputation data found</p>
            {(debouncedSearch || statusFilter !== 'all') && (
              <p className="text-xs text-text-muted mt-1">Try adjusting your filters</p>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">IP Address</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Country</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Failures</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Services</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Agents</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Last seen</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Status</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-text-muted uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading
                ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
                : rows.map(row => {
                  const flag = countryCodeToFlag(row.geoCountryCode);
                  return (
                    <tr
                      key={row.ip}
                      onClick={() => handleRowClick(row)}
                      className="hover:bg-bg-hover transition-colors cursor-pointer"
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono text-text-primary">{row.ip}</span>
                      </td>
                      <td className="px-4 py-3 text-text-secondary">
                        {flag && <span className="mr-1.5">{flag}</span>}
                        {[row.geoCity, row.geoCountryCode].filter(Boolean).join(', ') || '—'}
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{row.totalFailures}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {(row.affectedServices ?? []).slice(0, 3).map(svc => (
                            <span key={svc} className="rounded bg-bg-tertiary border border-border px-1.5 py-0.5 text-[10px] text-text-secondary">
                              {svc}
                            </span>
                          ))}
                          {(row.affectedServices ?? []).length > 3 && (
                            <span className="text-[10px] text-text-muted">+{(row.affectedServices ?? []).length - 3}</span>
                          )}
                          {(row.affectedServices ?? []).length === 0 && (
                            <span className="text-text-muted">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-text-muted text-xs">
                        {row.affectedAgentsCount > 0 ? row.affectedAgentsCount : '—'}
                      </td>
                      <td className="px-4 py-3 text-text-muted text-xs">{formatDateShort(row.lastSeen)}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div
                          className="flex items-center justify-end gap-1"
                          onClick={e => e.stopPropagation()}
                        >
                          {row.status !== 'banned' && (
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => handleQuickBan(row)}
                            >
                              <ShieldOff size={11} className="mr-1" />Ban
                            </Button>
                          )}
                          {row.status !== 'whitelisted' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => handleWhitelist(row.ip, '')}
                            >
                              <ShieldCheck size={11} className="mr-1" />Whitelist
                            </Button>
                          )}
                          {row.status === 'banned' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                // Open the drawer to use the lift ban button there (which has the banId)
                                handleRowClick(row);
                              }}
                            >
                              <Shield size={11} className="mr-1" />Lift ban
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
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

      {/* Detail drawer */}
      {selectedIp && (
        <IPDetailDrawer
          ip={selectedIp}
          onClose={() => { setSelectedIp(null); setSelectedBanId(null); }}
          onBan={handleBan}
          onWhitelist={handleWhitelist}
          onLiftBan={async () => {
            if (selectedBanId != null) {
              await handleLiftBanById(selectedBanId, selectedIp.ip);
            } else {
              // Fetch the ban ID from the API if we don't have it
              try {
                const res = await fetch(`/api/bans?ip=${encodeURIComponent(selectedIp.ip)}&active=true&pageSize=1`);
                if (res.ok) {
                  const json: { data: Array<{ id: number }> } = await res.json();
                  if (json.data.length > 0) {
                    await handleLiftBanById(json.data[0].id, selectedIp.ip);
                    return;
                  }
                }
              } catch {
                // fall through
              }
              toast.error('Could not find active ban for this IP');
            }
          }}
        />
      )}
    </div>
  );
}
