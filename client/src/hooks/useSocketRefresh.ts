import { useEffect, useRef } from 'react';
import { getSocket } from '../socket/socketClient';
import { useSocketStore } from '../store/socketStore';
import { SOCKET_RESYNC_EVENT } from './useSocket';

export interface UseSocketRefreshOptions {
  /** Trailing debounce: a burst of events triggers one refetch (default 500 ms). */
  debounceMs?: number;
  /** false unbinds everything (e.g. while the page is paused). Default true. */
  enabled?: boolean;
  /** Also refetch after a socket reconnect (events emitted while down are lost). Default true. */
  resync?: boolean;
}

/**
 * Debounced refetch of a page's data on a list of Socket.io events, for pages
 * that simply reload their list when something changes server-side (bans,
 * whitelist, agents…) instead of merging payloads:
 *
 *   useSocketRefresh([SOCKET_EVENTS.AGENT_STATUS_CHANGED, 'ban:created'], load);
 *
 * Re-binds on every new socket instance (socketStore generation), always calls
 * the latest `refetch` (no need to memoise it), removes only its own handlers
 * and cancels a pending refetch on unmount.
 */
export function useSocketRefresh(
  events: ReadonlyArray<string>,
  refetch: () => void | Promise<unknown>,
  options: UseSocketRefreshOptions = {},
): void {
  const { debounceMs = 500, enabled = true, resync = true } = options;
  const generation = useSocketStore((s) => s.generation);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const eventsKey = events.join('\u0000');

  useEffect(() => {
    if (!enabled) return;
    const names = eventsKey ? eventsKey.split('\u0000') : [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      timer = null;
      try {
        const out = refetchRef.current();
        if (out && typeof (out as Promise<unknown>).catch === 'function') {
          (out as Promise<unknown>).catch((err) => console.error('[useSocketRefresh] refetch failed', err));
        }
      } catch (err) {
        console.error('[useSocketRefresh] refetch failed', err);
      }
    };
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, debounceMs));
    };

    const socket = getSocket();
    if (socket) for (const name of names) socket.on(name, schedule);
    if (resync) window.addEventListener(SOCKET_RESYNC_EVENT, schedule);

    return () => {
      if (timer !== null) clearTimeout(timer);
      if (socket) for (const name of names) socket.off(name, schedule);
      if (resync) window.removeEventListener(SOCKET_RESYNC_EVENT, schedule);
    };
  }, [eventsKey, debounceMs, enabled, resync, generation]);
}
