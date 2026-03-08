import type { Server as SocketIOServer } from 'socket.io';
import type { MonitorStatus } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';
import { heartbeatService } from '../services/heartbeat.service';
import { monitorService } from '../services/monitor.service';
import { notificationService } from '../services/notification.service';
import { remediationService } from '../services/remediation.service';
import { groupService } from '../services/group.service';
import { groupNotificationService } from '../services/groupNotification.service';
import { permissionService } from '../services/permission.service';
import { maintenanceService } from '../services/maintenance.service';
import { liveAlertService } from '../services/liveAlert.service';
import { db } from '../db';
import { logger } from '../utils/logger';

export interface CheckResult {
  status: MonitorStatus;
  responseTime?: number;
  statusCode?: number;
  message?: string;
  ping?: number;
  value?: string;
  /** Set to true for value watcher "changed" operator — triggers notification without changing status */
  valueChanged?: boolean;
}

export interface MonitorConfig {
  id: number;
  name: string;
  type: string;
  groupId: number | null;
  intervalSeconds: number;
  retryIntervalSeconds: number;
  maxRetries: number;
  timeoutMs: number;
  upsideDown: boolean;
  /** Minimum seconds between repeated problem notifications (0 = disabled) */
  notificationCooldownSeconds: number;
  [key: string]: unknown;
}

export abstract class BaseMonitorWorker {
  protected config: MonitorConfig;
  protected io: SocketIOServer;
  protected timer: ReturnType<typeof setTimeout> | null = null;
  protected isRunning: boolean = false;
  protected retryCount: number = 0;
  protected previousStatus: MonitorStatus = 'pending';
  /** The last status that was officially confirmed and notified (survives retries) */
  protected confirmedStatus: MonitorStatus = 'pending';
  /** Unix-ms timestamp of the last problem notification sent (for cooldown check) */
  protected lastProblemNotifiedAt: number = 0;
  /** Tenant ID for scoped Socket.io room emissions (null until resolved) */
  protected tenantId: number | null = null;

  constructor(config: MonitorConfig, io: SocketIOServer) {
    this.config = config;
    this.io = io;
  }

  /** Resolve and cache the tenant_id for this monitor from the DB. */
  protected async resolveTenantId(): Promise<number | null> {
    if (this.tenantId !== null) return this.tenantId;
    const row = await db('monitors')
      .where({ id: this.config.id })
      .select('tenant_id')
      .first() as { tenant_id: number | null } | undefined;
    this.tenantId = row?.tenant_id ?? null;
    return this.tenantId;
  }

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info(`Starting worker for monitor "${this.config.name}" (id: ${this.config.id})`);

    // Restore previousStatus / confirmedStatus from the DB so a fresh start
    // does not re-send notifications for problems that were already known before
    // the server restarted (e.g. a monitor that was already DOWN).
    try {
      const row = await db('monitors')
        .where({ id: this.config.id })
        .select('status')
        .first() as { status: MonitorStatus } | undefined;
      if (row?.status && row.status !== 'pending') {
        this.previousStatus  = row.status;
        this.confirmedStatus = row.status;
      }
    } catch {
      // Non-critical — fall through with defaults ('pending')
    }

