import type { Knex } from 'knex';
import { db } from '../db';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { codedError } from '../utils/errorCodes';
import { emitToTenantAudience } from '../utils/socketRooms';
import { getAgentServiceIO } from './agent.service';
import {
  AGENT_COMMAND_CAPABILITY,
  AGENT_COMMAND_TYPES,
  SOCKET_EVENTS,
} from '@obliview/shared';
import type { AgentCommand, AgentCommandStatus, AgentCommandType } from '@obliview/shared';

// ── Agent command queue (W14-1) ───────────────────────────────────────────────
//
// Mirrors Obliance command.service + agentHub _drainPendingCommand/_handleAck,
// reduced to the Obliguard command set (uninstall, restart, firewall_resync):
//   - enqueue: one outstanding command per device and type (partial unique
//     index of migration 042); an uninstall also sets pending_command, the
//     fallback of agents that never ack and the "uninstalling" UI flag;
//   - claim: rows of a device are marked 'sent' before their frame is written
//     (a racing heartbeat never delivers twice); a frame that could not be
//     written goes back to 'queued' (requeue);
//   - ack: 'acked' then 'succeeded' | 'failed', from the device the command
//     was sent to only;
//   - sweep: undelivered rows past expires_at become 'expired', delivered rows
//     without a final result after RESULT_TIMEOUT_MS become 'failed'.
// Agents without the 'cmdqueue' capability only know the config-frame
// uninstall: it is delivered that way (legacy row, no ack possible) and the
// other commands are refused at request time.

/** A restart / resync not delivered within a day is pointless: it expires. */
export const COMMAND_TTL_MS: Readonly<Record<AgentCommandType, number | null>> = {
  uninstall: null, // waits for its agent, like Obliance agent updates
  restart: 24 * 3600_000,
  firewall_resync: 24 * 3600_000,
};

/** Delivered with no final result after this long: 'failed' (the agent never answered). */
export const RESULT_TIMEOUT_MS = 15 * 60_000;

/** Commands delivered per drain (oldest first). */
const DRAIN_LIMIT = 10;

/** Upper bound of a stored result (serialized JSON). */
const MAX_RESULT_CHARS = 4000;

const OPEN_STATUSES: readonly AgentCommandStatus[] = ['queued', 'sent', 'acked'];

export interface AgentCommandRow {
  id: number | string;
  device_id: number;
  tenant_id: number;
  type: AgentCommandType;
  payload: unknown;
  status: AgentCommandStatus;
  result: unknown;
  legacy: boolean;
  created_by: number | null;
  created_by_name?: string | null;
  created_at: Date | string;
  sent_at: Date | string | null;
  acked_at: Date | string | null;
  finished_at: Date | string | null;
  expires_at: Date | string | null;
}

/** What a drain hands to the hub. */
export interface CommandClaim {
  /** Rows to send as { type: 'command' } frames (cmdqueue agents). */
  commands: AgentCommandRow[];
  /** Send { type: 'config', command: 'uninstall' } (agents without cmdqueue). */
  legacyUninstall: boolean;
  /** The legacy uninstall rows claimed (requeued when the frame is not written). */
  legacyRows: AgentCommandRow[];
}

export function isAgentCommandType(v: unknown): v is AgentCommandType {
  return typeof v === 'string' && (AGENT_COMMAND_TYPES as readonly string[]).includes(v);
}

/** Capabilities column / heartbeat list → does it hold `cap`. */
export function hasAgentCapability(raw: unknown, cap: string = AGENT_COMMAND_CAPABILITY): boolean {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return false; } }
  return Array.isArray(v) && v.includes(cap);
}

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function jsonObject(v: unknown): Record<string, unknown> | null {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return null; } }
  return x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null;
}

export function rowToCommand(row: AgentCommandRow): AgentCommand {
  return {
    id: Number(row.id),
    deviceId: row.device_id,
    tenantId: row.tenant_id,
    type: row.type,
    payload: jsonObject(row.payload) ?? {},
    status: row.status,
    result: jsonObject(row.result),
    legacy: !!row.legacy,
    createdBy: row.created_by ?? null,
    createdByName: row.created_by_name ?? null,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    sentAt: iso(row.sent_at),
    ackedAt: iso(row.acked_at),
    finishedAt: iso(row.finished_at),
    expiresAt: iso(row.expires_at),
  };
}

/**
 * A result the agent reported, stored bounded: an object (a bare string
 * becomes { message }), at most MAX_RESULT_CHARS once serialized.
 */
