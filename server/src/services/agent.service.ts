import type { Server as SocketIOServer } from 'socket.io';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db';
import { obliguardHub } from './obliguardHub.service';
import type {
  AgentApiKey,
  AgentDevice,
  AgentDisplayConfig,
  AgentGlobalConfig,
  AgentGroupConfig,
  AgentThresholds,
  NotificationTypeConfig,
  ObliguardPushBody,
  ObliguardPushResponse,
  AgentServiceConfig,
  AgentIpEvent,
  RateLimitRule,
} from '@obliview/shared';
import {
  DEFAULT_AGENT_THRESHOLDS,
  DEFAULT_AGENT_GLOBAL_CONFIG,
  SOCKET_EVENTS,
} from '@obliview/shared';
import { appConfigService } from './appConfig.service';
import { notificationService } from './notification.service';
import { logger } from '../utils/logger';
import { obligateService } from './obligate.service';
import { whitelistService } from './whitelist.service';
import { banService } from './ban.service';
import { ipReputationService } from './ipReputation.service';
import { serviceTemplateService } from './serviceTemplate.service';

// ── MikroTik online detection ────────────────────────────────
// A MikroTik device is considered online if we received a syslog packet
// or had a successful API connection within the last 5 minutes.
const MIKROTIK_ONLINE_TIMEOUT_MS = 5 * 60 * 1000;
const mikrotikLastSeen = new Map<number, number>(); // deviceId → timestamp ms
// Track whether a device has EVER been seen (syslog or API)
const mikrotikEverSeen = new Set<number>();

/** Mark a MikroTik device as seen (called from syslog listener and API test). */
export function markMikrotikSeen(deviceId: number): void {
  mikrotikLastSeen.set(deviceId, Date.now());
  mikrotikEverSeen.add(deviceId);
}

function isMikrotikOnline(deviceId: number): boolean {
  const last = mikrotikLastSeen.get(deviceId);
  if (!last) return false;
  return (Date.now() - last) < MIKROTIK_ONLINE_TIMEOUT_MS;
}

function getMikrotikStatus(deviceId: number, dbLastSyslog?: Date | null, dbLastApi?: Date | null): 'online' | 'offline' | 'misconfigured' {
  // Check in-memory first (most recent)
  if (isMikrotikOnline(deviceId)) return 'online';

  // Misconfigured = syslog never received OR API never succeeded
  const everSyslog = mikrotikEverSeen.has(deviceId) || !!dbLastSyslog;
  const everApi = !!dbLastApi;
  if (!everSyslog || !everApi) return 'misconfigured';

  // Both worked at some point but not recently → offline
  return 'offline';
}

// ── RFC-1918 helper ─────────────────────────────────────────
function isRfc1918(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// ── Socket.io instance (set from index.ts) ──────────────────
let _io: SocketIOServer | null = null;
export function setAgentServiceIO(io: SocketIOServer): void {
  _io = io;
}
export function getAgentServiceIO(): SocketIOServer | null {
  return _io;
}

// ============================================================
// Row ↔ Model helpers
// ============================================================

interface AgentApiKeyRow {
  id: number;
  name: string;
  key: string;
  created_by: number | null;
  created_at: Date;
  last_used_at: Date | null;
  device_count?: string | number;
}

interface AgentDeviceRow {
  id: number;
  uuid: string;
  hostname: string;
  name: string | null;
  ip: string | null;
  os_info: unknown;
  agent_version: string | null;
  api_key_id: number | null;
  status: string;
  heartbeat_monitoring: boolean;
  check_interval_seconds: number;
  agent_max_missed_pushes: number | null;  // migration 021
  approved_by: number | null;
  approved_at: Date | null;
  group_id: number | null;
  created_at: Date;
  updated_at: Date;
  // migration 025
  sensor_display_names: unknown;
  // migration 026
  override_group_settings: boolean;
  // migration 032
  display_config: unknown;
  // migration 033
  pending_command: string | null;
  uninstall_commanded_at: Date | null;
  // migration 039
  tenant_id: number;
  // migration 040
  updating_since: Date | null;
  // migration 042
  notification_types: unknown;
  // migration 004 (Obliguard)
  last_threat_at: Date | null;
  last_attack_at: Date | null;
  // migration 005 (Obliguard)
  wan_matching_enabled: boolean;
  // migration 023 (Obliguard) — evaluate-only / dry-run mode
  evaluate_only?: boolean;
  // migration 017 (MikroTik)
  device_type: string;
  // Joined from mikrotik_credentials (nullable — only present for MikroTik devices)
  mt_last_syslog_at?: Date | null;
  mt_last_api_connected_at?: Date | null;
}

function rowToApiKey(row: AgentApiKeyRow): AgentApiKey {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    deviceCount: row.device_count ? Number(row.device_count) : undefined,
  };
}

