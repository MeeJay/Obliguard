import type { Request, Response, NextFunction } from 'express';
import type { SettingLevel, SettingRawValue } from '@obliview/shared';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { settingsService, writableDefinition, normalizeSettingValue } from '../services/settings.service';
import type { SettingTarget } from '../services/settings.service';
import { agentConfigService } from '../services/agentConfig.service';
import { groupService } from '../services/group.service';
import { permissionService } from '../services/permission.service';
import { resolveRequestAgent } from '../services/agentScope.service';
import { AppError } from '../middleware/errorHandler';
import { deviceAccessVerdict } from '../utils/tenantWriteRules';
import { emitGlobal, emitToTenantAudience } from '../utils/socketRooms';
import { auditService } from '../services/audit.service';

/**
 * IPS settings cascade (W13-1): one tenant-scoped model resolved by the
 * server (global -> tenant -> group chain -> agent, source reported).
 *
 *   level   read                          write
 *   global  platform admin                platform admin, Default tenant only
 *   tenant  member of the tenant          'settings' capability, own tenant
 *   group   member (Default: god view)    groups.manage + RW on the group, own tenant
 *   agent   member with read access       agents.manage + RW on the agent, own tenant
 *
 * Writes follow the operating tenant (no platform bypass: switch tenant), as
 * every other tenant-owned object (utils/tenantWriteRules).
 */

const FOREIGN_READ_ONLY = 'This belongs to another tenant: read-only from the Default tenant';

function parseId(raw: unknown, what: string): number {
  const n = typeof raw === 'string' && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n > 2147483647) throw new AppError(400, `Invalid ${what} ID`);
  return n;
}

function verdictError(verdict: ReturnType<typeof deviceAccessVerdict>, notFound: string): AppError | null {
  if (verdict === 'forbidden') return new AppError(403, FOREIGN_READ_ONLY);
  if (verdict !== 'ok') return new AppError(404, notFound);
  return null;
}

/** The scope a request reads or writes, access checked (AppError otherwise). */
async function resolveTarget(req: Request, level: SettingLevel, mode: 'read' | 'write'): Promise<SettingTarget> {
  const operating = Number(req.tenantId);
  switch (level) {
    case 'global':
      // The route guards the platform role (and the Default tenant for writes).
      return { level, scopeId: null, tenantId: MASTER_TENANT_ID };
    case 'tenant': {
      // Reads: the operating tenant; writes name it explicitly (stale tab => 403/404).
      const id = mode === 'read' ? operating : parseId(req.params.scopeId, 'tenant');
      const err = verdictError(deviceAccessVerdict(id, operating, mode), 'Tenant not found');
      if (err) throw err;
      return { level, scopeId: id, tenantId: id };
    }
    case 'group': {
      const id = parseId(req.params.scopeId, 'group');
      const group = await groupService.getById(id);
      if (!group || group.kind !== 'agent') throw new AppError(404, 'Group not found');
      const owner = Number(group.tenantId ?? MASTER_TENANT_ID);
      const err = verdictError(deviceAccessVerdict(owner, operating, mode), 'Group not found');
      if (err) throw err;
      // Reads follow the team scope too (groupsController.getById).
      if (mode === 'read' && req.session.role !== 'admin'
        && !(await permissionService.canReadGroup(req.session.userId!, id, false, operating))) {
        throw new AppError(403, 'Access denied');
      }
      if (mode === 'write' && req.session.role !== 'admin'
        && !(await permissionService.bypassesTeamScope(req.session.userId!, false, operating))
        && !(await permissionService.canWriteGroup(req.session.userId!, id, false, operating))) {
        throw new AppError(403, 'Insufficient permissions');
      }
      return { level, scopeId: id, tenantId: owner };
    }
    case 'agent': {
      const r = await resolveRequestAgent(req, req.params.scopeId, mode);
      if (!r.ok) throw new AppError(r.status, r.error);
      return { level, scopeId: Number(r.agent.id), tenantId: Number(r.agent.tenant_id) };
    }
  }
}

