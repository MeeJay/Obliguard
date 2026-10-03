import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

/** Query parameter holding the IP shown in the global IP detail drawer. */
export const IP_DRAWER_PARAM = 'ip';

/**
 * Window event fired after the drawer (or a list) changed an IP: ban, lift,
 * whitelist, label, clear… Lists showing that IP refetch on it (useIpChanged).
 * detail: { ip: string | null } (null = several IPs, e.g. a bulk action).
 */
export const IP_CHANGED_EVENT = 'obliguard:ip-changed';

/** History state flag set when open() pushed the entry close() may pop. */
const PUSHED_STATE_KEY = 'ipDrawer';

/** Longest value accepted from ?ip= (an IPv6 address is at most 45 chars). */
const MAX_IP_LENGTH = 64;

/** The ?ip= value to show, trimmed, or null when absent / empty / oversized. */
export function readIpParam(raw: string | null): string | null {
  const ip = raw?.trim() ?? '';
  return ip !== '' && ip.length <= MAX_IP_LENGTH ? ip : null;
}

/** Tell every mounted list that `ip` (or several IPs: null) changed. */
export function notifyIpChanged(ip: string | null): void {
  try {
    window.dispatchEvent(new CustomEvent<{ ip: string | null }>(IP_CHANGED_EVENT, { detail: { ip } }));
  } catch { /* CustomEvent unavailable (very old WebView): lists refresh on their own */ }
}

/** Calls `onChange` (latest closure) whenever notifyIpChanged() fires. */
export function useIpChanged(onChange: (ip: string | null) => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    const handler = (e: Event) => ref.current((e as CustomEvent<{ ip: string | null }>).detail?.ip ?? null);
    window.addEventListener(IP_CHANGED_EVENT, handler);
    return () => window.removeEventListener(IP_CHANGED_EVENT, handler);
  }, []);
}

export interface IpDrawerControls {
  /** IP currently shown (from ?ip=), or null when the drawer is closed. */
  ip: string | null;
  /** Show `ip` in the drawer, on top of the current page (other params kept). */
  open: (ip: string) => void;
  close: () => void;
}

/**
 * The unified IP detail drawer is driven by ?ip= on the current URL, so any
 * page can open it, a link like /ip-reputation?ip=1.2.3.4 deep-links to it
 * and a reload keeps it open. <IpDetailDrawer /> is mounted once in AppLayout.
 *
 *   const { open } = useIpDrawer();
 *   <button onClick={() => open(row.ip)}>{row.ip}</button>
 *
 * open() pushes a history entry, so Back (or Android back) closes the
 * drawer; close() pops that entry when open() made it and otherwise just
 * drops the parameter (deep link, reload).
 */
export function useIpDrawer(): IpDrawerControls {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const ip = readIpParam(searchParams.get(IP_DRAWER_PARAM));
  const pushed = (location.state as Record<string, unknown> | null)?.[PUSHED_STATE_KEY] === true;

  const open = useCallback((target: string) => {
    const value = target.trim();
    if (!value) return;
    const alreadyOpen = ip !== null;
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set(IP_DRAWER_PARAM, value);
      return params;
    }, {
      // Switching IPs inside an open drawer replaces the entry (one Back closes it).
      replace: alreadyOpen,
      state: { [PUSHED_STATE_KEY]: alreadyOpen ? pushed : true },
    });
  }, [ip, pushed, setSearchParams]);

  const close = useCallback(() => {
    if (pushed) {
      navigate(-1);
      return;
    }
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.delete(IP_DRAWER_PARAM);
      return params;
    }, { replace: true });
  }, [pushed, navigate, setSearchParams]);

  return { ip, open, close };
}