function rowToDevice(
  row: AgentDeviceRow,
  groupConfig?: AgentGroupConfig | null,
  groupThresholds?: AgentThresholds | null,
  globalConfig?: AgentGlobalConfig | null,
  evalState?: { evaluateOnly: boolean; source: 'agent' | 'group' | null },
): AgentDevice {
  const override = row.override_group_settings ?? false;

  // Effective evaluate-only: explicit evalState (resolved with group ancestry)
  // wins; otherwise fall back to the device's own flag so at least a direct
  // device-level setting is reflected even without ancestry resolution.
  const evaluateOnly = evalState?.evaluateOnly ?? (row.evaluate_only ?? false);
  const evaluateOnlySource: 'agent' | 'group' | null =
    evalState !== undefined ? evalState.source : (row.evaluate_only ? 'agent' : null);

  // Global defaults (fall through when group/device have no override)
  const globalCIS = globalConfig?.checkIntervalSeconds ?? DEFAULT_AGENT_GLOBAL_CONFIG.checkIntervalSeconds;
  const globalMMP = globalConfig?.maxMissedPushes     ?? DEFAULT_AGENT_GLOBAL_CONFIG.maxMissedPushes;

  // checkIntervalSeconds: when overrideGroupSettings=true use device value; else group → global → default
  const resolvedCIS = override
    ? row.check_interval_seconds
    : (groupConfig?.pushIntervalSeconds ?? globalCIS);

  // maxMissedPushes: null at device level = inherit from group → global → default
  const deviceMMP = row.agent_max_missed_pushes ?? null;
  const resolvedMMP = deviceMMP !== null
    ? deviceMMP
    : (groupConfig?.maxMissedPushes ?? globalMMP);

  const resolvedSettings: AgentDevice['resolvedSettings'] = {
    checkIntervalSeconds: resolvedCIS,
    heartbeatMonitoring:  false,  // Obliguard: heartbeat monitoring removed
    maxMissedPushes:      resolvedMMP,
  };

  return {
    id: row.id,
    uuid: row.uuid,
    hostname: row.hostname,
    tenantId: row.tenant_id as number,
    name: row.name ?? null,
    ip: row.ip,
    osInfo: typeof row.os_info === 'string' ? JSON.parse(row.os_info) : (row.os_info as AgentDevice['osInfo']),
    agentVersion: row.agent_version,
    apiKeyId: row.api_key_id,
    status: row.status as AgentDevice['status'],
    heartbeatMonitoring: row.heartbeat_monitoring ?? true,
    checkIntervalSeconds: row.check_interval_seconds,
    maxMissedPushes: deviceMMP,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    groupId: row.group_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sensorDisplayNames: (row.sensor_display_names as Record<string, string> | null) ?? null,
    overrideGroupSettings: override,
    resolvedSettings,
    groupSettings: groupConfig ?? null,
    groupThresholds: groupThresholds ?? null,
    displayConfig: (typeof row.display_config === 'string'
      ? JSON.parse(row.display_config)
      : (row.display_config as AgentDisplayConfig | null)) ?? null,
    pendingCommand: row.pending_command ?? null,
    uninstallCommandedAt: row.uninstall_commanded_at ? row.uninstall_commanded_at.toISOString() : null,
    updatingSince: row.updating_since ? row.updating_since.toISOString() : null,
    notificationTypes: row.notification_types
      ? (typeof row.notification_types === 'string'
          ? JSON.parse(row.notification_types)
          : row.notification_types as NotificationTypeConfig)
      : null,
    lastThreatAt: row.last_threat_at ? row.last_threat_at.toISOString() : null,
    lastAttackAt: row.last_attack_at ? row.last_attack_at.toISOString() : null,
    wanMatchingEnabled: row.wan_matching_enabled ?? false,
    wsConnected: row.device_type === 'mikrotik'
      ? isMikrotikOnline(row.id)
      : obliguardHub.isConnected(row.uuid),
    evaluateOnly,
    evaluateOnlySource,
    deviceType: (row.device_type as 'agent' | 'mikrotik') ?? 'agent',
    ...(row.device_type === 'mikrotik' ? {
      mikrotikStatus: getMikrotikStatus(row.id, row.mt_last_syslog_at, row.mt_last_api_connected_at),
    } : {}),
  };
}

/** Fetch the agent_group_config for a group (null if group not found or has no config). */
async function getGroupAgentConfig(groupId: number): Promise<AgentGroupConfig | null> {
  const g = await db('monitor_groups').where({ id: groupId }).select('agent_group_config').first() as
    { agent_group_config: unknown } | undefined;
  if (!g?.agent_group_config) return null;
  return (typeof g.agent_group_config === 'string'
    ? JSON.parse(g.agent_group_config)
    : g.agent_group_config) as AgentGroupConfig;
}

/** Fetch the agent_thresholds for a group (null if group not found or has none). */
async function getGroupAgentThresholds(groupId: number): Promise<AgentThresholds | null> {
  const g = await db('monitor_groups').where({ id: groupId }).select('agent_thresholds').first() as
    { agent_thresholds: unknown } | undefined;
  if (!g?.agent_thresholds) return null;
  return (typeof g.agent_thresholds === 'string'
    ? JSON.parse(g.agent_thresholds)
    : g.agent_thresholds) as AgentThresholds;
}

/**
 * Returns the set of group IDs that resolve to evaluate-only — i.e. the group
 * itself OR any ancestor has evaluate_only=true (walked via group_closure).
 * A device whose group_id is in this set inherits evaluate-only (dry-run) mode.
 * One lookup serves a whole device list, avoiding per-device ancestry queries.
 */
async function getEvaluateOnlyGroupIds(): Promise<Set<number>> {
  const flagged = await db('monitor_groups').where('evaluate_only', true).pluck('id') as number[];
  if (flagged.length === 0) return new Set<number>();
  const descendants = await db('group_closure')
    .whereIn('ancestor_id', flagged)
    .pluck('descendant_id') as number[];
  return new Set<number>(descendants);
}

/** Resolve the effective evaluate-only state for a device row given the eval group set. */
function evalStateFor(
  row: AgentDeviceRow,
  evalGroupIds: Set<number>,
): { evaluateOnly: boolean; source: 'agent' | 'group' | null } {
  if (row.evaluate_only) return { evaluateOnly: true, source: 'agent' };
  if (row.group_id != null && evalGroupIds.has(row.group_id)) {
    return { evaluateOnly: true, source: 'group' };
  }
  return { evaluateOnly: false, source: null };
}

// ============================================================
// Agent Service
// ============================================================

