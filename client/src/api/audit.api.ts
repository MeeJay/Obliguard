import apiClient from './client';
import type { ApiResponse } from '@obliview/shared';

/** One audit_logs row (server/src/services/audit.service.ts AuditLogRow). */
export interface AuditLogRow {
  id: number;
  /** Owning tenant; null = instance-level row (Default god view only). */
  tenantId: number | null;
  tenantName: string | null;
  userId: number | null;
  /** Actor name snapshot (attempted name of a failed login, `app:<name>` for a sibling app). */
  username: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  deviceId: number | null;
  deviceName: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  success: boolean;
  createdAt: string;
}

export interface AuditLogFilters {
  /** Exact action, or a prefix ending with '.' ("bans." = every ban action). */
  action?: string;
  /** Actor: username substring. */
  actor?: string;
  targetType?: string;
  targetId?: string;
  deviceId?: number;
  success?: boolean;
  /** ISO dates. */
  from?: string;
  to?: string;
  /** Free text over actor, target, IP and details. */
  search?: string;
  /** God view only: rows of these tenants (ignored outside Default). */
  tenantIds?: number[];
  page?: number;
  pageSize?: number;
}

export interface AuditLogPage {
  items: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
}

function toParams(f: AuditLogFilters): Record<string, string | number> {
  const p: Record<string, string | number> = {};
  if (f.action) p.action = f.action;
  if (f.actor) p.actor = f.actor;
  if (f.targetType) p.targetType = f.targetType;
  if (f.targetId) p.targetId = f.targetId;
  if (f.deviceId) p.deviceId = f.deviceId;
  if (typeof f.success === 'boolean') p.success = String(f.success);
  if (f.from) p.from = f.from;
  if (f.to) p.to = f.to;
  if (f.search) p.search = f.search;
  if (f.tenantIds && f.tenantIds.length > 0) p.tenants = f.tenantIds.join(',');
  if (f.page) p.page = f.page;
  if (f.pageSize) p.pageSize = f.pageSize;
  return p;
}

export const auditApi = {
  /** GET /audit-log (audit.read; Default = every tenant + instance rows). */
  async list(filters: AuditLogFilters = {}): Promise<AuditLogPage> {
    const res = await apiClient.get<ApiResponse<AuditLogPage>>('/audit-log', { params: toParams(filters) });
    return res.data.data ?? { items: [], total: 0, page: 1, pageSize: filters.pageSize ?? 50 };
  },

  /** Actions present in the readable rows (filter dropdown). */
  async distinctActions(tenantIds?: number[]): Promise<string[]> {
    const params = tenantIds && tenantIds.length > 0 ? { tenants: tenantIds.join(',') } : undefined;
    const res = await apiClient.get<ApiResponse<string[]>>('/audit-log/distinct-actions', { params });
    return res.data.data ?? [];
  },

  /** Latest rows of one agent (agent detail Activity tab). */
  async byDevice(deviceId: number, limit = 100): Promise<AuditLogRow[]> {
    const res = await apiClient.get<ApiResponse<AuditLogRow[]>>(`/audit-log/device/${deviceId}`, { params: { limit } });
    return res.data.data ?? [];
  },

  /** Purge (platform admin, Default tenant): rows older than N days, 0 = all of the selected tenants. */
  async purge(olderThanDays: number, tenantIds?: number[]): Promise<{ deleted: number }> {
    const params: Record<string, string | number> = { olderThanDays };
    if (tenantIds && tenantIds.length > 0) params.tenants = tenantIds.join(',');
    const res = await apiClient.delete<ApiResponse<{ deleted: number }>>('/audit-log', { params });
    return res.data.data ?? { deleted: 0 };
  },
};
