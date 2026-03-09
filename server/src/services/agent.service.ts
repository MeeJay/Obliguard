import type { Server as SocketIOServer } from 'socket.io';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db';
import type {
  AgentApiKey,
  AgentDevice,
  AgentDisplayConfig,
  AgentGroupConfig,
  AgentThresholds,
  NotificationTypeConfig,
  ObliguardPushBody,
  ObliguardPushResponse,
  AgentServiceConfig,
  AgentIpEvent,
} from '@obliview/shared';
import { DEFAULT_AGENT_THRESHOLDS, SOCKET_EVENTS } from '@obliview/shared';
import { notificationService } from './notification.service';
import { logger } from '../utils/logger';
import { whitelistService } from './whitelist.service';
import { banService } from './ban.service';
import { ipReputationService } from './ipReputation.service';

// ── Socket.io instance (set from index.ts) ──────────────────
let _io: SocketIOServer | null = null;
export function setAgentServiceIO(io: SocketIOServer): void {
  _io = io;
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

function rowToDevice(row: AgentDeviceRow, groupConfig?: AgentGroupConfig | null, groupThresholds?: AgentThresholds | null): AgentDevice {
  const override = row.override_group_settings ?? false;

  // Compute effective (resolved) settings, honouring group inheritance when override=false.
  let resolvedSettings: AgentDevice['resolvedSettings'];
  if (!override && groupConfig) {
    resolvedSettings = {
      checkIntervalSeconds: groupConfig.pushIntervalSeconds ?? row.check_interval_seconds,
      heartbeatMonitoring:  groupConfig.heartbeatMonitoring  ?? (row.heartbeat_monitoring ?? true),
      maxMissedPushes:      groupConfig.maxMissedPushes      ?? (row.agent_max_missed_pushes ?? 2),
    };
  } else {
    resolvedSettings = {
      checkIntervalSeconds: row.check_interval_seconds,
      heartbeatMonitoring:  row.heartbeat_monitoring ?? true,
      maxMissedPushes:      row.agent_max_missed_pushes ?? 2,
    };
  }

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

  // ── Devices ─────────────────────────────────────────────

  async listDevices(tenantId: number, status?: AgentDevice['status']): Promise<AgentDevice[]> {
    // LEFT JOIN to fetch agent_group_config in one round-trip so resolvedSettings
    // can be computed without N+1 queries.
    const query = db('agent_devices as d')
      .leftJoin('monitor_groups as g', 'g.id', 'd.group_id')
      .where({ 'd.tenant_id': tenantId })
      .select(
        'd.*',
        db.raw('g.agent_group_config as _group_agent_config'),
        db.raw('g.agent_thresholds as _group_agent_thresholds'),
      )
      .orderBy('d.created_at', 'desc');
    if (status) query.where({ 'd.status': status });
    const rows = await query as (AgentDeviceRow & { _group_agent_config: unknown; _group_agent_thresholds: unknown })[];
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
      return rowToDevice(r, gc, gt);
    });
  },

  async getDeviceById(id: number): Promise<AgentDevice | null> {
    const row = await db('agent_devices').where({ id }).first() as AgentDeviceRow | undefined;
    if (!row) return null;
    const [groupConfig, groupThresholds] = await Promise.all([
      row.group_id ? getGroupAgentConfig(row.group_id) : null,
      row.group_id ? getGroupAgentThresholds(row.group_id) : null,
    ]);
    return rowToDevice(row, groupConfig, groupThresholds);
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
    const [groupConfig, groupThresholds] = await Promise.all([
      row.group_id ? getGroupAgentConfig(row.group_id) : null,
      row.group_id ? getGroupAgentThresholds(row.group_id) : null,
    ]);
    return rowToDevice(row, groupConfig, groupThresholds);
  },

  async updateDevice(id: number, data: {
    status?: AgentDevice['status'];
    groupId?: number | null;
    checkIntervalSeconds?: number;
    approvedBy?: number;
    approvedAt?: Date;
    name?: string | null;
    heartbeatMonitoring?: boolean;
    sensorDisplayNames?: Record<string, string> | null;
    overrideGroupSettings?: boolean;
    displayConfig?: AgentDisplayConfig | null;
    notificationTypes?: NotificationTypeConfig | null;
  }): Promise<AgentDevice | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.status !== undefined) update.status = data.status;
    if (data.groupId !== undefined) update.group_id = data.groupId;
    if (data.checkIntervalSeconds !== undefined) update.check_interval_seconds = data.checkIntervalSeconds;
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

    const [row] = await db('agent_devices')
      .where({ id })
      .update(update)
      .returning('*') as AgentDeviceRow[];
    if (!row) return null;
    const groupConfig = row.group_id ? await getGroupAgentConfig(row.group_id) : null;
    const device = rowToDevice(row, groupConfig);

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

    // ── f. Process events ─────────────────────────────────
    if (body.events && body.events.length > 0) {
      try {
        await db('ip_events').insert(
          body.events.map((ev: AgentIpEvent) => ({
            device_id: deviceId,
            ip: ev.ip,
            username: ev.username ?? null,
            service: ev.service,
            event_type: ev.eventType,
            timestamp: new Date(ev.timestamp),
            raw_log: ev.rawLog ?? null,
            tenant_id: agentTenantId,
          })),
        );

        // Update IP reputation from the new events
        await ipReputationService.upsertFromEvents(
          body.events.map((ev: AgentIpEvent) => ({
            ip: ev.ip,
            service: ev.service,
            username: ev.username ?? null,
            deviceId,
            eventType: ev.eventType,
          })),
        );

        // Emit real-time connection events to the live threat map
        // One event per unique IP (deduplicated per push cycle)
        if (_io) {
          const seen = new Set<string>();
          for (const ev of body.events as AgentIpEvent[]) {
            const key = `${ev.ip}:${ev.eventType}`;
            if (seen.has(key)) continue;
            seen.add(key);
            _io.emit('ip:flow', {
              ip: ev.ip,
              service: ev.service,
              eventType: ev.eventType,  // 'auth_failure' | 'auth_success'
              deviceId,
              tenantId: agentTenantId,
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

    // ── g. Compute ban delta ──────────────────────────────
    // Walk group_closure to get ancestor group IDs (closest first)
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

    let resolvedWhitelist: string[] = [];
    let banDelta: { add: string[]; remove: string[] } = { add: [], remove: [] };

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

    // If no service templates are configured for this device/group, auto-enable
    // all detected services with sensible defaults so log watching works
    // out-of-the-box without requiring manual template configuration.
    if (Object.keys(serviceConfigsMap).length === 0 && body.services && body.services.length > 0) {
      for (const svc of body.services as { type: string }[]) {
        serviceConfigsMap[svc.type] = {
          enabled: true,
          threshold: 5,
          windowSeconds: 60,
        };
      }
    }

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
      command: pendingCommand ?? '',
    };
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

    // Send "update" notification if the update type is enabled for this device
    notificationService.sendForAgent(deviceId, label, 'updating', 'up', [], 'update').catch(
      (err) => logger.error(err, `Failed to send update notification for device ${deviceId}`),
    );
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
    // 1. Try desktop-app/VERSION (plain text "X.Y.Z\n")
    try {
      const versionFilePath = path.resolve(__dirname, '../../../../desktop-app/VERSION');
      const v = fs.readFileSync(versionFilePath, 'utf-8').trim();
      if (v) return { version: v };
    } catch { /* not found, try next */ }

    // 2. Dev fallback: parse `const appVersion = "x.y.z"` from desktop-app/main.go
    try {
      const mainGoPath = path.resolve(__dirname, '../../../../desktop-app/main.go');
      const content = fs.readFileSync(mainGoPath, 'utf-8');
      const match = content.match(/(?:var|const)\s+appVersion\s*=\s*"([^"]+)"/);
      if (match?.[1]) return { version: match[1] };
    } catch { /* not found */ }

    return { version: '0.0.0' };
  },
};