/** Audit row of a settings write (global: instance-level, tenant NULL). */
function auditSettings(req: Request, action: string, target: SettingTarget, details: Record<string, unknown>): Promise<void> {
  return auditService.logReq(req, {
    action,
    targetType: target.level === 'global' || target.level === 'tenant' ? 'settings' : target.level,
    targetId: target.level === 'global' ? 'global' : target.scopeId,
    ...(target.level === 'agent' ? { deviceId: target.scopeId } : {}),
    tenantId: target.level === 'global' ? null : target.tenantId,
    details: { scope: target.level, scopeId: target.scopeId, ...details },
  });
}

/** settings:updated to whoever the level applies to (global: every tenant). */
function emitSettingsUpdated(req: Request, target: SettingTarget, payload: Record<string, unknown>): void {
  const io = req.app.get('io');
  if (!io) return;
  const body = { scope: target.level, scopeId: target.scopeId, ...payload };
  if (target.level === 'global') emitGlobal(io, 'settings:updated', body);
  else emitToTenantAudience(io, target.tenantId, 'settings:updated', body);
}

function bodyEntries(req: Request): Array<{ key: string; value: unknown }> {
  const b = req.body as { key?: unknown; value?: unknown } | undefined;
  if (!b || typeof b !== 'object' || typeof b.key !== 'string' || !('value' in b) || b.value === null) {
    throw new AppError(400, 'Body must be { key, value } (DELETE resets a key)');
  }
  return [{ key: b.key, value: b.value }];
}

function bulkEntries(req: Request): Array<{ key: string; value: unknown }> {
  const list = (req.body as { overrides?: unknown } | undefined)?.overrides;
  if (!Array.isArray(list) || list.length === 0 || list.length > 20) {
    throw new AppError(400, 'overrides must be a non-empty array of { key, value } (value null resets)');
  }
  return list.map((o) => {
    if (!o || typeof o !== 'object' || typeof (o as { key?: unknown }).key !== 'string' || !('value' in o)) {
      throw new AppError(400, 'overrides must be a non-empty array of { key, value } (value null resets)');
    }
    return { key: (o as { key: string }).key, value: (o as { value: unknown }).value };
  });
}

/** Written values for the audit trail / event (validated, as stored). */
function describe(level: SettingLevel, entries: Array<{ key: string; value: unknown }>): Array<{ setting: string; value: SettingRawValue | null }> {
  return entries.map((e) => {
    const def = writableDefinition(e.key, level);
    return { setting: def.key, value: e.value === null ? null : normalizeSettingValue(def, e.value) };
  });
}

export const settingsController = {
  /** GET /api/settings/:level[/:scopeId]/resolved */
  getResolved(level: SettingLevel) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const target = await resolveTarget(req, level, 'read');
        const data = await agentConfigService.getScopeView(level, target.scopeId, level === 'global' ? null : target.tenantId);
        res.json({ success: true, data });
      } catch (err) {
        next(err);
      }
    };
  },

  /** PUT /api/settings/:level/:scopeId  { key, value }  and  .../bulk  { overrides: [{ key, value|null }] } */
  set(level: SettingLevel, bulk = false) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const entries = bulk ? bulkEntries(req) : bodyEntries(req);
        const settings = describe(level, entries); // validates every entry first (400)
        const target = await resolveTarget(req, level, 'write');
        await settingsService.writeMany(target, entries);
        await auditSettings(req, 'settings.updated', target, bulk ? { settings } : settings[0]);
        emitSettingsUpdated(req, target, bulk ? { overrides: settings } : { key: settings[0].setting, value: settings[0].value });
        const data = await agentConfigService.getScopeView(level, target.scopeId, level === 'global' ? null : target.tenantId);
        res.json({ success: true, data });
      } catch (err) {
        next(err);
      }
    };
  },

  /** DELETE /api/settings/:level/:scopeId/:key — back to the inherited value. */
  reset(level: SettingLevel) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const def = writableDefinition(req.params.key, level);
        const target = await resolveTarget(req, level, 'write');
        await settingsService.write(target, def.key, null);
        await auditSettings(req, 'settings.reset', target, { setting: def.key });
        emitSettingsUpdated(req, target, { key: def.key, removed: true });
        const data = await agentConfigService.getScopeView(level, target.scopeId, level === 'global' ? null : target.tenantId);
        res.json({ success: true, data });
      } catch (err) {
        next(err);
      }
    };
  },
};
