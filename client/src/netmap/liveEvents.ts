import type { IpEventStreamRow, IpFlowEvent } from '@obliview/shared';
import type { LiveEvent } from './types';
import { liveEventColor } from './helpers';

/** Most rows kept in the NetMap live feed by the socket path. */
export const LIVE_FEED_CAP = 100;

/** Event ids remembered to drop duplicates (initial load vs. socket frames). */
export const SEEN_EVENT_IDS_CAP = 1000;

/**
 * One auth event reaching the map: a row of an ip:events frame, or a legacy
 * ip:flow ping (no id, no timestamp: "now").
 */
export interface FlowRow {
  id: number | null;
  ip: string;
  service: string;
  eventType: string;
  deviceId: number;
  timestamp: string;
  sourceAgentId: number | null;
  sourceIpType: 'lan' | 'wan' | null;
}

export function flowRowFromStream(row: IpEventStreamRow): FlowRow {
  return {
    id: row.id,
    ip: row.ip,
    service: row.service ?? '',
    eventType: row.eventType,
    deviceId: row.deviceId,
    timestamp: row.timestamp,
    sourceAgentId: row.sourceAgentId ?? null,
    sourceIpType: row.sourceIpType ?? null,
  };
}

export function flowRowFromLegacy(ev: IpFlowEvent): FlowRow {
  return {
    id: null,
    ip: ev.ip,
    service: ev.service ?? '',
    eventType: ev.eventType,
    deviceId: ev.deviceId,
    timestamp: new Date().toISOString(),
    sourceAgentId: ev.sourceAgentId ?? null,
    sourceIpType: ev.sourceIpType ?? null,
  };
}

/** Feed type of an IP event type (anything but a success counts as a failure). */
export function feedType(eventType: string): 'auth_success' | 'auth_failure' {
  return eventType === 'auth_success' ? 'auth_success' : 'auth_failure';
}

/**
 * Live-feed row of a GET /ip-events row. That route returns database rows
 * (snake_case, plus the agent hostname); camelCase is accepted as well.
 */
export function liveEventFromRest(ev: Record<string, unknown>, fallbackAgent: string): LiveEvent {
  const evType = String(ev.event_type ?? ev.eventType ?? 'auth_success');
  const service = String(ev.service ?? '');
  const id = ev.id as number | string | undefined;
  return {
    id: String(id ?? Math.random()),
    ip: String(ev.ip ?? ''),
    service,
    country: '??',
    agentName: String(ev.hostname ?? fallbackAgent),
    time: new Date(String(ev.timestamp ?? ev.created_at ?? Date.now())),
    color: liveEventColor(service, evType),
    eventType: feedType(evType),
  };
}

/** `fresh` (newest first) on top of `prev`, without duplicate ids, capped. */
export function mergeLiveEvents(fresh: LiveEvent[], prev: LiveEvent[], cap = LIVE_FEED_CAP): LiveEvent[] {
  if (fresh.length === 0) return prev;
  const ids = new Set(fresh.map(e => e.id));
  return [...fresh, ...prev.filter(e => !ids.has(e.id))].slice(0, cap);
}

/** Older rows (scroll-load) appended below `prev`, without duplicate ids. */
export function appendOlderEvents(prev: LiveEvent[], older: LiveEvent[]): LiveEvent[] {
  const ids = new Set(prev.map(e => e.id));
  return [...prev, ...older.filter(e => !ids.has(e.id))];
}