export function sanitizeCommandResult(raw: unknown): Record<string, unknown> | null {
  let obj: Record<string, unknown> | null;
  if (typeof raw === 'string') obj = raw.trim() ? { message: raw.trim() } : null;
  else obj = jsonObject(raw);
  if (!obj) return null;
  let s: string;
  try { s = JSON.stringify(obj); } catch { return { error: 'unserializable result' }; }
  if (s.length <= MAX_RESULT_CHARS) return obj;
  const msg = typeof obj.error === 'string' ? obj.error : typeof obj.message === 'string' ? obj.message : '';
  const key = typeof obj.error === 'string' ? 'error' : 'message';
  return { [key]: msg.slice(0, 1000), truncated: true };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

function emitCommand(row: AgentCommandRow): void {
  try {
    emitToTenantAudience(getAgentServiceIO(), row.tenant_id, SOCKET_EVENTS.AGENT_COMMAND_UPDATED, {
      deviceId: row.device_id,
      command: rowToCommand(row),
    });
  } catch (err) {
    logger.debug({ err }, 'agentCommand: emit failed');
  }
}

const outstanding = (q: Knex.QueryBuilder) => q.whereIn('status', OPEN_STATUSES as AgentCommandStatus[]).whereNull('finished_at');

export const agentCommandService = {
  /**
   * Queue `type` for a device of `tenantId`. Throws 409 commandOutstanding
   * while the same command is still queued, sent or acknowledged.
   */
  async enqueue(data: {
    deviceId: number;
    tenantId: number;
    type: AgentCommandType;
    payload?: Record<string, unknown>;
    createdBy?: number | null;
    now?: Date;
  }): Promise<AgentCommand> {
    const now = data.now ?? new Date();
    const ttl = COMMAND_TTL_MS[data.type];
    let row: AgentCommandRow;
    try {
      row = await db.transaction(async (trx) => {
        // Serialized per device with the deliveries (claim locks the same row).
        const dev = await trx('agent_devices')
          .where({ id: data.deviceId, tenant_id: data.tenantId })
          .forUpdate()
          .first('id') as { id: number } | undefined;
        if (!dev) throw codedError(404, 'AGENT_NOT_FOUND', 'Device not found');
        const open = await outstanding(trx('agent_commands').where({ device_id: data.deviceId, type: data.type }))
          .first('id');
        if (open) throw codedError(409, 'commandOutstanding', 'This command is already pending for this agent');
        const [inserted] = await trx('agent_commands').insert({
          device_id: data.deviceId,
          tenant_id: data.tenantId,
          type: data.type,
          payload: JSON.stringify(data.payload ?? {}),
          status: 'queued',
          created_by: data.createdBy ?? null,
          created_at: now,
          expires_at: ttl === null ? null : new Date(now.getTime() + ttl),
        }).returning('*') as AgentCommandRow[];
        if (data.type === 'uninstall') {
          // Legacy fallback + "uninstalling" flag of the UI and the tenant summary.
          await trx('agent_devices').where({ id: data.deviceId })
            .update({ pending_command: 'uninstall', updated_at: now });
        }
        return inserted;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw codedError(409, 'commandOutstanding', 'This command is already pending for this agent');
      }
      throw err;
    }
    emitCommand(row);
    return rowToCommand(row);
  },

  /**
   * Queue `type` on several devices of `tenantId`; devices with the same
   * command outstanding (or gone) are skipped. Returns the queued device ids.
   */
  async enqueueMany(deviceIds: number[], tenantId: number, type: AgentCommandType, createdBy: number | null): Promise<number[]> {
    const queued: number[] = [];
    for (const deviceId of deviceIds) {
      try {
        await this.enqueue({ deviceId, tenantId, type, createdBy });
        queued.push(deviceId);
      } catch (err) {
        if (err instanceof AppError && (err.statusCode === 409 || err.statusCode === 404)) continue;
        throw err;
      }
    }
    return queued;
  },

  /** One command of a device (with the requester's name), or null. */
  async get(deviceId: number, id: number): Promise<AgentCommand | null> {
    const row = await db('agent_commands as c')
      .leftJoin('users as u', 'u.id', 'c.created_by')
      .where({ 'c.id': id, 'c.device_id': deviceId })
      .first('c.*', db.raw('COALESCE(u.display_name, u.username) AS created_by_name')) as AgentCommandRow | undefined;
    return row ? rowToCommand(row) : null;
  },

  /** History of a device, newest first (with the requester's name). */
  async list(deviceId: number, limit = 50): Promise<AgentCommand[]> {
    const rows = await db('agent_commands as c')
      .leftJoin('users as u', 'u.id', 'c.created_by')
      .where('c.device_id', deviceId)
      .orderBy('c.created_at', 'desc')
      .orderBy('c.id', 'desc')
      .limit(Math.min(Math.max(1, Math.trunc(limit) || 50), 200))
      .select('c.*', db.raw('COALESCE(u.display_name, u.username) AS created_by_name')) as AgentCommandRow[];
    return rows.map(rowToCommand);
  },

  /**
   * Claim what a device gets now. `cmdqueue`: the queued rows (oldest first,
   * at most DRAIN_LIMIT) are marked 'sent' and returned. Otherwise only an
   * uninstall can be delivered (config frame): its row becomes a finished
   * legacy delivery. In both cases a delivered uninstall clears
   * pending_command and sets uninstall_commanded_at (cleanup job); a
   * pending_command='uninstall' without a row (tenant deletion, older
   * request) gets one. Locked per device: concurrent drains never claim the
   * same row twice.
   */
  async claim(deviceId: number, cmdqueue: boolean, now: Date = new Date()): Promise<CommandClaim> {
    const claimed = await db.transaction(async (trx) => {
      const dev = await trx('agent_devices')
        .where({ id: deviceId })
        .forUpdate()
        .first('id', 'tenant_id', 'status', 'pending_command') as
        { id: number; tenant_id: number; status: string; pending_command: string | null } | undefined;
      if (!dev || dev.status !== 'approved') return { rows: [] as AgentCommandRow[], expired: [] as AgentCommandRow[], legacyUninstall: false };

      // Expired first: never delivered late.
      const expired = await trx('agent_commands')
        .where({ device_id: deviceId, status: 'queued' })
        .whereNotNull('expires_at')
        .where('expires_at', '<=', now)
        .update({ status: 'expired', finished_at: now })
        .returning('*') as AgentCommandRow[];

      // A pending_command uninstall with no open row (tenant deletion path).
      if (dev.pending_command === 'uninstall') {
        const open = await outstanding(trx('agent_commands').where({ device_id: deviceId, type: 'uninstall' })).first('id');
        if (!open) {
          await trx('agent_commands').insert({
            device_id: deviceId, tenant_id: dev.tenant_id, type: 'uninstall', status: 'queued', created_at: now,
          });
        }
      }

      let rows: AgentCommandRow[];
      let legacyUninstall = false;
      if (cmdqueue) {
        const ids = await trx('agent_commands')
          .where({ device_id: deviceId, status: 'queued' })
          .orderBy('created_at', 'asc').orderBy('id', 'asc')
          .limit(DRAIN_LIMIT)
          .pluck('id') as Array<number | string>;
        rows = ids.length === 0 ? [] : await trx('agent_commands')
          .whereIn('id', ids)
          .update({ status: 'sent', sent_at: now })
          .returning('*') as AgentCommandRow[];
        rows.sort((a, b) => Number(a.id) - Number(b.id));
      } else {
        rows = await trx('agent_commands')
          .where({ device_id: deviceId, status: 'queued', type: 'uninstall' })
          .update({ status: 'sent', sent_at: now, finished_at: now, legacy: true })
          .returning('*') as AgentCommandRow[];
        legacyUninstall = rows.length > 0;
      }

      if (rows.some((r) => r.type === 'uninstall')) {
        await trx('agent_devices')
          .where({ id: deviceId })
          .update({
            ...(dev.pending_command === 'uninstall' ? { pending_command: null } : {}),
            uninstall_commanded_at: now,
            updated_at: now,
          });
      }
      return { rows, expired, legacyUninstall };
    });
    for (const r of [...claimed.expired, ...claimed.rows]) emitCommand(r);
    return {
      commands: cmdqueue ? claimed.rows : [],
      legacyUninstall: claimed.legacyUninstall,
      legacyRows: cmdqueue ? [] : claimed.rows,
    };
  },

  /**
   * Frames that could not be written go back to the queue (the device gets
   * them on its next contact). An uninstall restores pending_command and
   * clears uninstall_commanded_at, so the cleanup job does not delete an
   * agent that never received it.
   */
  async requeue(rows: AgentCommandRow[]): Promise<void> {
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    // A legacy delivery is finished at claim time: it goes back too.
    const back = await db('agent_commands')
      .whereIn('id', ids)
      .where({ status: 'sent' })
      .where((q) => q.whereNull('finished_at').orWhere('legacy', true))
      .update({ status: 'queued', sent_at: null, finished_at: null, legacy: false })
      .returning('*') as AgentCommandRow[];
    for (const r of back.filter((x) => x.type === 'uninstall')) {
      await db('agent_devices').where({ id: r.device_id })
        .update({ pending_command: 'uninstall', uninstall_commanded_at: null, updated_at: new Date() });
    }
    for (const r of back) emitCommand(r);
  },

  /**
   * The legacy config frame that carried a claimed uninstall (handlePush,
   * agent without 'cmdqueue') was not written: the rows claimed since `since`
   * go back to the queue, so the cleanup job does not delete an agent that
   * never received the command.
   */
  async requeueLegacyUninstall(deviceId: number, since: Date): Promise<void> {
    const rows = await db('agent_commands')
      .where({ device_id: deviceId, type: 'uninstall', status: 'sent', legacy: true })
      .where('sent_at', '>=', since) as AgentCommandRow[];
    await this.requeue(rows);
  },

  /** A command that could not be prepared for delivery (e.g. the ban list): failed. */
  async fail(id: number | string, deviceId: number, error: string): Promise<void> {
    const rows = await db('agent_commands')
      .where({ id, device_id: deviceId })
      .whereIn('status', OPEN_STATUSES as AgentCommandStatus[])
      .update({ status: 'failed', finished_at: new Date(), result: JSON.stringify({ error }) })
      .returning('*') as AgentCommandRow[];
    for (const r of rows) emitCommand(r);
  },

  /**
   * { type: 'command_ack', id, status, result } from `deviceId`. 'acked' only
   * moves a sent row; 'succeeded' / 'failed' close a sent or acked row. Rows
   * of another device, unknown ids and finished rows are ignored. Returns the
   * updated command or null.
   */
  async ack(deviceId: number, rawId: unknown, rawStatus: unknown, rawResult: unknown, now: Date = new Date()): Promise<AgentCommand | null> {
    const idText = typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId.trim() : '';
    if (!/^[1-9][0-9]{0,17}$/.test(idText)) return null;
    if (rawStatus !== 'acked' && rawStatus !== 'succeeded' && rawStatus !== 'failed') return null;
    const result = sanitizeCommandResult(rawResult);

    const q = db('agent_commands').where({ id: idText, device_id: deviceId }).whereNull('finished_at');
    let update: Record<string, unknown>;
    if (rawStatus === 'acked') {
      q.where({ status: 'sent' });
      update = { status: 'acked', acked_at: now, ...(result ? { result: JSON.stringify(result) } : {}) };
    } else {
      q.whereIn('status', ['sent', 'acked']);
      update = {
        status: rawStatus,
        acked_at: db.raw('COALESCE(acked_at, ?)', [now]),
        finished_at: now,
        result: result ? JSON.stringify(result) : null,
      };
    }
    const [row] = await q.update(update).returning('*') as AgentCommandRow[];
    if (!row) return null;
    emitCommand(row);
    if (row.status === 'failed') {
      logger.warn({ deviceId, commandId: row.id, type: row.type, result }, 'Agent command failed');
      // The agent could not start its removal and keeps running: the cleanup
      // job must not delete it.
      if (row.type === 'uninstall') {
        await db('agent_devices').where({ id: deviceId }).update({ uninstall_commanded_at: null, updated_at: now });
      }
    }
    return rowToCommand(row);
  },

  /**
   * Expiry sweep: queued rows past expires_at → 'expired'; rows delivered to
   * a cmdqueue agent with no final result after RESULT_TIMEOUT_MS → 'failed'.
   * Returns the number of rows closed.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const expired = await db('agent_commands')
      .where({ status: 'queued' })
      .whereNotNull('expires_at')
      .where('expires_at', '<=', now)
      .update({ status: 'expired', finished_at: now })
      .returning('*') as AgentCommandRow[];
    const timedOut = await db('agent_commands')
      .whereIn('status', ['sent', 'acked'])
      .whereNull('finished_at')
      .where('sent_at', '<', new Date(now.getTime() - RESULT_TIMEOUT_MS))
      .update({
        status: 'failed',
        finished_at: now,
        result: JSON.stringify({ error: 'No result reported by the agent' }),
      })
      .returning('*') as AgentCommandRow[];
    for (const r of [...expired, ...timedOut]) emitCommand(r);
    return expired.length + timedOut.length;
  },
};
