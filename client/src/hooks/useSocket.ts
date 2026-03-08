import { useEffect, useRef } from 'react';
import { getSocket } from '../socket/socketClient';
import { useMonitorStore } from '../store/monitorStore';
import { useGroupStore } from '../store/groupStore';
import { useAuthStore } from '../store/authStore';
import { useLiveAlertsStore } from '../store/liveAlertsStore';
import { SOCKET_EVENTS } from '@obliview/shared';
import type { MonitorGroup, LiveAlertData } from '@obliview/shared';
import type { Monitor, Heartbeat } from '../store/monitorStore';

/** Dispatch a sound notification to the native desktop app overlay. */
function notifyNative(type: 'probe_down' | 'probe_up' | 'agent_alert' | 'agent_fixed') {
  window.dispatchEvent(new CustomEvent('obliview:notify', { detail: { type } }));
}

export function useSocket() {
  const { user } = useAuthStore();
  const { addMonitor, updateMonitor, removeMonitor, addHeartbeat } = useMonitorStore();
  const { addGroup, updateGroup, removeGroup, fetchTree } = useGroupStore();

  // Track previous agent statuses to detect transitions (alert↔ok) for native sounds.
  const agentStatusRef = useRef<Map<number, string>>(new Map());

  const isNativeApp = typeof window !== 'undefined' && !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

  useEffect(() => {
    if (!user) return;

    const socket = getSocket();
    if (!socket) return;

    // ── Live alert (NOTIFICATION_NEW) ─────────────────────────────────────────
    // The server now persists alerts in the DB and emits NOTIFICATION_NEW.
    // We simply add the alert to the local store; toast display is handled by LiveAlerts.tsx.
    socket.on(SOCKET_EVENTS.NOTIFICATION_NEW, (alert: LiveAlertData) => {
      useLiveAlertsStore.getState().addAlertFromServer(alert);
    });

    // ── Monitor heartbeat ─────────────────────────────────────────────────────
    socket.on(SOCKET_EVENTS.MONITOR_HEARTBEAT, (data: { monitorId: number; heartbeat: Heartbeat }) => {
      addHeartbeat(data.monitorId, data.heartbeat);
    });

    // ── Monitor status change ─────────────────────────────────────────────────
    // Only used for: native app sounds + store/sidebar badge update.
    // Live alert toasts now come via NOTIFICATION_NEW (server-generated, DB-backed).
    socket.on(SOCKET_EVENTS.MONITOR_STATUS_CHANGE, (data: { monitorId: number; newStatus: string }) => {
      const prevMonitor = useMonitorStore.getState().getMonitor(data.monitorId);
      const prev = prevMonitor?.status;

      // While an agent is self-updating the worker emits 'pending' heartbeats (for
      // uptime exclusion), but the UI badge should stay on 'updating'. Skip any
      // 'pending' transition that would overwrite the 'updating' badge.
      if (data.newStatus === 'pending' && prev === 'updating') return;

      // Native app: play sound on down/recovery transitions
      if (isNativeApp) {
        if (data.newStatus === 'down' && prev !== 'down') {
          notifyNative('probe_down');
        } else if (prev === 'down' && data.newStatus !== 'down') {
          notifyNative('probe_up');
        }
      }

      updateMonitor(data.monitorId, { status: data.newStatus as Monitor['status'] });

      // Auto-expand parent groups when a monitor goes DOWN
      if (data.newStatus === 'down') {
        const monitor = useMonitorStore.getState().getMonitor(data.monitorId);
        if (monitor?.groupId) {
          const groupStore = useGroupStore.getState();
          groupStore.expandGroup(monitor.groupId);
          groupStore.expandAncestors(monitor.groupId);
        }
      }
    });

    // ── Monitor CRUD ──────────────────────────────────────────────────────────
    socket.on(SOCKET_EVENTS.MONITOR_CREATED, (data: { monitor: Monitor }) => {
      addMonitor(data.monitor);
    });
    socket.on(SOCKET_EVENTS.MONITOR_UPDATED, (data: { monitorId: number; changes: Partial<Monitor> }) => {
      updateMonitor(data.monitorId, data.changes);
    });
    socket.on(SOCKET_EVENTS.MONITOR_DELETED, (data: { monitorId: number }) => {
      removeMonitor(data.monitorId);
    });
    socket.on(SOCKET_EVENTS.MONITOR_PAUSED, (data: { monitorId: number; isPaused: boolean }) => {
      updateMonitor(data.monitorId, { status: data.isPaused ? 'paused' : 'pending' });
    });

    // ── Group events ──────────────────────────────────────────────────────────
    socket.on(SOCKET_EVENTS.GROUP_CREATED, (data: { group: MonitorGroup }) => {
      addGroup(data.group);
      fetchTree();
    });
    socket.on(SOCKET_EVENTS.GROUP_UPDATED, (data: { group: MonitorGroup }) => {
      updateGroup(data.group.id, data.group);
      fetchTree();
    });
    socket.on(SOCKET_EVENTS.GROUP_DELETED, (data: { groupId: number }) => {
      removeGroup(data.groupId);
      fetchTree();
    });
    socket.on(SOCKET_EVENTS.GROUP_MOVED, (data: { group: MonitorGroup }) => {
      updateGroup(data.group.id, data.group);
      fetchTree();
    });

    // ── Agent status — native sounds + 'updating' badge propagation ─────────────
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED, (data: {
      deviceId: number;
      status: string;
      violations?: string[];
      violationKeys?: string[];
    }) => {
      const prev = agentStatusRef.current.get(data.deviceId);

      if (isNativeApp) {
        if (data.status === 'alert' && prev !== 'alert') {
          notifyNative('agent_alert');
        } else if (prev === 'alert' && data.status !== 'alert') {
          notifyNative('agent_fixed');
        }
      }

      agentStatusRef.current.set(data.deviceId, data.status);

      // Propagate 'updating' (and its clearing) to the linked agent monitor badge.
      // The worker returns 'pending' heartbeats during update (for uptime exclusion),
      // but the monitor badge should reflect 'updating' (blue) instead.
      if (data.status === 'updating') {
        const agentMonitor = useMonitorStore.getState().getMonitorList()
          .find(m => m.agentDeviceId === data.deviceId);
        if (agentMonitor) {
          updateMonitor(agentMonitor.id, { status: 'updating' });
        }
      }
    });

    return () => {
      socket.off(SOCKET_EVENTS.NOTIFICATION_NEW);
      socket.off(SOCKET_EVENTS.MONITOR_HEARTBEAT);
      socket.off(SOCKET_EVENTS.MONITOR_STATUS_CHANGE);
      socket.off(SOCKET_EVENTS.MONITOR_CREATED);
      socket.off(SOCKET_EVENTS.MONITOR_UPDATED);
      socket.off(SOCKET_EVENTS.MONITOR_DELETED);
      socket.off(SOCKET_EVENTS.MONITOR_PAUSED);
      socket.off(SOCKET_EVENTS.GROUP_CREATED);
      socket.off(SOCKET_EVENTS.GROUP_UPDATED);
      socket.off(SOCKET_EVENTS.GROUP_DELETED);
      socket.off(SOCKET_EVENTS.GROUP_MOVED);
      socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED);
    };
  }, [user, addMonitor, updateMonitor, removeMonitor, addHeartbeat, addGroup, updateGroup, removeGroup, fetchTree, isNativeApp]);
}
