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
  Eraser,
  Pencil,
  Tag,
  Plus,
  Trash2,
  AlertTriangle,
  EyeOff,
  Eye,
} from 'lucide-react';
import type {
  IpReputation,
  IpEvent,
  IpStatus,
  BanScope,
  IpWhitelist,
  WhitelistScope,
  CreateWhitelistRequest,
  IpBan,
  CreateBanRequest,
} from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { cn } from '@/utils/cn';
import { useAuthStore } from '@/store/authStore';
import toast from 'react-hot-toast';
import apiClient from '../api/client';
import { ipLabelsApi } from '../api/ipLabels.api';
import { anonIp, anonHostname, anonUsername, anonLog } from '@/utils/anonymize';

const PAGE_SIZE = 25;

// ── Page tabs ──────────────────────────────────────────────────────────────────

type PageTab = 'local' | 'remote';

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

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
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

// ── Skeleton rows ───────────────────────────────────────────────────────────────

function ActivitySkeletonRow() {
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

function WhitelistSkeletonRow() {
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

function BansSkeletonRow({ cols }: { cols: number }) {
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

// ── ConfirmDialog (shared) ──────────────────────────────────────────────────────

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

// ── IPDetailDrawer ─────────────────────────────────────────────────────────────

interface IPDetailDrawerProps {
  ip: IpReputation;
  onClose: () => void;
  onBan: (ip: string, scope: BanScope, reason: string) => Promise<void>;
  onWhitelist: (ip: string, label: string) => Promise<void>;
  onLiftBan: () => Promise<void>;
  onClear: (ip: string) => Promise<void>;
  onRename: (ip: string, label: string) => Promise<void>;
  currentLabel?: string;
  isAdmin: boolean;
}

function IPDetailDrawer({ ip, onClose, onBan, onWhitelist, onLiftBan, onClear, onRename, currentLabel, isAdmin }: IPDetailDrawerProps) {
  const [events, setEvents] = useState<IpEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [banScope, setBanScope] = useState<BanScope>('global');
  const [banReason, setBanReason] = useState('');
  const [whitelistLabel, setWhitelistLabel] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [showBanForm, setShowBanForm] = useState(false);
  const [showWhitelistForm, setShowWhitelistForm] = useState(false);
  const [showRenameForm, setShowRenameForm] = useState(false);
  const [renameValue, setRenameValue] = useState(currentLabel ?? '');
  const [banInfo, setBanInfo] = useState<{ banType?: string; reason?: string; bannedByUserId?: number | null; bannedByUsername?: string | null; scope?: string } | null>(null);
  const [whitelistInfo, setWhitelistInfo] = useState<{ createdByUsername?: string | null; label?: string | null } | null>(null);

  // Fetch ban details if IP is banned
  useEffect(() => {
    setBanInfo(null);
    if (ip.status !== 'banned' || !ip.activeBanId) return;
    apiClient.get<{ data: { banType?: string; reason?: string; bannedByUserId?: number | null; bannedByUsername?: string | null; scope?: string } }>(`/bans/${ip.activeBanId}`)
      .then(res => setBanInfo(res.data?.data ?? null))
      .catch(() => {});
  }, [ip.status, ip.activeBanId]);

  // Fetch whitelist details if IP is whitelisted
  useEffect(() => {
    setWhitelistInfo(null);
    if (ip.status !== 'whitelisted') return;
    apiClient.get<{ data: { id: number; ip: string; label?: string; created_by?: number; scope?: string }[] }>('/whitelist')
      .then(async res => {
        const entry = (res.data?.data ?? []).find(w => w.ip === ip.ip || w.ip === ip.ip + '/32');
        if (!entry) return;
        let createdByUsername: string | null = null;
        if (entry.created_by) {
          try {
            const userRes = await apiClient.get<{ data: { username?: string; displayName?: string } }>(`/users/${entry.created_by}`);
            createdByUsername = userRes.data?.data?.displayName || userRes.data?.data?.username || null;
          } catch { /* ignore */ }
        }
        setWhitelistInfo({ createdByUsername, label: entry.label ?? null });
      })
      .catch(() => {});
  }, [ip.status, ip.ip]);

  const loadEvents = useCallback(async () => {
    setLoadingEvents(true);
    try {
      const res = await apiClient.get<{ data: IpEvent[]; total: number }>(
        `/ip-events/${encodeURIComponent(ip.ip)}`,
        { params: { limit: 20 } },
      );
      setEvents(res.data?.data ?? []);
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

  const handleRename = async () => {
    setActionLoading(true);
    try {
      await onRename(ip.ip, renameValue.trim());
      setShowRenameForm(false);
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
              <span className="text-lg font-mono font-semibold text-text-primary">{anonIp(ip.ip)}</span>
              <CopyButton text={ip.ip} />
              <StatusBadge status={ip.status} />
              {banInfo && (
                <span className={cn(
                  'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium',
                  banInfo.banType === 'auto' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-blue-500/10 text-blue-400 border border-blue-500/20',
                )}>
                  {banInfo.banType === 'auto' ? 'Auto-ban' : `Manual${banInfo.bannedByUsername ? ' by ' + banInfo.bannedByUsername : ''}`}
                </span>
              )}
              {whitelistInfo && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                  Whitelisted{whitelistInfo.createdByUsername ? ' by ' + whitelistInfo.createdByUsername : ''}
                </span>
              )}
            </div>
            {banInfo?.reason && (
              <p className="text-xs text-text-muted mt-1">{banInfo.reason}</p>
            )}
            {currentLabel && (
              <div className="flex items-center gap-1.5 mt-1">
                <Tag size={11} className="text-accent shrink-0" />
                <span className="text-sm font-medium text-accent">{currentLabel}</span>
              </div>
            )}
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
                    <span className="font-mono">{anonUsername(u)}</span>
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
                        <td className="px-3 py-2 font-mono text-text-secondary">{ev.username ? anonUsername(ev.username) : '—'}</td>
                        <td className="px-3 py-2 text-text-muted">{anonHostname((ev as any).hostname ?? ev.deviceHostname ?? '—')}</td>
                        <td className="px-3 py-2 text-text-muted max-w-[180px]">
                          <span className="truncate block" title={ev.rawLog ? anonLog(ev.rawLog) : undefined}>
                            {ev.rawLog ? anonLog(ev.rawLog.slice(0, 60) + (ev.rawLog.length > 60 ? '…' : '')) : '—'}
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
                    <p className="text-sm font-medium text-text-primary">Ban {anonIp(ip.ip)}</p>
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
                    <p className="text-sm font-medium text-text-primary">Whitelist {anonIp(ip.ip)}</p>
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

            {/* Clear suspicious — shown for suspicious IPs */}
            {ip.status === 'suspicious' && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-2">
                <p className="text-xs text-amber-400 font-medium">
                  {isAdmin
                    ? 'Reset total_failures to 0 for ALL tenants (global clear).'
                    : ip.clearedForTenant
                      ? 'New failures occurred since your last clear. Clear again to reset.'
                      : 'Mark this IP as reviewed. It will become suspicious again if new failures arrive.'}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={actionLoading}
                  onClick={async () => {
                    setActionLoading(true);
                    try {
                      await onClear(ip.ip);
                    } finally {
                      setActionLoading(false);
                    }
                  }}
                >
                  <Eraser size={13} className="mr-1.5" />
                  Clear
                </Button>
              </div>
            )}

            {/* Rename / custom label */}
            <div>
              {!showRenameForm ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setRenameValue(currentLabel ?? '');
                    setShowRenameForm(true);
                    setShowBanForm(false);
                    setShowWhitelistForm(false);
                  }}
                >
                  <Tag size={13} className="mr-1.5" />
                  {currentLabel ? 'Edit label' : 'Add label'}
                </Button>
              ) : (
                <div className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
                  <p className="text-sm font-medium text-text-primary">
                    {currentLabel ? 'Edit label for' : 'Label'} {anonIp(ip.ip)}
                  </p>
                  <Input
                    label="Label"
                    placeholder="e.g. Home router, Office ISP…"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void handleRename(); }}
                    autoFocus
                  />
                  <div className="flex gap-2 flex-wrap">
                    <Button size="sm" loading={actionLoading} onClick={handleRename}>
                      Save label
                    </Button>
                    {currentLabel && (
                      <Button
                        size="sm"
                        variant="danger"
                        loading={actionLoading}
                        onClick={async () => {
                          setActionLoading(true);
                          try {
                            await onRename(ip.ip, '');
                            setShowRenameForm(false);
                          } finally {
                            setActionLoading(false);
                          }
                        }}
                      >
                        Remove label
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => setShowRenameForm(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Activity tab ───────────────────────────────────────────────────────────────

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'banned', label: 'Banned' },
  { key: 'suspicious', label: 'Suspicious' },
  { key: 'whitelisted', label: 'Whitelisted' },
  { key: 'clean', label: 'Clean' },
];

interface Tenant {
  id: number;
  name: string;
}

interface ActivityTabProps {
  isAdmin: boolean;
}

function ActivityTab({ isAdmin }: ActivityTabProps) {
  const [rows, setRows] = useState<IpReputation[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(0);
  const [selectedIp, setSelectedIp] = useState<IpReputation | null>(null);
  const [selectedBanId, setSelectedBanId] = useState<number | null>(null);
  const [ipLabels, setIpLabels] = useState<Map<string, string>>(new Map());
  // Admin-only tenant selector
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset page on filter/search change
  useEffect(() => {
    setPage(0);
  }, [statusFilter, debouncedSearch, selectedTenantId]);

  // Fetch tenants for admin selector
  useEffect(() => {
    if (!isAdmin) return;
    apiClient.get<{ data: Tenant[] } | Tenant[]>('/tenants')
      .then(res => {
        const data = Array.isArray(res.data) ? res.data : (res.data as { data: Tenant[] }).data ?? [];
        setTenants(data);
      })
      .catch(() => { /* non-critical */ });
  }, [isAdmin]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      };
      if (statusFilter !== 'all') params.status = statusFilter;
      if (debouncedSearch.trim()) params.search = debouncedSearch.trim();
      if (isAdmin && selectedTenantId != null) params.tenantId = String(selectedTenantId);

      const res = await apiClient.get<{ data: IpReputation[]; total: number }>(
        '/ip-reputation',
        { params },
      );
      setRows(res.data?.data ?? []);
      setTotal(res.data?.total ?? 0);
    } catch {
      toast.error('Failed to load IP reputation data');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, debouncedSearch, page, isAdmin, selectedTenantId]);

  useEffect(() => {
    load();
  }, [load]);

  // Fetch custom IP labels on mount
  useEffect(() => {
    ipLabelsApi.list()
      .then(labels => {
        const m = new Map<string, string>();
        for (const { ip, label } of labels) if (label) m.set(ip, label);
        setIpLabels(m);
      })
      .catch(() => { /* non-critical */ });
  }, []);

  const handleRename = async (ipAddr: string, label: string) => {
    try {
      if (label.trim()) {
        await ipLabelsApi.upsert(ipAddr, label.trim());
        setIpLabels(prev => new Map(prev).set(ipAddr, label.trim()));
        toast.success(`Label "${label.trim()}" saved for ${ipAddr}`);
      } else {
        await ipLabelsApi.remove(ipAddr);
        setIpLabels(prev => { const m = new Map(prev); m.delete(ipAddr); return m; });
        toast.success(`Label removed for ${ipAddr}`);
      }
    } catch {
      toast.error('Failed to save label');
      throw new Error('Failed to save label');
    }
  };

  const handleBan = async (ipAddr: string, scope: BanScope, reason: string) => {
    try {
      const res = await apiClient.post<{ id?: number; data?: { id: number } }>(
        '/bans',
        { ip: ipAddr, reason, scope },
      );
      const created = res.data;
      const banId = created?.id ?? (created as any)?.data?.id ?? null;
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
      await apiClient.post('/whitelist', { ip: ipAddr, label: label || null });
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

  const handleUnwhitelist = async (ipAddr: string) => {
    try {
      // Find the whitelist entry by IP to get its ID
      const wlRes = await apiClient.get<{ data: { id: number; ip: string }[] }>('/whitelist');
      const entry = (wlRes.data?.data ?? []).find(w => w.ip === ipAddr || w.ip === ipAddr + '/32');
      if (!entry) { toast.error('Whitelist entry not found'); return; }
      await apiClient.delete(`/whitelist/${entry.id}`);
      toast.success(`${ipAddr} removed from whitelist`);
      setRows(prev => prev.map(r => r.ip === ipAddr ? { ...r, status: 'clean' } : r));
      if (selectedIp?.ip === ipAddr) {
        setSelectedIp(prev => prev ? { ...prev, status: 'clean' } : prev);
      }
    } catch {
      toast.error('Failed to remove from whitelist');
    }
  };

  // ── Bulk selection ──────────────────────────────────────────────────────
  const [selectedIps, setSelectedIps] = useState<Set<string>>(new Set());
  const toggleSelectIp = (ip: string) => {
    setSelectedIps(prev => {
      const next = new Set(prev);
      if (next.has(ip)) next.delete(ip); else next.add(ip);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (selectedIps.size === rows.length) setSelectedIps(new Set());
    else setSelectedIps(new Set(rows.map(r => r.ip)));
  };
  const handleBulkBan = async () => {
    if (selectedIps.size === 0) return;
    if (!confirm(`Ban ${selectedIps.size} IPs?`)) return;
    try {
      await apiClient.post('/bans/bulk-ban', { ips: [...selectedIps] });
      toast.success(`${selectedIps.size} IPs banned`);
      setSelectedIps(new Set());
      load();
    } catch { toast.error('Bulk ban failed'); }
  };
  const handleBulkWhitelist = async () => {
    if (selectedIps.size === 0) return;
    const label = prompt('Label for whitelisted IPs (optional):') ?? '';
    try {
      await apiClient.post('/bans/bulk-whitelist', { ips: [...selectedIps], label: label || undefined });
      toast.success(`${selectedIps.size} IPs whitelisted`);
      setSelectedIps(new Set());
      load();
    } catch { toast.error('Bulk whitelist failed'); }
  };

  const handleLiftBanById = async (banId: number, ipAddr?: string) => {
    try {
      await apiClient.delete(`/bans/${banId}`);
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

  const handleClear = async (ipAddr: string) => {
    try {
      await apiClient.post(`/ip-reputation/${encodeURIComponent(ipAddr)}/clear`);
      const msg = isAdmin
        ? `${ipAddr} reputation reset globally`
        : `${ipAddr} marked as cleared`;
      toast.success(msg);
      if (isAdmin) {
        setRows(prev => prev.map(r => r.ip === ipAddr ? { ...r, totalFailures: 0, status: 'clean', clearedForTenant: false } : r));
        if (selectedIp?.ip === ipAddr) {
          setSelectedIp(prev => prev ? { ...prev, totalFailures: 0, status: 'clean', clearedForTenant: false } : prev);
        }
      } else {
        setRows(prev => prev.map(r => r.ip === ipAddr ? { ...r, status: 'clean', clearedForTenant: true } : r));
        if (selectedIp?.ip === ipAddr) {
          setSelectedIp(prev => prev ? { ...prev, status: 'clean', clearedForTenant: true } : prev);
        }
      }
    } catch {
      toast.error('Failed to clear IP suspicious status');
      throw new Error('Failed to clear');
    }
  };

  const handleRowClick = (row: IpReputation) => {
    setSelectedIp(row);
    setSelectedBanId(row.activeBanId ?? null);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <>
      {/* Status filter pills (service-templates style) */}
      <div className="flex items-center gap-1 mb-5 rounded-lg bg-bg-secondary p-1 border border-border w-fit">
          {STATUS_FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={cn(
                'px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                statusFilter === f.key
                  ? 'bg-accent text-white'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              {f.label}
            </button>
          ))}
      </div>

      {/* Search + tenant selector + refresh */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {isAdmin && tenants.length > 0 && (
          <select
            value={selectedTenantId ?? ''}
            onChange={e => setSelectedTenantId(e.target.value === '' ? null : Number(e.target.value))}
            className="rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">All Tenants</option>
            {tenants.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <input
            type="text"
            placeholder="Search IP or country..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 pr-3 py-2 text-sm rounded-md border border-border bg-bg-secondary text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent w-full"
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

      {/* Bulk action bar */}
      {selectedIps.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-3 py-2 rounded-lg bg-accent/10 border border-accent/20">
          <span className="text-sm font-medium text-accent">{selectedIps.size} selected</span>
          <Button size="sm" variant="secondary" onClick={handleBulkBan}>
            <ShieldOff size={11} className="mr-1" />Ban selected
          </Button>
          <Button size="sm" variant="secondary" onClick={handleBulkWhitelist}>
            <ShieldCheck size={11} className="mr-1" />Whitelist selected
          </Button>
          <button onClick={() => setSelectedIps(new Set())} className="ml-auto text-xs text-text-muted hover:text-text-primary">
            Clear selection
          </button>
        </div>
      )}

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
                <th className="px-2 py-2.5 w-8">
                  <input type="checkbox" checked={selectedIps.size === rows.length && rows.length > 0} onChange={toggleSelectAll} className="accent-accent" />
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">IP Address</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Country</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Failures</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Services</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Agents</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Last seen</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Status</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide">Source</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-text-muted uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading
                ? Array.from({ length: 8 }).map((_, i) => <ActivitySkeletonRow key={i} />)
                : rows.map(row => {
                  const flag = countryCodeToFlag(row.geoCountryCode);
                  // Single label: use ip_display_names label (ipLabels) as the one source of truth
                  const displayLabel = ipLabels.get(row.ip);
                  return (
                    <tr
                      key={row.ip}
                      onClick={() => handleRowClick(row)}
                      className="hover:bg-bg-hover transition-colors cursor-pointer"
                    >
                      <td className="px-2 py-3" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={selectedIps.has(row.ip)} onChange={() => toggleSelectIp(row.ip)} className="accent-accent" />
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-text-primary">{anonIp(row.ip)}</span>
                        {displayLabel && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <Tag size={10} className="text-accent shrink-0" />
                            <span className="text-xs text-accent">{displayLabel}</span>
                          </div>
                        )}
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
                        <div className="flex flex-col gap-1">
                          <StatusBadge status={row.status} />
                          {row.clearedForTenant && (
                            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-400">
                              <Eraser size={8} />Cleared
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {(() => {
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          const r = row as any;
                          if (r.banType === 'auto') return <span className="text-[10px] font-medium text-amber-400">Auto-ban</span>;
                          if (r.banType === 'manual') return <span className="text-[10px] font-medium text-blue-400">Manual</span>;
                          if (row.status === 'whitelisted') return <span className="text-[10px] font-medium text-green-400">Whitelist</span>;
                          return <span className="text-[10px] text-text-muted">—</span>;
                        })()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div
                          className="flex items-center justify-end gap-1 flex-wrap"
                          onClick={e => e.stopPropagation()}
                        >
                          <button
                            title={ipLabels.get(row.ip) ? 'Edit label' : 'Add label'}
                            onClick={() => handleRowClick(row)}
                            className="p-1 rounded text-text-muted hover:text-accent hover:bg-bg-hover transition-colors"
                          >
                            <Pencil size={12} />
                          </button>
                          {row.status !== 'banned' && (
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => handleQuickBan(row)}
                            >
                              <ShieldOff size={11} className="mr-1" />Ban
                            </Button>
                          )}
                          {row.status !== 'whitelisted' ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => handleWhitelist(row.ip, '')}
                            >
                              <ShieldCheck size={11} className="mr-1" />Whitelist
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => handleUnwhitelist(row.ip)}
                            >
                              <ShieldOff size={11} className="mr-1" />Unwhitelist
                            </Button>
                          )}
                          {row.status === 'banned' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                handleRowClick(row);
                              }}
                            >
                              <Shield size={11} className="mr-1" />Lift ban
                            </Button>
                          )}
                          {row.status === 'suspicious' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => void handleClear(row.ip)}
                              title={isAdmin ? 'Reset failure counter globally' : 'Clear suspicious for your tenant'}
                            >
                              <Eraser size={11} className="mr-1" />Clear
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
          onRename={handleRename}
          currentLabel={ipLabels.get(selectedIp.ip)}
          onLiftBan={async () => {
            if (selectedBanId != null) {
              await handleLiftBanById(selectedBanId, selectedIp.ip);
            } else {
              try {
                const res = await apiClient.get<{ data: Array<{ id: number }> }>(
                  '/bans',
                  { params: { search: selectedIp.ip, active: 'true', pageSize: 1 } },
                );
                if (res.data) {
                  const json = res.data;
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
          onClear={handleClear}
          isAdmin={isAdmin}
        />
      )}
    </>
  );
}

// ── Whitelist tab ──────────────────────────────────────────────────────────────

const WHITELIST_SCOPE_CLASSES: Record<WhitelistScope, string> = {
  global: 'bg-status-up/10 text-status-up',
  tenant: 'bg-yellow-500/10 text-yellow-400',
  group: 'bg-blue-500/10 text-blue-400',
  agent: 'bg-text-muted/15 text-text-muted',
};

function WhitelistScopeBadge({ scope }: { scope: WhitelistScope }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize', WHITELIST_SCOPE_CLASSES[scope])}>
      {scope}
    </span>
  );
}

const WHITELIST_SCOPE_FILTERS: { key: WhitelistScope | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'global', label: 'Global' },
  { key: 'tenant', label: 'Tenant' },
  { key: 'group', label: 'Group' },
  { key: 'agent', label: 'Agent' },
];

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

/** @deprecated Kept for potential future use. Access whitelist via IP drawer instead. */
export function WhitelistTab() {
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
      const json = await res.json();
      const data: IpWhitelist[] = Array.isArray(json) ? json : (json.data ?? []);
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
    <>
      {/* Header row */}
      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-text-muted">Manage trusted IP addresses and CIDR ranges</p>
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
        {WHITELIST_SCOPE_FILTERS.map(f => (
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
                ? Array.from({ length: 6 }).map((_, i) => <WhitelistSkeletonRow key={i} />)
                : entries.map(entry => (
                  <tr key={entry.id} className="hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Globe size={13} className="text-text-muted shrink-0" />
                        <span className="font-mono text-text-primary">{anonIp(entry.ip)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {entry.label || <span className="text-text-muted italic">No label</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <WhitelistScopeBadge scope={entry.scope} />
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

      {showAddModal && (
        <AddWhitelistModal
          onSave={handleAdd}
          onClose={() => setShowAddModal(false)}
        />
      )}

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
    </>
  );
}

// ── Bans tab ───────────────────────────────────────────────────────────────────

const BAN_SCOPE_CLASSES: Record<BanScope, string> = {
  global: 'bg-status-down/10 text-status-down',
  tenant: 'bg-yellow-500/10 text-yellow-400',
  group: 'bg-blue-500/10 text-blue-400',
  agent: 'bg-text-muted/15 text-text-muted',
};

function BanScopeBadge({ scope }: { scope: BanScope }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize', BAN_SCOPE_CLASSES[scope])}>
      {scope}
    </span>
  );
}

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

function ExcludedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-yellow-500/10 text-yellow-400">
      <EyeOff size={10} />Excluded
    </span>
  );
}

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

interface BanListResponse {
  data: IpBan[];
  total: number;
}

interface BansTabProps {
  isAdmin: boolean;
}

/** @deprecated Kept for potential future use. Access bans via IP drawer instead. */
export function BansTab({ isAdmin }: BansTabProps) {
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

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

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
    <>
      {/* Header row */}
      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-text-muted">Manage IP bans across all scopes</p>
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
                ? Array.from({ length: 8 }).map((_, i) => <BansSkeletonRow key={i} cols={colCount} />)
                : bans.map(ban => (
                  <tr key={ban.id} className="hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Globe size={13} className="text-text-muted shrink-0" />
                        <span className="font-mono text-text-primary">
                          {ban.ip}{ban.cidrPrefix != null && ban.cidrPrefix !== 32 ? `/${ban.cidrPrefix}` : ''}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <BanScopeBadge scope={ban.scope} />
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

      {showAddModal && (
        <AddBanModal
          onSave={handleAddBan}
          onClose={() => setShowAddModal(false)}
        />
      )}

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
    </>
  );
}

// ── IPReputationPage ───────────────────────────────────────────────────────────

const PAGE_TABS: { key: PageTab; label: string }[] = [
  { key: 'local', label: 'Local' },
  { key: 'remote', label: 'Remote' },
];

// ── Remote tab ─────────────────────────────────────────────────────────────────

function RemoteTab() {
  const [ips, setIps] = useState<import('../api/remoteBlocklist.api').RemoteBlockedIp[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<import('../api/remoteBlocklist.api').RemoteBlocklist[]>([]);
  const [stats, setStats] = useState<import('../api/remoteBlocklist.api').RemoteBlocklistStats | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<number | null>(null);
  const [page, setPage] = useState(0);

  const PAGE_SIZE = 25;

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Load sources + stats
  useEffect(() => {
    import('../api/remoteBlocklist.api').then(({ remoteBlocklistApi }) => {
      remoteBlocklistApi.list().then(setSources).catch(() => {});
      remoteBlocklistApi.stats().then(setStats).catch(() => {});
    });
  }, []);

  // Load IPs
  useEffect(() => {
    setLoading(true);
    import('../api/remoteBlocklist.api').then(({ remoteBlocklistApi }) => {
      remoteBlocklistApi.listIps({
        blocklistId: sourceFilter ?? undefined,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }).then(result => {
        setIps(result.data);
        setTotal(result.total);
      }).catch(() => {
        setIps([]);
        setTotal(0);
      }).finally(() => setLoading(false));
    });
  }, [debouncedSearch, sourceFilter, page]);

  const toggleIp = async (id: number, enabled: boolean) => {
    const { remoteBlocklistApi } = await import('../api/remoteBlocklist.api');
    await remoteBlocklistApi.toggleIp(id, enabled);
    setIps(prev => prev.map(ip => ip.id === id ? { ...ip, enabled } : ip));
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  if (sources.length === 0 && !loading && total === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-full bg-bg-secondary border border-border flex items-center justify-center mb-4">
          <Globe size={28} className="text-text-muted" />
        </div>
        <h3 className="text-sm font-medium text-text-secondary mb-1">No Remote Blocklists</h3>
        <p className="text-xs text-text-muted max-w-sm">
          Add remote blocklists in Settings to see external threat intelligence here.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Stats */}
      {stats && (
        <div className="flex items-center gap-6 mb-4 text-xs text-text-muted">
          <span>{stats.total} remote IPs</span>
          <span>{stats.sources} source(s)</span>
          {stats.lastSync && <span>Last sync: {formatDateShort(stats.lastSync)}</span>}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <select
          value={sourceFilter ?? ''}
          onChange={e => { setSourceFilter(e.target.value ? Number(e.target.value) : null); setPage(0); }}
          className="rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All Sources</option>
          {sources.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <input
            type="text"
            placeholder="Search IP..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
            className="pl-9 pr-3 py-2 text-sm rounded-md border border-border bg-bg-secondary text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent w-full"
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-tertiary text-text-secondary text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3 font-medium">IP</th>
              <th className="text-left px-4 py-3 font-medium">Reason</th>
              <th className="text-left px-4 py-3 font-medium">Source</th>
              <th className="text-right px-4 py-3 font-medium">Reports</th>
              <th className="text-left px-4 py-3 font-medium">Last seen</th>
              <th className="text-center px-4 py-3 font-medium">Status</th>
              <th className="text-right px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-bg-tertiary rounded w-20" /></td>
                  ))}
                </tr>
              ))
            ) : ips.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-text-muted">No remote IPs found</td></tr>
            ) : ips.map(ip => (
              <tr key={ip.id} className={cn('hover:bg-bg-hover transition-colors', !ip.enabled && 'opacity-50')}>
                <td className="px-4 py-3 font-mono text-text-primary">{ip.ip}</td>
                <td className="px-4 py-3 text-text-muted truncate max-w-[180px]">{ip.reason || '—'}</td>
                <td className="px-4 py-3">
                  <span className={cn(
                    'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium',
                    ip.sourceType === 'oblitools'
                      ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                      : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20',
                  )}>
                    {ip.blocklistName}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-mono text-text-secondary">{ip.reports}</td>
                <td className="px-4 py-3 text-text-muted">{formatDateShort(ip.lastSeen)}</td>
                <td className="px-4 py-3 text-center">
                  {ip.enabled
                    ? <span className="text-[10px] font-medium text-status-up">ACTIVE</span>
                    : <span className="text-[10px] font-medium text-text-muted">DISABLED</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => void toggleIp(ip.id, !ip.enabled)}
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                    title={ip.enabled ? 'Disable' : 'Enable'}
                  >
                    {ip.enabled ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm text-text-muted">
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            className="px-3 py-1.5 rounded border border-border hover:bg-bg-hover disabled:opacity-40 transition-colors">
            Previous
          </button>
          <span>{page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            className="px-3 py-1.5 rounded border border-border hover:bg-bg-hover disabled:opacity-40 transition-colors">
            Next
          </button>
        </div>
      )}
    </>
  );
}

export function IPReputationPage() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';

  const [activeTab, setActiveTab] = useState<PageTab>('local');

  return (
    <div className="p-6">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-text-primary">IP Reputation</h1>
        <p className="text-sm text-text-muted mt-0.5">Monitor and manage IP reputation across all agents</p>
      </div>

      {/* Tab bar (pill style, same as sub-filters) */}
      <div className="flex items-center gap-1 mb-6 rounded-lg bg-bg-secondary p-1 border border-border w-fit">
        {PAGE_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
              activeTab === tab.key
                ? 'bg-accent text-white'
                : 'text-text-muted hover:text-text-primary',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'local' && <ActivityTab isAdmin={isAdmin} />}
      {activeTab === 'remote' && <RemoteTab />}
    </div>
  );
}
