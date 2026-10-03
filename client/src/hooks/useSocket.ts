import { useEffect, useRef } from 'react';
import { getSocket } from '../socket/socketClient';
import { useGroupStore } from '../store/groupStore';
import { useAuthStore } from '../store/authStore';
import { useLiveAlertsStore } from '../store/liveAlertsStore';
import { useSocketStore } from '../store/socketStore';
import { useAgentStore, toDevicePatch } from '../store/agentStore';
import { SOCKET_EVENTS } from '@obliview/shared';
import type { MonitorGroup, LiveAlertData } from '@obliview/shared';

/**
 * Window event dispatched after every socket REconnect (sleep, network cut,
 * tenant switch). Events emitted while the socket was down are lost: pages
 * holding live data listen to it and reload.
 */
export const SOCKET_RESYNC_EVENT = 'socket:resync';

/** Emitted to tenant admins when an agent registers (pending approval). */
const AGENT_DEVICE_CREATED = SOCKET_EVENTS.AGENT_DEVICE_CREATED;

/** Dispatch a sound notification to the native desktop app overlay. */
function notifyNative(type: 'probe_down' | 'probe_up' | 'agent_alert' | 'agent_fixed') {
  window.dispatchEvent(new CustomEvent('obliview:notify', { detail: { type } }));
}

/**
 * Id of the last socket connection seen by useSocket (socket.id changes on
 * every connection). null = none yet in this session: the first connect is
 * covered by the login fetches (authStore.checkSession) and is not a resync.
 */
let lastConnectionId: string | null = null;

export function useSocket() {
  const { user } = useAuthStore();
  const { addGroup, updateGroup, removeGroup, fetchTree } = useGroupStore();
  // A new socket instance (login, tenant switch, rebuild) bumps the
  // generation: re-bind every listener to it.
  const generation = useSocketStore(s => s.generation);

  // Track previous agent statuses to detect transitions (alert↔ok) for native sounds.
  const agentStatusRef = useRef<Map<number, string>>(new Map());

  const isNativeApp = typeof window !== 'undefined' && !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

  useEffect(() => {
    if (!user) {
      lastConnectionId = null;
      return;
    }

    const socket = getSocket();
    if (!socket) return;

    // ── Reconnect re-sync ─────────────────────────────────────────────────────
    const onConnect = () => {
      const id = socket.id ?? null;
      if (id === null || id === lastConnectionId) return;
      const isFirst = lastConnectionId === null;
      lastConnectionId = id;
      if (isFirst) return;
      void useAgentStore.getState().fetchDevices();
      void useLiveAlertsStore.getState().fetchAlerts();
      window.dispatchEvent(new CustomEvent(SOCKET_RESYNC_EVENT));
    };
    socket.on('connect', onConnect);
    // The new instance may have finished its handshake before this effect ran.
    if (socket.connected) onConnect();

    // ── Live alert (NOTIFICATION_NEW) ─────────────────────────────────────────
    // The server persists alerts in the DB and emits NOTIFICATION_NEW.
    // We simply add the alert to the local store; toast display is handled by LiveAlerts.tsx.
    const onNotification = (alert: LiveAlertData) => {
      useLiveAlertsStore.getState().addAlertFromServer(alert);
    };
    socket.on(SOCKET_EVENTS.NOTIFICATION_NEW, onNotification);
    // Incident resolved server-side → drop it; read in another tab/session → mark it read.
    const onNotificationResolved = (data: { tenantId?: number; ids?: number[] }) => {
      if (Array.isArray(data?.ids)) useLiveAlertsStore.getState().applyResolvedFromServer(data.ids);
    };
    const onNotificationRead = (data: { tenantId?: number; ids?: number[]; readAt?: string | null }) => {
      if (Array.isArray(data?.ids)) useLiveAlertsStore.getState().applyReadFromServer(data.ids, data.readAt);
    };
    socket.on(SOCKET_EVENTS.NOTIFICATION_RESOLVED, onNotificationResolved);
    socket.on(SOCKET_EVENTS.NOTIFICATION_READ, onNotificationRead);

    // ── Group events ──────────────────────────────────────────────────────────
    const onGroupCreated = (data: { group: MonitorGroup }) => {
      addGroup(data.group);
      fetchTree();
    };
    const onGroupUpdated = (data: { group: MonitorGroup }) => {
      updateGroup(data.group.id, data.group);
      fetchTree();
    };
    const onGroupDeleted = (data: { groupId: number }) => {
      removeGroup(data.groupId);
      fetchTree();
    };
    socket.on(SOCKET_EVENTS.GROUP_CREATED, onGroupCreated);
    socket.on(SOCKET_EVENTS.GROUP_UPDATED, onGroupUpdated);
    socket.on(SOCKET_EVENTS.GROUP_DELETED, onGroupDeleted);
    socket.on(SOCKET_EVENTS.GROUP_MOVED, onGroupUpdated);

    // ── Agent devices → agentStore ────────────────────────────────────────────
    // {deviceId, patch} (or a legacy shape) merged as a partial update.
    const onDeviceUpdated = (data: unknown) => {
      const p = toDevicePatch(data);
      if (p) useAgentStore.getState().applyPatch(p);
    };
    const onDeviceCreated = (data: unknown) => {
      const p = toDevicePatch(data);
      if (p) useAgentStore.getState().applyPatch(p);
      else useAgentStore.getState().scheduleRefetch();
    };
    const onDeviceDeleted = (data: { deviceId: number }) => {
      if (typeof data?.deviceId === 'number') useAgentStore.getState().removeDevice(data.deviceId);
    };
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
    socket.on(AGENT_DEVICE_CREATED, onDeviceCreated);
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeviceDeleted);

    // ── Agent status — store + native sounds ──────────────────────────────────
    const onAgentStatus = (data: {
      deviceId: number;
      status: string;
      wsConnected?: boolean;
      violations?: string[];
      violationKeys?: string[];
    }) => {
      if (typeof data?.deviceId !== 'number') return;
      const prev = agentStatusRef.current.get(data.deviceId);

      if (isNativeApp) {
        if (data.status === 'alert' && prev !== 'alert') {
          notifyNative('agent_alert');
        } else if (prev === 'alert' && data.status !== 'alert') {
          notifyNative('agent_fixed');
        }
      }

      agentStatusRef.current.set(data.deviceId, data.status);
      useAgentStore.getState().setLiveStatus(data.deviceId, data.status, data.wsConnected);
    };
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onAgentStatus);

    // Remove only OUR handlers: pages bind their own on the same events.
    return () => {
      socket.off('connect', onConnect);
      socket.off(SOCKET_EVENTS.NOTIFICATION_NEW, onNotification);
      socket.off(SOCKET_EVENTS.NOTIFICATION_RESOLVED, onNotificationResolved);
      socket.off(SOCKET_EVENTS.NOTIFICATION_READ, onNotificationRead);
      socket.off(SOCKET_EVENTS.GROUP_CREATED, onGroupCreated);
      socket.off(SOCKET_EVENTS.GROUP_UPDATED, onGroupUpdated);
      socket.off(SOCKET_EVENTS.GROUP_DELETED, onGroupDeleted);
      socket.off(SOCKET_EVENTS.GROUP_MOVED, onGroupUpdated);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
      socket.off(AGENT_DEVICE_CREATED, onDeviceCreated);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeviceDeleted);
      socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onAgentStatus);
    };
  }, [user, generation, addGroup, updateGroup, removeGroup, fetchTree, isNativeApp]);
}