    await this.beat();
    this.scheduleNext();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info(`Stopped worker for monitor "${this.config.name}" (id: ${this.config.id})`);
  }

  updateConfig(config: MonitorConfig): void {
    this.config = config;
  }

  private scheduleNext(): void {
    if (!this.isRunning) return;

    // Use shorter retry interval while in the retry window for both 'down' and 'alert'.
    const isRetryableStatus = this.previousStatus === 'down' || this.previousStatus === 'alert';
    const interval =
      isRetryableStatus && this.retryCount <= this.config.maxRetries
        ? this.config.retryIntervalSeconds
        : this.config.intervalSeconds;

    this.timer = setTimeout(async () => {
      if (!this.isRunning) return;
      await this.beat();
      this.scheduleNext();
    }, interval * 1000);
  }

  private async beat(): Promise<void> {
    let result: CheckResult;

    try {
      result = await this.performCheck();
    } catch (error) {
      result = {
        status: 'down',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    // Apply upside-down logic (only for up/down, not SSL statuses)
    if (this.config.upsideDown && (result.status === 'up' || result.status === 'down')) {
      result.status = result.status === 'up' ? 'down' : 'up';
    }

    await this.processResult(result);
  }

  private async processResult(result: CheckResult): Promise<void> {
    try {
      // SSL statuses are deterministic (not transient) — no retries needed
      const isSslStatus = result.status === 'ssl_warning' || result.status === 'ssl_expired';

      // 'down' AND 'alert' both go through the retry mechanism:
      //   • retryCount accumulates on consecutive failures
      //   • notification fires only after retryCount > maxRetries (confirmed problem)
      //   • this prevents spurious notifications on transient failures / brief threshold spikes
      const isRetryableStatus = result.status === 'down' || result.status === 'alert';

      if (isRetryableStatus) {
        this.retryCount++;
      }
      const isRetrying = isRetryableStatus && this.retryCount <= this.config.maxRetries;

      // 0. Check maintenance state (cached — 60s TTL)
      const agentDeviceId = this.config.agentDeviceId as number | null | undefined;
      const inMaintenance = agentDeviceId
        ? await maintenanceService.isInMaintenance('agent', agentDeviceId, this.config.groupId)
        : await maintenanceService.isInMaintenance('monitor', this.config.id, this.config.groupId);

      // 1. Store heartbeat (with retry flag + maintenance tag)
      const heartbeat = await heartbeatService.create({
        monitorId: this.config.id,
        status: result.status,
        responseTime: result.responseTime,
        statusCode: result.statusCode,
        message: result.message,
        ping: result.ping,
        isRetrying,
        value: result.value,
        inMaintenance,
      });

      // 1b. Value changed notification (value watcher "changed" operator)
      //     Fires independently of status change logic — monitor stays UP
      if (result.valueChanged) {
        try {
          await notificationService.sendForMonitor(this.config.id, this.config.groupId, {
            monitorName: this.config.name,
            monitorUrl: this.config.url as string | undefined,
            oldStatus: 'up',
            newStatus: 'value_changed',
            message: result.message,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          logger.error(error, `Failed to send value-changed notification for monitor ${this.config.id}`);
        }
      }

      // 2. State change logic — compare against confirmedStatus (not previousStatus)
      //    confirmedStatus tracks the last "officially notified" state.
      //    previousStatus tracks the raw last-check status (used for scheduleNext timing).

      if (isRetryableStatus) {
        if (this.retryCount > this.config.maxRetries) {
          // Retries exhausted — confirmed problem (DOWN or ALERT)
          if (this.confirmedStatus !== result.status) {
            await this.handleStatusChange(result.status, result.message, inMaintenance);
            // Do NOT advance confirmedStatus while in maintenance.
            // Keeping the pre-maintenance value ensures that once the window ends,
            // confirmedStatus !== result.status is still true and a notification fires
            // immediately on the next check — even if the monitor was already down
            // throughout the entire maintenance period.
            if (!inMaintenance) {
              this.confirmedStatus = result.status;
            }
          }
        }
        // During retry period: do NOT update confirmedStatus — wait for the threshold to be met
      } else if (isSslStatus) {
        // SSL statuses fire immediately with no retries
        this.retryCount = 0;
        if (this.confirmedStatus !== result.status) {
          await this.handleStatusChange(result.status, result.message, inMaintenance);
          if (!inMaintenance) {
            this.confirmedStatus = result.status;
          }
        }
      } else {
        // Status is UP (or 'inactive') — always update confirmedStatus, even during maintenance.
        // If a down monitor recovers during a maintenance window we want to track that transition
        // so that a subsequent drop after maintenance correctly fires a notification.
        if (this.confirmedStatus !== result.status && this.confirmedStatus !== 'pending') {
          await this.handleStatusChange(result.status, result.message, inMaintenance);
        }
        this.confirmedStatus = result.status;
        this.retryCount = 0;
      }

      this.previousStatus = result.status;

      // 3. Update monitor status in DB
      await monitorService.updateStatus(this.config.id, result.status);

      // 4. Broadcast heartbeat via Socket.io (visibility-filtered)
      await this.emitToVisibleUsers(SOCKET_EVENTS.MONITOR_HEARTBEAT, {
        monitorId: this.config.id,
        heartbeat,
      });
    } catch (error) {
      // FK violation (23503): the monitor was deleted while the worker was still running.
      // Stop the worker gracefully instead of spamming the logs on every tick.
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === '23503'
      ) {
        logger.warn(
          `Monitor "${this.config.name}" (id: ${this.config.id}) no longer exists in DB — stopping worker gracefully`,
        );
        this.stop();
        return;
      }
      logger.error(
        error,
        `Error processing result for monitor "${this.config.name}" (id: ${this.config.id})`,
      );
    }
  }

  private async handleStatusChange(newStatus: MonitorStatus, message?: string, inMaintenance?: boolean): Promise<void> {
    const oldStatus = this.confirmedStatus;
    logger.info(
      `Monitor "${this.config.name}" (id: ${this.config.id}): ${oldStatus} → ${newStatus}`,
    );

    // Emit status change event (visibility-filtered)
    await this.emitToVisibleUsers(SOCKET_EVENTS.MONITOR_STATUS_CHANGE, {
      monitorId: this.config.id,
      oldStatus,
      newStatus,
      timestamp: new Date().toISOString(),
    });

    // 'inactive' status = agent offline with heartbeat_monitoring disabled → no notification
    if (newStatus === 'inactive') {
      return;
    }

    // 'inactive' → 'up': the agent came back online after being off, but heartbeat monitoring
    // was disabled — the user does not want a "recovered" ping for simply resuming data.
    // Threshold violations (inactive → 'alert') still fire normally.
    if (oldStatus === 'inactive' && newStatus === 'up') {
      return;
    }

    // ── Maintenance suppression ────────────────────────────────────────────────
    // When in maintenance, skip notifications and remediations entirely.
    if (inMaintenance) {
      logger.info(
        `Monitor "${this.config.name}" (id: ${this.config.id}): ` +
        `status change ${oldStatus} → ${newStatus} suppressed (in maintenance)`,
      );
      return;
    }

    // ── Notification cooldown ──────────────────────────────────────────────────
    // Applies to problem statuses only (not recovery → 'up').
    // Prevents notification spam when a monitor flaps repeatedly.
    const isProblemStatus = (s: string) =>
      s === 'down' || s === 'ssl_expired' || s === 'ssl_warning' || s === 'alert';

    if (isProblemStatus(newStatus)) {
      const cooldownMs = (this.config.notificationCooldownSeconds ?? 0) * 1000;
      if (cooldownMs > 0) {
        const elapsed = Date.now() - this.lastProblemNotifiedAt;
        if (elapsed < cooldownMs) {
          logger.info(
            `Monitor "${this.config.name}" (id: ${this.config.id}): ` +
            `notification suppressed — cooldown active (${Math.round((cooldownMs - elapsed) / 1000)}s remaining)`,
          );
          return;
        }
      }
      this.lastProblemNotifiedAt = Date.now();
    }

    // ── Notification type filtering for agent monitors ─────────────────────────
    // If this is an agent monitor, check the device's notification type preferences
    // before dispatching any channel notifications.
    if (this.config.agentDeviceId) {
      const types = await notificationService.resolveNotificationTypesForDevice(this.config.agentDeviceId as number);
      if (!types.global) {
        logger.info(
          `Monitor "${this.config.name}" (id: ${this.config.id}): notification suppressed (global=off)`,
        );
        return;
      }
      if (newStatus === 'down' && !types.down) {
        logger.info(
          `Monitor "${this.config.name}" (id: ${this.config.id}): notification suppressed (down type disabled)`,
        );
        return;
      }
      if (newStatus === 'up' && !types.up) {
        logger.info(
          `Monitor "${this.config.name}" (id: ${this.config.id}): notification suppressed (up type disabled)`,
        );
        return;
      }
    }

    // Trigger notifications
    try {
      // Check if this monitor is covered by a group with groupNotifications
      const groupNotifGroupId = await groupNotificationService.shouldSuppressIndividual(
        this.config.id,
        this.config.groupId,
      );

      if (groupNotifGroupId !== null) {
        // ── Grouped notifications mode ──
        const group = await groupService.getById(groupNotifGroupId);

        if (isProblemStatus(newStatus)) {
          const result = groupNotificationService.handleMonitorDown(
            this.config.id,
            this.config.name,
            groupNotifGroupId,
          );

          if (result === 'first_down') {
            // Send ONE group-level notification
            await notificationService.sendForGroup(groupNotifGroupId, group!.name, {
              monitorName: this.config.name,
              monitorUrl: this.config.url as string | undefined,
              oldStatus,
              newStatus,
              groupName: group!.name,
              groupId: groupNotifGroupId,
              downMonitors: [this.config.name],
              isGroupNotification: true,
              message: message ?? `Monitor "${this.config.name}" in group "${group!.name}" is ${newStatus.toUpperCase()}`,
              timestamp: new Date().toISOString(),
            });
          }
          // 'already_down' → suppress individual notification
        } else if (isProblemStatus(oldStatus)) {
          const result = groupNotificationService.handleMonitorUp(
            this.config.id,
            groupNotifGroupId,
          );

          if (result === 'all_recovered') {
            // Send ONE group recovery notification
            await notificationService.sendForGroup(groupNotifGroupId, group!.name, {
              monitorName: group!.name,
              oldStatus: 'down',
              newStatus: 'up',
              groupName: group!.name,
              groupId: groupNotifGroupId,
              downMonitors: [],
              isGroupNotification: true,
              message: `All monitors in group "${group!.name}" are back up`,
              timestamp: new Date().toISOString(),
            });
          }
          // 'still_down' → suppress recovery notification
        }
      } else {
        // ── Standard mode (individual notifications) ──
        await notificationService.sendForMonitor(this.config.id, this.config.groupId, {
          monitorName: this.config.name,
          monitorUrl: this.config.url as string | undefined,
          oldStatus,
          newStatus,
          message,  // e.g. "CPU: 92.1% > 90%; Disk /: 91.0% > 90%"
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error(error, `Failed to send notifications for monitor ${this.config.id}`);
    }

    // Trigger remediations (fire-and-forget — must not throw)
    remediationService.triggerForMonitor(
      this.config.id,
      this.config.name,
      this.config.url as string | undefined,
      this.config.type,
      this.config.groupId,
      oldStatus,
      newStatus,
    ).catch(err => logger.error(err, `Remediation trigger failed for monitor ${this.config.id}`));

    // Persist live alert in DB so offline users see it when they reconnect
    const tenantId = await this.resolveTenantId();
    if (tenantId !== null) {
      const isProblem = isProblemStatus(newStatus);
      const wasProblematic = isProblemStatus(oldStatus);
      let severity: 'down' | 'up' | 'warning' | 'info';
      let alertMessage: string;
      if (isProblem) {
        severity = newStatus === 'down' ? 'down' : 'warning';
        alertMessage = message ?? `Monitor is ${newStatus.toUpperCase()}`;
      } else if (wasProblematic) {
        severity = 'up';
        alertMessage = 'Monitor recovered';
      } else {
        // Status transition between non-problem states (e.g. pending→up): no live alert needed
        return;
      }
      liveAlertService.add(tenantId, {
        severity,
        title: this.config.name,
        message: alertMessage,
        navigateTo: `/monitor/${this.config.id}`,
        // No stableKey: handleStatusChange only fires on true transitions, so every call is genuine
      }).catch(err => logger.error(err, `Failed to persist live alert for monitor ${this.config.id}`));
    }
  }

  /**
   * Emit a Socket.io event only to users who can see this monitor.
   * Admins always receive it. Non-admins receive it based on team permissions.
   */
  private async emitToVisibleUsers(event: string, payload: unknown): Promise<void> {
    const tenantId = await this.resolveTenantId();

    // Always send to admins — emit to the tenant-scoped admin room (primary)
    // and to the legacy 'role:admin' room for backward compatibility.
    if (tenantId !== null) {
      this.io.to(`tenant:${tenantId}:admin`).emit(event, payload);
    }
    this.io.to('role:admin').emit(event, payload);

    // Get non-admin user IDs with access to this monitor via team permissions
    const userIds = await permissionService.getUsersWithMonitorAccess(this.config.id);
    for (const userId of userIds) {
      this.io.to(`user:${userId}`).emit(event, payload);
    }
  }

  /**
   * Perform the actual check. Implemented by each monitor type.
   * Must resolve within this.config.timeoutMs.
   */
  abstract performCheck(): Promise<CheckResult>;
}
