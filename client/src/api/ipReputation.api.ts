import apiClient from './client';
import type {
  ApiResponse,
  AddIpReputationRequest,
  BanScope,
  IpBan,
  IpEvent,
  IpReputation,
  IpStatus,
  IpWhitelist,
} from '@obliview/shared';

/** Server-side sort keys of GET /ip-reputation (ipReputation.service REPUTATION_SORT_KEYS). */
export type ReputationSortBy = 'lastSeen' | 'failures' | 'agents' | 'country' | 'firstSeen';
export type SortOrder = 'asc' | 'desc';

export interface ReputationListParams {
  status?: IpStatus;
  /** An IP (exact), a CIDR (containment) or a substring. */
  search?: string;
  /** 1-based page. */
  page?: number;
  pageSize?: number;
  /** Omitted: the server default (last seen, newest first). */
  sortBy?: ReputationSortBy;
  sortOrder?: SortOrder;
  /** God view: narrow to these tenants (sent as ?tenants=1,2). */
  tenantIds?: number[];
}

/**
 * A reputation row. In the god view the server may attribute the row to a
 * tenant (tenantId / tenantName); rows without them are platform-wide.
 */
export type IpReputationRow = IpReputation & {
  tenantId?: number | null;
  tenantName?: string | null;
};

export interface ReputationListResult {
  data: IpReputationRow[];
  total: number;
}

/** GET /ip-reputation/:ip — null reputation when only events are known. */
export interface IpDetail {
  reputation: IpReputation | null;
  recentEvents: IpEvent[];
}

export type BanState = 'active' | 'expired' | 'lifted';

/** A ban row of the history of one IP (names resolved by the server when it can). */
export type IpBanHistoryItem = IpBan & {
  state?: BanState;
  liftedAt?: string | null;
  createdByUsername?: string | null;
  scopeName?: string | null;
  tenantName?: string | null;
};

/** POST /bans/bulk-ban response. */
export interface BulkBanResult {
  created: number;
  skipped: number;
  invalid: number;
  scope: Extract<BanScope, 'global' | 'tenant'>;
  skippedEntries: { ip: string; reason: string }[];
  invalidEntries: { ip: string; reason: string }[];
}

/** POST /bans/bulk-whitelist response. */
export interface BulkWhitelistResult {
  created: number;
  invalid?: number;
}

type RawEvent = Partial<IpEvent> & Record<string, unknown>;

function pick<T>(row: RawEvent, camel: string, snake: string): T | undefined {
  return (row[camel] ?? row[snake]) as T | undefined;
}

/**
 * GET /ip-events returns database rows (snake_case: event_type, raw_log,
 * hostname…) while /ip-reputation/:ip returns IpEvent objects: accept both.
 */
export function normaliseEvent(row: RawEvent): IpEvent {
  return {
    id: Number(row.id),
    deviceId: pick<number | null>(row, 'deviceId', 'device_id') ?? null,
    deviceHostname: pick<string>(row, 'deviceHostname', 'hostname') ?? undefined,
    ip: String(row.ip ?? ''),
    username: (row.username as string | null | undefined) ?? null,
    service: String(row.service ?? ''),
    eventType: (pick<IpEvent['eventType']>(row, 'eventType', 'event_type') ?? 'auth_failure'),
    timestamp: String(row.timestamp ?? ''),
    rawLog: pick<string | null>(row, 'rawLog', 'raw_log') ?? null,
    trackOnly: Boolean(pick<boolean>(row, 'trackOnly', 'track_only')),
    tenantId: pick<number | null>(row, 'tenantId', 'tenant_id') ?? null,
    // GET /ip-events rows carry the reporting tenant's name (W10-5).
    tenantName: pick<string | null>(row, 'tenantName', 'tenant_name') ?? null,
    createdAt: String(pick<string>(row, 'createdAt', 'created_at') ?? row.timestamp ?? ''),
    sourceAgentId: pick<number | null>(row, 'sourceAgentId', 'source_agent_id') ?? null,
    sourceIpType: pick<'lan' | 'wan' | null>(row, 'sourceIpType', 'source_ip_type') ?? null,
  };
}

