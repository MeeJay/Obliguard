import { useEffect } from 'react';
import { AGENT_WATCH_TTL_SECONDS, CLIENT_SOCKET_EVENTS } from '@obliview/shared';
import type { AgentWatchAck } from '@obliview/shared';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';

/** Renew this long before the watch expires (the server drops it at its TTL). */
const RENEW_MARGIN_SECONDS = 60;

/**
 * Join the agent's watch room ('agent:watch' {deviceId}) while the page is
 * open, so its ip:events frames reach this socket even when the tenant feed
 * does not carry them (a team-restricted user, a god-view reader). The watch
 * is renewed before its TTL, re-joined after every (re)connect (a new socket
 * id has no rooms) and left on unmount. A refused watch is harmless: the
 * tenant feed still applies.
 */
export function useAgentWatch(deviceId: number | null): void {
  const generation = useSocketStore((s) => s.generation);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || deviceId == null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const schedule = (ttlSeconds: number) => {
      if (timer) clearTimeout(timer);
      const delay = Math.max(30, ttlSeconds - RENEW_MARGIN_SECONDS) * 1000;
      timer = setTimeout(watch, delay);
    };

    function watch() {
      if (disposed || !socket) return;
      if (!socket.connected) return; // the 'connect' handler re-joins
      socket.emit(CLIENT_SOCKET_EVENTS.AGENT_WATCH, { deviceId }, (ack: AgentWatchAck | undefined) => {
        if (disposed) return;
        if (ack && ack.ok) schedule(ack.ttlSeconds ?? AGENT_WATCH_TTL_SECONDS);
      });
    }

    socket.on('connect', watch);
    watch();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      socket.off('connect', watch);
      if (socket.connected) socket.emit(CLIENT_SOCKET_EVENTS.AGENT_UNWATCH, { deviceId }, () => {});
    };
  }, [deviceId, generation]);
}
