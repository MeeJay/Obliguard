/**
 * monitors.api.ts — stub file.
 * Monitor functionality has been removed from Obliguard (IPS system).
 * This stub exists to satisfy legacy imports that have not yet been removed.
 */

import type { Monitor, Heartbeat } from '../store/monitorStore';

export const monitorsApi = {
  list: async (): Promise<Monitor[]> => [],
  getSummary: async (): Promise<Record<number, { uptimePct: number; avgResponseTime: number | null }>> => ({}),
  getAllHeartbeats: async (_count?: number): Promise<Record<string, Heartbeat[]>> => ({}),
  getHeartbeatsByPeriod: async (_id: number, _period: string): Promise<Heartbeat[]> => [],
  update: async (_id: number, _data: Partial<Monitor>): Promise<Monitor> => {
    throw new Error('monitors removed from Obliguard');
  },
  bulkUpdate: async (
    _ids: number[],
    _data: Partial<Monitor> & { groupId?: number | null },
  ): Promise<void> => {},
  getById: async (_id: number): Promise<Monitor> => {
    throw new Error('monitors removed from Obliguard');
  },
};

export type { Monitor, Heartbeat };