/** Address part of a stored ban / whitelist target ("1.2.3.4/32" -> "1.2.3.4"). */
export function targetHost(value: string): string {
  const slash = value.indexOf('/');
  return slash < 0 ? value : value.slice(0, slash);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/**
 * True when a stored target (address or CIDR, with an optional explicit
 * prefix) covers `ip`. Addresses compare case-insensitively (IPv6 hex);
 * IPv6 ranges are trusted to the server's inet search (exact / containment).
 */
export function targetCovers(target: string, ip: string, prefix?: number | null): boolean {
  const host = targetHost(target);
  if (host.toLowerCase() === ip.toLowerCase()) return true;
  const slash = target.indexOf('/');
  const bits = prefix ?? (slash < 0 ? null : Number(target.slice(slash + 1)));
  if (bits == null || !Number.isFinite(bits)) return false;
  const a = ipv4ToInt(host);
  const b = ipv4ToInt(ip);
  if (a === null || b === null) return host.includes(':') && ip.includes(':');
  if (bits <= 0) return true;
  if (bits >= 32) return a === b;
  const size = 2 ** (32 - bits);
  return Math.floor(a / size) === Math.floor(b / size);
}

/**
 * IP-centric calls of the IP Reputation hub and of the unified IP detail
 * drawer. Ban / whitelist writes never send a scope: the server derives it
 * from the operating tenant (Default = global, any other tenant = local), and
 * a Lift from a non-Default tenant is a local exclusion (ban.service lift()).
 */
export const ipReputationApi = {
  async list(params: ReputationListParams = {}): Promise<ReputationListResult> {
    const { tenantIds, ...rest } = params;
    const query: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== null && v !== '') query[k] = v as string | number;
    }
    if (tenantIds && tenantIds.length > 0) query.tenants = [...tenantIds].sort((a, b) => a - b).join(',');
    const res = await apiClient.get<ApiResponse<IpReputationRow[]> & { total: number }>('/ip-reputation', { params: query });
    return { data: res.data.data ?? [], total: res.data.total ?? 0 };
  },

  /** Detail of one IP; null when the server knows nothing about it (404). */
  async getDetail(ip: string): Promise<IpDetail | null> {
    try {
      const res = await apiClient.get<ApiResponse<{ reputation: IpReputation | null; recentEvents?: RawEvent[] }>>(
        `/ip-reputation/${encodeURIComponent(ip)}`,
      );
      const data = res.data.data;
      if (!data) return null;
      return { reputation: data.reputation ?? null, recentEvents: (data.recentEvents ?? []).map(normaliseEvent) };
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 404) return null;
      throw err;
    }
  },

  /** Most recent events of one IP (newest first, capped server-side). */
  async eventsByIp(ip: string): Promise<IpEvent[]> {
    const res = await apiClient.get<ApiResponse<RawEvent[]>>(`/ip-events/${encodeURIComponent(ip)}`);
    return (res.data.data ?? []).map(normaliseEvent);
  },

  /**
   * Every visible ban (active, expired, lifted) covering `ip`, newest first.
   * `state=all` for the Bans list API, `active=false` for the legacy one; the
   * rows are re-checked here so a substring search never leaks a neighbour.
   */
  async banHistory(ip: string): Promise<IpBanHistoryItem[]> {
    const res = await apiClient.get<ApiResponse<IpBanHistoryItem[]>>('/bans', {
      params: { search: ip, state: 'all', active: 'false', page: 1, pageSize: 50 },
    });
    return (res.data.data ?? []).filter((b) => targetCovers(b.ip, ip, b.cidrPrefix));
  },

  /** Whitelist entries covering `ip` (CIDR ranges included), with the delete right. */
  async whitelistEntries(ip: string): Promise<IpWhitelist[]> {
    const res = await apiClient.get<ApiResponse<IpWhitelist[]>>('/whitelist', { params: { ip } });
    return res.data.data ?? [];
  },

  async add(data: AddIpReputationRequest): Promise<void> {
    await apiClient.post<ApiResponse<unknown>>('/ip-reputation', data);
  },

  /** Clear the suspicious flag: global for a platform admin on Default, else for the tenant. */
  async clear(ip: string): Promise<void> {
    await apiClient.post<ApiResponse<unknown>>(`/ip-reputation/${encodeURIComponent(ip)}/clear`);
  },

  async ban(ip: string, reason: string | null): Promise<IpBan> {
    const res = await apiClient.post<ApiResponse<IpBan>>('/bans', { ip, reason });
    return res.data.data!;
  },

  /** The single Lift: global from Default, a local exclusion from any other tenant. */
  async lift(banId: number): Promise<void> {
    await apiClient.delete(`/bans/${banId}`);
  },

  /** Undo a local exclusion (the global ban is enforced on this tenant again). */
  async removeExclusion(banId: number): Promise<void> {
    await apiClient.delete(`/bans/${banId}/exclude`);
  },

  /** Default tenant only: turn a local ban into a global one. */
  async promote(banId: number): Promise<void> {
    await apiClient.post(`/bans/${banId}/promote-global`);
  },

  async whitelist(ip: string, label: string | null): Promise<IpWhitelist> {
    const res = await apiClient.post<ApiResponse<IpWhitelist>>('/whitelist', { ip, label });
    return res.data.data!;
  },

  async removeWhitelist(id: number): Promise<void> {
    await apiClient.delete(`/whitelist/${id}`);
  },

  async bulkBan(ips: string[]): Promise<BulkBanResult> {
    const res = await apiClient.post<BulkBanResult>('/bans/bulk-ban', { ips });
    return res.data;
  },

  async bulkWhitelist(ips: string[], label?: string): Promise<BulkWhitelistResult> {
    const res = await apiClient.post<BulkWhitelistResult>('/bans/bulk-whitelist', { ips, label: label || undefined });
    return res.data;
  },
};

/** Server error message of a failed call (e.g. the 403 / 409 explanations), else `fallback`. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof msg === 'string' && msg.trim() !== '' ? msg : fallback;
}