export const agentService = {

  // ── API Keys ────────────────────────────────────────────

  async listKeys(tenantId: number): Promise<AgentApiKey[]> {
    const rows = await db('agent_api_keys as k')
      .leftJoin('agent_devices as d', 'k.id', 'd.api_key_id')
      .where({ 'k.tenant_id': tenantId })
      .groupBy('k.id')
      .select('k.*', db.raw('COUNT(d.id) as device_count'))
      .orderBy('k.created_at', 'desc') as AgentApiKeyRow[];
    return rows.map(rowToApiKey);
  },

  async createKey(name: string, createdBy: number, tenantId: number): Promise<AgentApiKey> {
    const [row] = await db('agent_api_keys')
      .insert({ name, created_by: createdBy, tenant_id: tenantId })
      .returning('*') as AgentApiKeyRow[];
    return rowToApiKey(row);
  },

  async deleteKey(id: number): Promise<boolean> {
    const count = await db('agent_api_keys').where({ id }).del();
    return count > 0;
  },

  /**
   * Returns the raw key string for a key id, scoped to the tenant — used by the
   * offline-wizard download endpoints to bake the key into the installer. Never
   * exposes a key the caller couldn't already see via listKeys (same tenant scope).
   */
  async getKeyById(id: number, tenantId: number): Promise<string | null> {
    const row = await db('agent_api_keys')
      .where({ id, tenant_id: tenantId })
      .first() as { key: string } | undefined;
    return row?.key ?? null;
  },

  // ── Devices ─────────────────────────────────────────────

  async listDevices(tenantId: number, status?: AgentDevice['status']): Promise<AgentDevice[]> {
    // LEFT JOIN to fetch agent_group_config in one round-trip so resolvedSettings
    // can be computed without N+1 queries.
    const [rows, globalConfig, evalGroupIds] = await Promise.all([
      (async () => {
        const query = db('agent_devices as d')
          .leftJoin('monitor_groups as g', 'g.id', 'd.group_id')
          .leftJoin('mikrotik_credentials as mt', 'mt.device_id', 'd.id')
          .where({ 'd.tenant_id': tenantId })
          .select(
            'd.*',
            db.raw('g.agent_group_config as _group_agent_config'),
            db.raw('g.agent_thresholds as _group_agent_thresholds'),
            db.raw('g.name as _group_name'),
            db.raw('mt.last_syslog_at as mt_last_syslog_at'),
            db.raw('mt.last_api_connected_at as mt_last_api_connected_at'),
          )
          .orderBy('d.created_at', 'desc');
        if (status) query.where({ 'd.status': status });
        return query as Promise<(AgentDeviceRow & { _group_agent_config: unknown; _group_agent_thresholds: unknown; _group_name: string | null })[]>;
      })(),
      appConfigService.getAgentGlobal(),
      getEvaluateOnlyGroupIds(),
    ]);
    return rows.map((r) => {
      const gc = r._group_agent_config
        ? (typeof r._group_agent_config === 'string'
          ? JSON.parse(r._group_agent_config)
          : r._group_agent_config) as AgentGroupConfig
        : null;
      const gt = r._group_agent_thresholds
        ? (typeof r._group_agent_thresholds === 'string'
          ? JSON.parse(r._group_agent_thresholds)
          : r._group_agent_thresholds) as AgentThresholds
        : null;
      const dev = rowToDevice(r, gc, gt, globalConfig, evalStateFor(r, evalGroupIds));
      (dev as AgentDevice & { groupName?: string | null }).groupName = r._group_name ?? null;
      return dev;
    });
  },

  async getDeviceById(id: number): Promise<AgentDevice | null> {
    const row = await db('agent_devices as d')
      .leftJoin('mikrotik_credentials as mt', 'mt.device_id', 'd.id')
      .where({ 'd.id': id })
      .select(
        'd.*',
        db.raw('mt.last_syslog_at as mt_last_syslog_at'),
        db.raw('mt.last_api_connected_at as mt_last_api_connected_at'),
      )
      .first() as AgentDeviceRow | undefined;
    if (!row) return null;
    const [groupConfig, groupThresholds, globalConfig, evalGroupIds] = await Promise.all([
      row.group_id ? getGroupAgentConfig(row.group_id) : null,
      row.group_id ? getGroupAgentThresholds(row.group_id) : null,
      appConfigService.getAgentGlobal(),
      getEvaluateOnlyGroupIds(),
    ]);
    return rowToDevice(row, groupConfig, groupThresholds, globalConfig, evalStateFor(row, evalGroupIds));
  },

  async countOnlineDevices(tenantId: number): Promise<number> {
    const [row] = await db('agent_devices')
      .where({ tenant_id: tenantId, status: 'approved' })
      .count<Array<{ count: string }>>({ count: '*' });
    return Number(row?.count ?? 0);
  },

  async getDeviceByUuid(uuid: string): Promise<AgentDevice | null> {
    const row = await db('agent_devices').where({ uuid }).first() as AgentDeviceRow | undefined;
    if (!row) return null;
    const [groupConfig, groupThresholds, globalConfig, evalGroupIds] = await Promise.all([
      row.group_id ? getGroupAgentConfig(row.group_id) : null,
      row.group_id ? getGroupAgentThresholds(row.group_id) : null,
      appConfigService.getAgentGlobal(),
      getEvaluateOnlyGroupIds(),
    ]);
    return rowToDevice(row, groupConfig, groupThresholds, globalConfig, evalStateFor(row, evalGroupIds));
  },

  async updateDevice(id: number, data: {
    status?: AgentDevice['status'];
    groupId?: number | null;
    checkIntervalSeconds?: number;
    maxMissedPushes?: number | null;
    approvedBy?: number;
    approvedAt?: Date;
    name?: string | null;
    heartbeatMonitoring?: boolean;
    sensorDisplayNames?: Record<string, string> | null;
    overrideGroupSettings?: boolean;
    displayConfig?: AgentDisplayConfig | null;
    notificationTypes?: NotificationTypeConfig | null;
    wanMatchingEnabled?: boolean;
    evaluateOnly?: boolean;
  }): Promise<AgentDevice | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.status !== undefined) update.status = data.status;
    if (data.groupId !== undefined) update.group_id = data.groupId;
    if (data.checkIntervalSeconds !== undefined) update.check_interval_seconds = data.checkIntervalSeconds;
    if (data.maxMissedPushes !== undefined) update.agent_max_missed_pushes = data.maxMissedPushes;
    if (data.approvedBy !== undefined) update.approved_by = data.approvedBy;
    if (data.approvedAt !== undefined) update.approved_at = data.approvedAt;
    if (data.name !== undefined) update.name = data.name;
    if (data.heartbeatMonitoring !== undefined) update.heartbeat_monitoring = data.heartbeatMonitoring;
    if (data.sensorDisplayNames !== undefined) update.sensor_display_names = data.sensorDisplayNames;
    if (data.overrideGroupSettings !== undefined) update.override_group_settings = data.overrideGroupSettings;
    if (data.displayConfig !== undefined) update.display_config = data.displayConfig;
    if ('notificationTypes' in data) update.notification_types = data.notificationTypes
      ? JSON.stringify(data.notificationTypes)
      : null;
    if (data.wanMatchingEnabled !== undefined) update.wan_matching_enabled = data.wanMatchingEnabled;
    if (data.evaluateOnly !== undefined) update.evaluate_only = data.evaluateOnly;

    const [row] = await db('agent_devices')
      .where({ id })
      .update(update)
      .returning('*') as AgentDeviceRow[];
    if (!row) return null;
    const [groupConfig, groupThresholds, globalConfig, evalGroupIds] = await Promise.all([
      row.group_id ? getGroupAgentConfig(row.group_id) : null,
      row.group_id ? getGroupAgentThresholds(row.group_id) : null,
      appConfigService.getAgentGlobal(),
      getEvaluateOnlyGroupIds(),
    ]);
    const device = rowToDevice(row, groupConfig, groupThresholds, globalConfig, evalStateFor(row, evalGroupIds));

    // Broadcast so the sidebar can update name/status/group without polling
    if (_io) {
      _io.to('role:admin').emit(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, {
        deviceId: device.id,
        name: device.name,
        hostname: device.hostname,
        status: device.status,
        groupId: device.groupId,
      });
    }

    return device;
  },

  async deleteDevice(id: number): Promise<boolean> {
    const count = await db('agent_devices').where({ id }).del();
    return count > 0;
  },

  // ── Bulk operations ──────────────────────────────────────────────────────

  async bulkDeleteDevices(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await db('agent_devices').whereIn('id', ids).del();
    // Broadcast deletion events so the frontend updates in real-time
    if (_io) {
      for (const id of ids) {
        _io.to('role:admin').emit(SOCKET_EVENTS.AGENT_DEVICE_DELETED, { deviceId: id });
      }
    }
  },

  async bulkUpdateDevices(ids: number[], data: {
    groupId?: number | null;
    heartbeatMonitoring?: boolean;
    overrideGroupSettings?: boolean;
    status?: 'approved' | 'suspended';
  }): Promise<void> {
    if (ids.length === 0) return;
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.groupId !== undefined)             update.group_id               = data.groupId;
    if (data.heartbeatMonitoring !== undefined)  update.heartbeat_monitoring   = data.heartbeatMonitoring;
    if (data.overrideGroupSettings !== undefined) update.override_group_settings = data.overrideGroupSettings;
    if (data.status !== undefined)               update.status                 = data.status;
    await db('agent_devices').whereIn('id', ids).update(update);
    // Notify frontend of each updated device
    if (_io) {
      for (const id of ids) {
        _io.to('role:admin').emit(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, { deviceId: id });
      }
    }
  },

  /** Queue a command to be delivered to a device on its next push. */
  async sendCommand(id: number, command: string): Promise<boolean> {
    const count = await db('agent_devices')
      .where({ id })
      .update({ pending_command: command, updated_at: new Date() });
    return count > 0;
  },

  /** Queue a command for multiple devices at once. */
  async bulkSendCommand(ids: number[], command: string): Promise<void> {
    if (ids.length === 0) return;
    await db('agent_devices')
      .whereIn('id', ids)
      .update({ pending_command: command, updated_at: new Date() });
  },

  /**
   * Cleanup job: auto-delete devices whose 'uninstall' command was delivered
   * more than 10 minutes ago (they've had enough time to uninstall and stop pushing).
   * Should be called periodically (e.g. every 5 minutes).
   */
  async cleanupUninstalledDevices(): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const rows = await db('agent_devices')
      .whereNotNull('uninstall_commanded_at')
      .where('uninstall_commanded_at', '<', cutoff)
      .select('id') as { id: number }[];

    if (rows.length === 0) return;

    const ids = rows.map(r => r.id);
    await this.bulkDeleteDevices(ids);
    logger.info(`Agent cleanup: auto-deleted ${ids.length} device(s) after uninstall command.`);
  },

  /** Suspend a device: set status=suspended */
  async suspendDevice(id: number): Promise<void> {
    await db('agent_devices').where({ id }).update({ status: 'suspended', updated_at: new Date() });
  },

  /** Reinstate a suspended device: set status=approved */
  async reinstateDevice(id: number): Promise<void> {
    await db('agent_devices').where({ id }).update({ status: 'approved', updated_at: new Date() });
  },

  // ── Approval ─────────────────────────────────────────────

  /**
   * Approve a device: set status=approved, create ONE monitor with all thresholds.
   */
  async approveDevice(
    deviceId: number,
    approvedBy: number,
    groupId: number | null,
    customThresholds?: AgentThresholds,
  ): Promise<AgentDevice | null> {
    const device = await this.getDeviceById(deviceId);
    if (!device) return null;

    // Update device status and reset interval to 60s on approval
    const updated = await this.updateDevice(deviceId, {
      status: 'approved',
      groupId,
      approvedBy,
      approvedAt: new Date(),
      checkIntervalSeconds: 60,
    });

    // Determine thresholds: custom > group defaults > system defaults
    let thresholds: AgentThresholds = { ...DEFAULT_AGENT_THRESHOLDS };
    if (groupId) {
      const groupRow = await db('monitor_groups')
        .where({ id: groupId })
        .select('agent_thresholds')
        .first() as { agent_thresholds: AgentThresholds | null } | undefined;
      if (groupRow?.agent_thresholds) {
        thresholds = groupRow.agent_thresholds;
      }
    }
    if (customThresholds) {
      thresholds = customThresholds;
    }

    return updated;
  },

  // ── Update device thresholds ─────────────────────────────
  // Thresholds in Obliguard are stored on the group or resolved from defaults.
  // This method is a no-op kept for API compatibility.
  async updateDeviceThresholds(
    _deviceId: number,
    _thresholds: AgentThresholds,
  ): Promise<boolean> {
    return true;
  },

  // ── Push endpoint logic ───────────────────────────────────

  async handlePush(
    agentApiKeyId: number,
    agentTenantId: number,
    deviceUuid: string,
    clientIp: string,
    body: ObliguardPushBody,
  ): Promise<ObliguardPushResponse> {
    // ── a. Find or register device ────────────────────────
    let device = await this.getDeviceByUuid(deviceUuid);

    if (!device) {
      // Register new device as pending
      const [row] = await db('agent_devices')
        .insert({
          uuid: deviceUuid,
          hostname: body.hostname,
          ip: clientIp,
          os_info: body.osInfo ? JSON.stringify(body.osInfo) : null,
          agent_version: body.agentVersion,
          api_key_id: agentApiKeyId,
          tenant_id: agentTenantId,
          status: 'pending',
          check_interval_seconds: 300, // pending: check every 5 min
        })
        .returning('*') as AgentDeviceRow[];
      device = rowToDevice(row);
    } else {
      // ── b. Update device metadata ─────────────────────
      // Clear updating_since if set (agent came back after update)
      const metadataUpdate: Record<string, unknown> = {
        hostname: body.hostname,
        ip: clientIp,
        agent_version: body.agentVersion,
        os_info: body.osInfo ? JSON.stringify(body.osInfo) : null,
        updated_at: new Date(),
      };
      if (device.updatingSince) {
        metadataUpdate.updating_since = null;
        logger.info(`Agent ${device.id} (${device.hostname}) came back online after update.`);
      }
      await db('agent_devices')
        .where({ id: device.id })
        .update(metadataUpdate);

      // Refresh device from DB
      device = (await this.getDeviceByUuid(deviceUuid))!;
    }

    // Register/update device UUID with Obligate for cross-app linking (non-blocking, idempotent)
    obligateService.registerDeviceLink(deviceUuid, `/agents/${device.id}`).catch(() => {});

    // ── c. Pending status ─────────────────────────────────
    if (device.status === 'pending') {
      return { status: 'pending' };
    }

    // ── d. Refused status ─────────────────────────────────
    if (device.status === 'refused') {
      return { status: 'refused' };
    }

    // Also treat suspended as refused — agent should stop pushing
    if (device.status === 'suspended') {
      return { status: 'refused' };
    }

    const deviceId = device.id;

    // ── e0. Rebuild LAN IP registry for this device ───────
    // agent_ips is a fast-lookup table: ip_address → agent_id (within tenant).
    // We delete + reinsert on every push so stale IPs (e.g. after NIC changes) are removed.
    if (body.lanIPs && body.lanIPs.length > 0) {
      try {
        await db('agent_ips').where({ agent_id: deviceId }).del();
        await db('agent_ips').insert(
          body.lanIPs.map((ip: string) => ({ agent_id: deviceId, ip_address: ip })),
        );
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to upsert agent_ips');
      }
    }

    // ── e. Process services ───────────────────────────────
    if (body.services && body.services.length > 0) {
      try {
        const serviceTypes = body.services.map(s => s.type);
        // Delete existing entries for only the reported service types, then insert fresh
        await db('agent_services')
          .where({ device_id: deviceId })
          .whereIn('service_type', serviceTypes)
          .del();
        await db('agent_services').insert(
          body.services.map(s => ({
            device_id: deviceId,
            service_type: s.type,
            port: s.port,
            active: s.active,
            last_seen_at: new Date(),
          })),
        );
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to upsert agent_services (table may not exist yet)');
      }
    }

    // ── f. Resolve group ancestry (needed for templates + ban delta) ──────
    let groupIds: number[] = [];
    if (device.groupId) {
      try {
        const groupRows = await db('group_closure')
          .where('descendant_id', device.groupId)
          .select('ancestor_id')
          .orderBy('depth', 'asc') as { ancestor_id: number }[];
        groupIds = groupRows.map(r => r.ancestor_id);
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to resolve group ancestry');
      }
    }

    // ── f2. Resolve templates for event tagging + opt-in gate ─────────────
    // Templates with mode='track' produce events stored for visibility but NOT
    // counted by BanEngine (trackOnlyServices). Services whose resolved template
    // is explicitly disabled (disabledServices) are dropped entirely — this is
    // the server-side half of the opt-in gate, a defense-in-depth for agents
    // that predate the client-side poller gate. We only drop services that have
    // a resolved-but-disabled template (never custom/unknown services), so an
    // intentional bind (enabled_override=true) always lets events through.
    const trackOnlyServices = new Set<string>();
    const disabledServices = new Set<string>();
    if (body.events && body.events.length > 0) {
      try {
        const resolved = await serviceTemplateService.resolveForAgent(deviceId, groupIds);
        for (const cfg of resolved) {
          if (cfg.enabled) {
            if (cfg.mode === 'track') trackOnlyServices.add(cfg.serviceType);
          } else {
            disabledServices.add(cfg.serviceType);
          }
        }
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to resolve service templates for track_only tagging');
      }
    }

    // ── f3. Build peer link lookup maps (LAN + WAN) ───────
    // Used to enrich ip_events with source_agent_id so the NetMap can draw
    // directed edges between agents instead of showing unknown IP nodes.
    //
    // LAN  — all agent_ips entries for this tenant (excluding self)
    // WAN  — all agent_devices with wan_matching_enabled=true + known WAN IP (excluding self)
    //
    // Ambiguity: if two agents share the same IP in the same tenant we store -1
    // (sentinel) and skip the link — this prevents false edges from NAT collisions.
    const lanIpToAgentId = new Map<string, number>(); // ip → agentId, -1 = ambiguous
    const wanIpToAgentId = new Map<string, number>();

    if (body.events && body.events.length > 0) {
      try {
        // LAN: join agent_ips with agent_devices to scope by tenant
        const lanRows = await db('agent_ips as ai')
          .join('agent_devices as ad', 'ad.id', 'ai.agent_id')
          .where({ 'ad.tenant_id': agentTenantId })
          .whereNot({ 'ai.agent_id': deviceId })
          .select('ai.ip_address', 'ai.agent_id') as { ip_address: string; agent_id: number }[];

        for (const row of lanRows) {
          if (lanIpToAgentId.has(row.ip_address)) {
            lanIpToAgentId.set(row.ip_address, -1); // ambiguous
          } else {
            lanIpToAgentId.set(row.ip_address, row.agent_id);
          }
        }

        // WAN: only devices with opt-in flag and a known public IP
        const wanRows = await db('agent_devices')
          .where({ tenant_id: agentTenantId, wan_matching_enabled: true })
          .whereNot({ id: deviceId })
          .whereNotNull('ip')
          .select('id', 'ip') as { id: number; ip: string }[];

        for (const row of wanRows) {
          if (wanIpToAgentId.has(row.ip)) {
            wanIpToAgentId.set(row.ip, -1); // ambiguous
          } else {
            wanIpToAgentId.set(row.ip, row.id);
          }
        }
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to build peer link maps');
      }
    }

    // ── g. Process events ─────────────────────────────────
    // Opt-in gate: drop events whose service has a resolved-but-disabled
    // template before any storage / reputation / live-map emission.
    const incomingEvents: AgentIpEvent[] = (body.events ?? []).filter(
      (ev: AgentIpEvent) => !disabledServices.has(ev.service),
    );
    if (incomingEvents.length > 0) {
      try {
        // Enrich each event with source_agent_id / source_ip_type
        const enrichedEvents = incomingEvents.map((ev: AgentIpEvent) => {
          let sourceAgentId: number | null = null;
          let sourceIpType: 'lan' | 'wan' | null = null;

          if (isRfc1918(ev.ip)) {
            const matchId = lanIpToAgentId.get(ev.ip);
            if (matchId !== undefined && matchId !== -1) {
              sourceAgentId = matchId;
              sourceIpType = 'lan';
            }
          } else {
            const matchId = wanIpToAgentId.get(ev.ip);
            if (matchId !== undefined && matchId !== -1) {
              sourceAgentId = matchId;
              sourceIpType = 'wan';
            }
          }

          return {
            device_id: deviceId,
            ip: ev.ip,
            username: ev.username ?? null,
            service: ev.service,
            event_type: ev.eventType,
            timestamp: new Date(ev.timestamp),
            raw_log: ev.rawLog ?? null,
            track_only: trackOnlyServices.has(ev.service),
            tenant_id: agentTenantId,
            source_agent_id: sourceAgentId,
            source_ip_type: sourceIpType,
          };
        });

        await db('ip_events').insert(enrichedEvents);

        // Update IP reputation from the new events
        await ipReputationService.upsertFromEvents(
          incomingEvents.map((ev: AgentIpEvent) => ({
            ip: ev.ip,
            service: ev.service,
            username: ev.username ?? null,
            deviceId,
            eventType: ev.eventType,
          })),
        );

        // ── Threat detection: check if any IPs from this push are now suspicious ──
        // If so, mark this device as "under threat" for the next 3 min.
        const failureIps = [...new Set(
          incomingEvents
            .filter(ev => ev.eventType === 'auth_failure')
            .map(ev => ev.ip),
        )];
        if (failureIps.length > 0) {
          try {
            // ip_reputation has no 'status' column — status is computed on the fly.
          // Use total_failures > 0 as a proxy for "suspicious / worse".
          const suspiciousRows = await db('ip_reputation')
              .whereIn('ip', failureIps)
              .where('total_failures', '>', 0)
              .select('ip')
              .limit(1);
            if (suspiciousRows.length > 0) {
              await db('agent_devices').where({ id: deviceId }).update({ last_threat_at: new Date() });
              const deviceLabel = (await db('agent_devices').where({ id: deviceId }).select('name', 'hostname').first() as { name: string | null; hostname: string } | undefined);
              const label = deviceLabel?.name ?? deviceLabel?.hostname ?? String(deviceId);
              notificationService.sendForAgent(deviceId, label, 'threat', 'ok', [], 'threat').catch(
                (err) => logger.warn({ err, deviceId }, 'Failed to send threat notification'),
              );
            }
          } catch (err) {
            logger.warn({ err, deviceId }, 'handlePush: failed to check threat status');
          }
        }

        // Emit real-time connection events to the live threat map
        // One event per unique IP (deduplicated per push cycle)
        if (_io) {
          const seen = new Set<string>();
          for (const enriched of enrichedEvents) {
            const key = `${enriched.ip}:${enriched.event_type}`;
            if (seen.has(key)) continue;
            seen.add(key);
            _io.emit('ip:flow', {
              ip: enriched.ip,
              service: enriched.service,
              eventType: enriched.event_type,  // 'auth_failure' | 'auth_success'
              deviceId,
              tenantId: agentTenantId,
              // Peer link enrichment
              sourceAgentId: enriched.source_agent_id,
              sourceIpType: enriched.source_ip_type,
            });
          }
        }
      } catch (err) {
        logger.warn({ err, deviceId }, 'handlePush: failed to insert ip_events');
      }

      // Handle log samples: clear sample_requested flag for each reported log path
      if (body.logSamples && Object.keys(body.logSamples).length > 0) {
        try {
          const logPaths = Object.keys(body.logSamples);
          await db('service_template_assignments')
            .where({ scope: 'agent', scope_id: deviceId })
            .whereIn('log_path_override', logPaths)
            .update({ sample_requested: false });
        } catch (err) {
          logger.warn({ err, deviceId }, 'handlePush: failed to clear sample_requested flags');
        }
      }
    }

    // ── h. Compute ban delta ──────────────────────────────

    let resolvedWhitelist: string[] = [];
    let banDelta: { add: string[]; remove: string[] } = { add: [], remove: [] };
    let resolvedRateLimits: RateLimitRule[] = [];

    try {
      resolvedWhitelist = await whitelistService.resolveWhitelistForAgent(
        deviceId,
        groupIds,
        agentTenantId,
      );
    } catch (err) {
      logger.warn({ err, deviceId }, 'handlePush: whitelistService.resolveWhitelistForAgent failed');
    }

    try {
      const { rateLimitPolicyService } = await import('./rateLimitPolicy.service');
      resolvedRateLimits = await rateLimitPolicyService.resolveForAgent(deviceId, groupIds, agentTenantId);
    } catch (err) {
      logger.warn({ err, deviceId }, 'handlePush: rateLimitPolicyService.resolveForAgent failed');
    }

    try {
      banDelta = await banService.computeBanDelta(
        deviceId,
        groupIds,
        agentTenantId,
        body.firewallBanned ?? [],
        resolvedWhitelist,
      );
    } catch (err) {
      logger.warn({ err, deviceId }, 'handlePush: banService.computeBanDelta failed');
    }

    // Evaluate-only (dry-run): this agent enforces NO bans. Override the delta to
    // add nothing and remove everything it currently has at the firewall, so the
    // observed traffic has zero network impact while whitelist rules are tuned.
    // (Ban CREATION from this agent's events is separately skipped in BanEngine.)
    if (device.evaluateOnly) {
      banDelta = { add: [], remove: body.firewallBanned ?? [] };
    }

    // ── h. Compute service configs ────────────────────────
    let serviceConfigsMap: Record<string, AgentServiceConfig> = {};
    try {
      const { serviceTemplateService } = await import('./serviceTemplate.service');
      const resolvedConfigs = await serviceTemplateService.resolveForAgent(deviceId, groupIds);
      for (const cfg of resolvedConfigs) {
        const key = cfg.serviceType === 'custom'
          ? `custom:${cfg.logPath ?? cfg.templateId}`
          : cfg.serviceType;
        serviceConfigsMap[key] = {
          enabled: cfg.enabled,
          threshold: cfg.threshold,
          windowSeconds: cfg.windowSeconds,
          customRegex: cfg.customRegex ?? undefined,
          sampleRequested: cfg.sampleRequested,
        };
      }
    } catch {
      // serviceTemplateService may not exist yet; return empty configs
      serviceConfigsMap = {};
    }

    // NOTE: intentionally NO auto-enable fallback here. Services are strictly
    // opt-in: an agent only watches / emits events for services that resolve to
    // an enabled template (global default, or a group/agent enabled_override).
    // The previous "auto-enable all detected services" fallback violated that
    // model (it silently turned on banning for every detected port), so it was
    // removed — no enabled template means the agent stays silent for that service.

    // ── i. Handle pending command ─────────────────────────
    let pendingCommand: string | undefined;
    if (device.pendingCommand) {
      pendingCommand = device.pendingCommand;
      const commandUpdate: Record<string, unknown> = { pending_command: null, updated_at: new Date() };
      if (pendingCommand === 'uninstall') {
        commandUpdate.uninstall_commanded_at = new Date();
      }
      await db('agent_devices').where({ id: deviceId }).update(commandUpdate);
    }

    // ── j. Update device last push time ──────────────────
    const pushTime = new Date();
    await db('agent_devices')
      .where({ id: deviceId })
      .update({ updated_at: pushTime });

    // Notify UI of push activity:
    // 1. agent:pushHeartbeat — lightweight heartbeat for AgentDetailPage online status
    // 2. AGENT_STATUS_CHANGED 'up' — updates the sidebar status dot
    if (_io) {
      _io.emit('agent:pushHeartbeat', {
        deviceId,
        updatedAt: pushTime.toISOString(),
        agentVersion: body.agentVersion ?? device.agentVersion,
      });
      _io.emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, {
        deviceId,
        status: 'up',
        wsConnected: true,
        violations: [],
        violationKeys: [],
      });
    }

    // ── k. Return ObliguardPushResponse ──────────────────
    return {
      status: 'ok',
      latestVersion: this.getAgentVersion().version,
      config: { pushIntervalSeconds: device.resolvedSettings.checkIntervalSeconds },
      banList: { add: banDelta.add, remove: banDelta.remove },
      whitelist: resolvedWhitelist,
      services: serviceConfigsMap,
      rateLimits: resolvedRateLimits,
      command: pendingCommand ?? '',
    };
  },

  // ── Events-only flush (WS real-time path) ─────────────────
  //
  // Called by obliguardHub when the agent sends a `{ type:"events" }` frame
  // between heartbeats (500 ms debounce).  Runs the same enrichment + insert
  // pipeline as handlePush but skips the heavy per-push bookkeeping (LAN-IP
  // rebuild, ban-delta, service-config sync) that only needs to run every 30 s.

  async processEventsFlush(
    deviceId: number,
    tenantId: number,
    events: AgentIpEvent[],
  ): Promise<void> {
    if (events.length === 0) return;

    // Resolve group ancestry (needed for track-only and peer-link lookups)
    let groupIds: number[] = [];
    try {
      const row = await db('agent_devices').where({ id: deviceId }).select('group_id').first() as
        { group_id: number | null } | undefined;
      if (row?.group_id) {
        const groupRows = await db('group_closure')
          .where('descendant_id', row.group_id)
          .select('ancestor_id')
          .orderBy('depth', 'asc') as { ancestor_id: number }[];
        groupIds = groupRows.map(r => r.ancestor_id);
      }
    } catch (err) {
      logger.warn({ err, deviceId }, 'processEventsFlush: group ancestry lookup failed');
    }

    // Track-only + disabled service sets (same opt-in gate as handlePush)
    const trackOnlyServices = new Set<string>();
    const disabledServices = new Set<string>();
    try {
      const { serviceTemplateService } = await import('./serviceTemplate.service');
      const resolved = await serviceTemplateService.resolveForAgent(deviceId, groupIds);
      for (const cfg of resolved) {
        if (cfg.enabled) {
          if (cfg.mode === 'track') trackOnlyServices.add(cfg.serviceType);
        } else {
          disabledServices.add(cfg.serviceType);
        }
      }
    } catch { /* not yet configured — all services default to ban mode */ }

    // Opt-in gate: drop events whose service has a resolved-but-disabled template.
    const incomingEvents = events.filter((ev) => !disabledServices.has(ev.service));
    if (incomingEvents.length === 0) return;

    // Peer link maps (LAN + WAN) — same logic as handlePush
    const lanIpToAgentId = new Map<string, number>();
    const wanIpToAgentId = new Map<string, number>();
    try {
      const lanRows = await db('agent_ips as ai')
        .join('agent_devices as ad', 'ad.id', 'ai.agent_id')
        .where({ 'ad.tenant_id': tenantId })
        .whereNot({ 'ai.agent_id': deviceId })
        .select('ai.ip_address', 'ai.agent_id') as { ip_address: string; agent_id: number }[];
      for (const row of lanRows) {
        if (lanIpToAgentId.has(row.ip_address)) {
          lanIpToAgentId.set(row.ip_address, -1);
        } else {
          lanIpToAgentId.set(row.ip_address, row.agent_id);
        }
      }

      const wanRows = await db('agent_devices')
        .where({ tenant_id: tenantId, wan_matching_enabled: true })
        .whereNot({ id: deviceId })
        .whereNotNull('ip')
        .select('id', 'ip') as { id: number; ip: string }[];
      for (const row of wanRows) {
        if (wanIpToAgentId.has(row.ip)) {
          wanIpToAgentId.set(row.ip, -1);
        } else {
          wanIpToAgentId.set(row.ip, row.id);
        }
      }
    } catch (err) {
      logger.warn({ err, deviceId }, 'processEventsFlush: peer link lookup failed');
    }

    // Enrich + insert events
    try {
      const enrichedEvents = incomingEvents.map((ev: AgentIpEvent) => {
        let sourceAgentId: number | null = null;
        let sourceIpType: 'lan' | 'wan' | null = null;

        if (isRfc1918(ev.ip)) {
          const matchId = lanIpToAgentId.get(ev.ip);
          if (matchId !== undefined && matchId !== -1) {
            sourceAgentId = matchId;
            sourceIpType = 'lan';
          }
        } else {
          const matchId = wanIpToAgentId.get(ev.ip);
          if (matchId !== undefined && matchId !== -1) {
            sourceAgentId = matchId;
            sourceIpType = 'wan';
          }
        }

        return {
          device_id: deviceId,
          ip: ev.ip,
          username: ev.username ?? null,
          service: ev.service,
          event_type: ev.eventType,
          timestamp: new Date(ev.timestamp),
          raw_log: ev.rawLog ?? null,
          track_only: trackOnlyServices.has(ev.service),
          tenant_id: tenantId,
          source_agent_id: sourceAgentId,
          source_ip_type: sourceIpType,
        };
      });

      await db('ip_events').insert(enrichedEvents);

      await ipReputationService.upsertFromEvents(
        incomingEvents.map((ev: AgentIpEvent) => ({
          ip: ev.ip,
          service: ev.service,
          username: ev.username ?? null,
          deviceId,
          eventType: ev.eventType,
        })),
      );

      // Threat detection — same check as handlePush
      const failureIps = [...new Set(
        incomingEvents
          .filter((ev: AgentIpEvent) => ev.eventType === 'auth_failure')
          .map((ev: AgentIpEvent) => ev.ip),
      )];
      if (failureIps.length > 0) {
        const suspiciousRows = await db('ip_reputation')
          .whereIn('ip', failureIps)
          .where('total_failures', '>', 0)
          .select('ip')
          .limit(1);
        if (suspiciousRows.length > 0) {
          await db('agent_devices').where({ id: deviceId }).update({ last_threat_at: new Date() });
          const deviceLabel = await db('agent_devices').where({ id: deviceId })
            .select('name', 'hostname').first() as { name: string | null; hostname: string } | undefined;
          const label = deviceLabel?.name ?? deviceLabel?.hostname ?? String(deviceId);
          notificationService.sendForAgent(deviceId, label, 'threat', 'ok', [], 'threat').catch(
            (err) => logger.warn({ err, deviceId }, 'processEventsFlush: threat notification failed'),
          );
        }
      }

      // Emit real-time events to the Starmap
      if (_io) {
        const seen = new Set<string>();
        for (const enriched of enrichedEvents) {
          const key = `${enriched.ip}:${enriched.event_type}`;
          if (seen.has(key)) continue;
          seen.add(key);
          _io.emit('ip:flow', {
            ip: enriched.ip,
            service: enriched.service,
            eventType: enriched.event_type,
            deviceId,
            tenantId,
            sourceAgentId: enriched.source_agent_id,
            sourceIpType: enriched.source_ip_type,
          });
        }
      }
    } catch (err) {
      logger.warn({ err, deviceId }, 'processEventsFlush: event insert failed');
    }
  },

  // ── Version / download endpoints ─────────────────────────

  getAgentVersion(): { version: string } {
    // 1. Try agent/VERSION (plain text "X.Y.Z\n") — present in both dev and prod
    try {
      const versionFilePath = path.resolve(__dirname, '../../../../agent/VERSION');
      const v = fs.readFileSync(versionFilePath, 'utf-8').trim();
      if (v) return { version: v };
    } catch { /* not found, try next */ }

    // 2. Dev fallback: parse `var agentVersion = "x.y.z"` from agent/main.go
    // (main.go now uses `var agentVersion = "dev"` as default — skip "dev")
    try {
      const mainGoPath = path.resolve(__dirname, '../../../../agent/main.go');
      const content = fs.readFileSync(mainGoPath, 'utf-8');
      const match = content.match(/(?:var|const)\s+agentVersion\s*=\s*"([^"]+)"/);
      if (match?.[1] && match[1] !== 'dev') return { version: match[1] };
    } catch { /* not found */ }

    return { version: '0.0.0' };
  },

  /**
   * Mark a device as "updating" — called when the agent notifies us it is
   * about to self-update.  Sets updating_since to NOW() and emits the
   * AGENT_STATUS_CHANGED event so the UI shows the "UPDATING" badge immediately.
   */
  async setDeviceUpdating(deviceId: number, tenantId: number): Promise<void> {
    await db('agent_devices')
      .where({ id: deviceId })
      .update({ updating_since: new Date(), updated_at: new Date() });

    const device = await db('agent_devices').where({ id: deviceId }).select('hostname', 'name').first() as
      { hostname: string; name: string | null } | undefined;
    const label = device?.name ?? device?.hostname ?? `#${deviceId}`;
    logger.info(`Agent ${deviceId} (${label}) is self-updating.`);

    // Notify connected admins immediately
    if (_io) {
      const payload = { deviceId, status: 'updating', violations: [], violationKeys: [] };
      if (tenantId) {
        _io.to(`tenant:${tenantId}:admin`).emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, payload);
      }
      _io.to('role:admin').emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, payload);
    }

    // (update notifications removed — Obliguard does not track self-updates)
  },

  /**
   * Cleanup job: clear updating_since for devices that have been stuck in the
   * updating state for more than 10 minutes without reconnecting.
   * After clearing, the normal offline detection takes over and sends
   * the standard "device offline" alert.
   */
  async cleanupStuckUpdating(): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const rows = await db('agent_devices')
      .whereNotNull('updating_since')
      .where('updating_since', '<', cutoff)
      .select('id', 'hostname', 'name') as { id: number; hostname: string; name: string | null }[];

    if (rows.length === 0) return;

    const ids = rows.map(r => r.id);
    await db('agent_devices')
      .whereIn('id', ids)
      .update({ updating_since: null, updated_at: new Date() });

    for (const row of rows) {
      const label = row.name ?? row.hostname;
      logger.warn(`Agent ${row.id} (${label}) update timed out — resuming offline detection.`);
    }
    logger.info(`Agent updating cleanup: cleared ${ids.length} stuck update(s).`);
  },

  /** Obliguard: no hardware metrics (IPS uses events not sensors) */
  getLatestMetrics(_deviceId: number): null { return null; },

  /** Obliguard: no hardware metrics in DB */
  async getMetricsFromDB(_deviceId: number): Promise<null> { return null; },

  getDesktopVersion(): { version: string } {
    // 1. Try obli.tools/VERSION (plain text "X.Y.Z\n")
    try {
      const versionFilePath = path.resolve(__dirname, '../../../../obli.tools/VERSION');
      const v = fs.readFileSync(versionFilePath, 'utf-8').trim();
      if (v) return { version: v };
    } catch { /* not found, try next */ }

    // 2. Dev fallback: parse `const appVersion = "x.y.z"` from obli.tools/main.go
    try {
      const mainGoPath = path.resolve(__dirname, '../../../../obli.tools/main.go');
      const content = fs.readFileSync(mainGoPath, 'utf-8');
      const match = content.match(/(?:var|const)\s+appVersion\s*=\s*"([^"]+)"/);
      if (match?.[1]) return { version: match[1] };
    } catch { /* not found */ }

    return { version: '0.0.0' };
  },
};

