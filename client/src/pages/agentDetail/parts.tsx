import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { AgentDevice, IpEventStreamRow, IpEventsFrame } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';

// ── Shared pieces of the agent detail tabs ───────────────────────────────────

/** A GET /ip-events row (database columns, plus the joined agent hostname). */
export interface IpEventRow {
  id: number;
  device_id: number | null;
  ip: string;
  username: string | null;
  service: string;
  event_type: string;
  timestamp: string;
  raw_log: string | null;
  hostname?: string;
}

/** Props every tab body receives from the AgentDetailPage shell. */
export interface AgentTabProps {
  device: AgentDevice;
  /** Replace the device after a write (PATCH responses carry the full row). */
  onDeviceChange: (device: AgentDevice) => void;
  /** Another tenant's agent, or a read-only team grant: every write is hidden. */
  readOnly: boolean;
  /** Bumped by the header Refresh button: tabs reload their data. */
  refreshKey: number;
}

/** Built-in service names, always offered by the service filters. */
export const BUILTIN_SERVICES = ['ssh', 'rdp', 'nginx', 'apache', 'iis', 'ftp', 'mail', 'mysql'] as const;

/** Live stream row → the REST row shape the tables render. */
export function rowFromStream(row: IpEventStreamRow): IpEventRow {
  return {
    id: row.id,
    device_id: row.deviceId,
    ip: row.ip,
    username: row.username,
    service: row.service,
    event_type: row.eventType,
    timestamp: row.timestamp,
    raw_log: null,
  };
}

/**
 * Rows of this agent from every ip:events frame (tenant feed or agent watch).
 * The latest `onRows` closure is used; the listener re-binds when the socket
 * is rebuilt (new generation).
 */
export function useAgentIpEvents(deviceId: number, onRows: (rows: IpEventStreamRow[]) => void): void {
  const generation = useSocketStore((s) => s.generation);
  const ref = useRef(onRows);
  ref.current = onRows;
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onFrame = (frame: IpEventsFrame) => {
      const rows = (frame?.events ?? []).filter((r) => r.deviceId === deviceId);
      if (rows.length > 0) ref.current(rows);
    };
    socket.on(SOCKET_EVENTS.IP_EVENTS, onFrame);
    return () => { socket.off(SOCKET_EVENTS.IP_EVENTS, onFrame); };
  }, [deviceId, generation]);
}

/** Calls `fn` on the window event (latest closure). */
export function useWindowEvent(name: string, fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  const handler = useCallback(() => ref.current(), []);
  useEffect(() => {
    window.addEventListener(name, handler);
    return () => window.removeEventListener(name, handler);
  }, [name, handler]);
}

export function relativeTime(ts: string, t: TFunction): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (diff < 60) return t('agentDetail.time.seconds', { defaultValue: '{{n}}s ago', n: diff });
  if (diff < 3600) return t('agentDetail.time.minutes', { defaultValue: '{{n}}m ago', n: Math.floor(diff / 60) });
  if (diff < 86400) return t('agentDetail.time.hours', { defaultValue: '{{n}}h ago', n: Math.floor(diff / 3600) });
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatTs(ts: string): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ── Lookup links ──────────────────────────────────────────────────────────────

const LOOKUP_LINKS = [
  { label: 'AbuseIPDB',  url: (ip: string) => `https://www.abuseipdb.com/check/${ip}` },
  { label: 'Shodan',     url: (ip: string) => `https://www.shodan.io/host/${ip}` },
  { label: 'VirusTotal', url: (ip: string) => `https://www.virustotal.com/gui/ip-address/${ip}` },
  { label: 'WHOIS',      url: (ip: string) => `https://who.is/whois-ip/ip-address/${ip}` },
  { label: 'MXToolbox',  url: (ip: string) => `https://mxtoolbox.com/SuperTool.aspx?action=ptr:${ip}` },
];

export function LookupButtons({ ip, compact }: { ip: string; compact?: boolean }) {
  const links = compact ? LOOKUP_LINKS.slice(0, 3) : LOOKUP_LINKS;
  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map(({ label, url }) => (
        <a
          key={label}
          href={url(ip)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded border border-border bg-bg-tertiary px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary hover:border-accent/40 transition-colors coarse:min-h-8"
        >
          {label}
          <ExternalLink size={8} />
        </a>
      ))}
    </div>
  );
}

// ── EventTypeBadge ────────────────────────────────────────────────────────────

const EVENT_TYPE_STYLES: Record<string, string> = {
  auth_failure: 'bg-red-500/10 text-red-400 border-red-500/20',
  auth_success: 'bg-green-500/10 text-green-400 border-green-500/20',
  port_scan:    'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

export function EventTypeBadge({ type }: { type: string }) {
  const { t } = useTranslation();
  const labels: Record<string, string> = {
    auth_failure: t('agentDetail.eventType.failShort', { defaultValue: 'FAIL' }),
    auth_success: t('agentDetail.eventType.okShort', { defaultValue: 'OK' }),
    port_scan:    t('agentDetail.eventType.scanShort', { defaultValue: 'SCAN' }),
  };
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold ${
      EVENT_TYPE_STYLES[type] ?? 'bg-bg-tertiary text-text-muted border-border'
    }`}>
      {labels[type] ?? type.toUpperCase()}
    </span>
  );
}

// ── MiniStat ──────────────────────────────────────────────────────────────────

export function MiniStat({
  label, value, colorClass,
}: { label: string; value: string | number; colorClass?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary px-4 py-3 min-w-0">
      <div className="text-[10px] uppercase text-text-muted tracking-wide mb-1 truncate">{label}</div>
      <div className={`text-xl font-bold truncate ${colorClass ?? 'text-text-primary'}`}>{value}</div>
    </div>
  );
}

/** Card section title row used by every tab. */
export function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-border flex items-center gap-3 flex-wrap">
      <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide flex-shrink-0">{children}</h2>
      {extra && <div className="ml-auto flex items-center gap-2 text-xs text-text-muted">{extra}</div>}
    </div>
  );
}
