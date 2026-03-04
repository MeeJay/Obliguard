import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';
import { agentPushData } from '../services/agent.service';
import { db } from '../db';
import { SOCKET_EVENTS } from '@obliview/shared';

/**
 * Agent Monitor Worker (passive).
 *
 * Thresholds are evaluated in real-time at push time (in agent.service.ts).
 * This worker's only job is to detect "device offline" (no push received
 * within 2 × check_interval_seconds) and return the current status.
 */
export class AgentMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const agentDeviceId = this.config.agentDeviceId as number | null;

    if (!agentDeviceId) {
      return { status: 'down', message: 'Agent monitor not configured (no device ID)' };
    }

    // Collect the result into a local variable so we can emit AGENT_STATUS_CHANGED
    // from every code path (offline watchdog, normal push, device state changes).
    let result: CheckResult;

    // Fetch device for status + raw settings + override flag
    const device = await db('agent_devices')
      .where({ id: agentDeviceId })
      .select('check_interval_seconds', 'status', 'heartbeat_monitoring', 'group_id', 'agent_max_missed_pushes', 'override_group_settings')
      .first() as {
        check_interval_seconds: number; status: string; heartbeat_monitoring: boolean;
        group_id: number | null; agent_max_missed_pushes: number | null; override_group_settings: boolean;
      } | undefined;

    if (!device) {
      result = { status: 'down', message: 'Agent device not found' };
    } else if (device.status === 'refused') {
      result = { status: 'down', message: 'Agent device is refused' };
    } else if (device.status === 'suspended') {
      result = { status: 'paused', message: 'Agent device is suspended' };
    } else if (device.status === 'pending') {
      result = { status: 'pending', message: 'Waiting for device approval' };
    } else {
      // Check for a recent push
      const snapshot = agentPushData.get(agentDeviceId);

      // Resolve effective settings — when override_group_settings is false and the
      // device belongs to a group, the group's agent_group_config takes precedence.
      // This mirrors the same logic as rowToDevice / resolvedSettings in agent.service.ts.
      let effectiveCheckInterval = device.check_interval_seconds;
      let effectiveHeartbeatMonitoring = device.heartbeat_monitoring ?? true;
      let effectiveMaxMissedPushes: number | null = device.agent_max_missed_pushes ?? null;

      if (!device.override_group_settings && device.group_id !== null) {
        const groupRow = await db('monitor_groups')
          .where({ id: device.group_id })
          .select('agent_group_config')
          .first() as { agent_group_config: unknown } | undefined;
        const cfg = typeof groupRow?.agent_group_config === 'string'
          ? JSON.parse(groupRow.agent_group_config)
          : groupRow?.agent_group_config as { pushIntervalSeconds?: number | null; heartbeatMonitoring?: boolean | null; maxMissedPushes?: number | null } | null | undefined;
        if (cfg) {
          if (cfg.pushIntervalSeconds != null)  effectiveCheckInterval        = cfg.pushIntervalSeconds;
          if (cfg.heartbeatMonitoring  != null)  effectiveHeartbeatMonitoring = cfg.heartbeatMonitoring;
          if (cfg.maxMissedPushes      != null)  effectiveMaxMissedPushes     = cfg.maxMissedPushes;
        }
      }

      const effectiveMaxMissed = effectiveMaxMissedPushes ?? 2;
      const maxStaleMs = effectiveCheckInterval * effectiveMaxMissed * 1000;

      if (!snapshot) {
        // No push received yet
        result = effectiveHeartbeatMonitoring
          ? { status: 'down', message: 'Waiting for first agent push...' }
          : { status: 'inactive', message: 'No data received (heartbeat monitoring disabled)' };
      } else {
        const ageMs = Date.now() - snapshot.receivedAt.getTime();
        if (ageMs > maxStaleMs) {
          const ageSec = Math.round(ageMs / 1000);
          const ageMins = Math.floor(ageSec / 60);
          const timeLabel = ageMins > 0 ? `${ageMins}m ${ageSec % 60}s` : `${ageSec}s`;
          result = effectiveHeartbeatMonitoring
            ? { status: 'down', message: `Device offline (last seen ${timeLabel} ago)` }
            : { status: 'inactive', message: `No data received for ${timeLabel} (heartbeat monitoring disabled)` };
        } else {
          // Agent is online — return the status computed at push time
          const message = snapshot.violations.length > 0
            ? snapshot.violations.join('; ')
            : 'All metrics OK';
          result = { status: snapshot.overallStatus, message };
        }
      }
    }

    // Emit dedicated agent status event so the sidebar badge updates immediately,
    // regardless of whether the BaseMonitorWorker will emit MONITOR_STATUS_CHANGE
    // (which only fires on transitions after retries are exhausted).
    this.io.to('role:admin').emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, {
      deviceId: agentDeviceId,
      status: result.status,
    });

    return result;
  }
}
