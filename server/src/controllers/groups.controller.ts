import type { Request, Response, NextFunction } from 'express';
import { groupService } from '../services/group.service';
import { permissionService } from '../services/permission.service';
import { teamService } from '../services/team.service';
import { AppError } from '../middleware/errorHandler';
import type { CreateGroupInput, UpdateGroupInput, MoveGroupInput } from '../validators/group.schema';
import { deviceAccessVerdict } from '../utils/tenantWriteRules';
import { isAgentUpdatePolicy } from '../utils/agentUpdate';
import { agentService, invalidateAgentUpdatePolicyCache } from '../services/agent.service';
import { logger } from '../utils/logger';
import { emitToTenantAudience } from '../utils/socketRooms';
import type { AgentGroupConfig, MonitorGroup } from '@obliview/shared';
import { MASTER_TENANT_ID } from '@obliview/shared';

/** Keys accepted in PATCH /groups/:id/agent-config (agentGroupConfig). */
const AGENT_GROUP_CONFIG_KEYS = ['pushIntervalSeconds', 'maxMissedPushes', 'notificationTypes', 'updatePolicy'] as const;

const FOREIGN_GROUP_READ_ONLY = 'This group belongs to another tenant: read-only from the Default tenant';

/**
 * Load a group bound to the operating tenant (owner model, A5): reads may
 * cross tenants from the Default tenant (god view); writes follow the
 * operating tenant, platform role included: 403 from Default, 404 elsewhere.
 */
async function loadGroup(id: number, tenantId: number, mode: 'read' | 'write'): Promise<MonitorGroup> {
  if (isNaN(id)) throw new AppError(400, 'Invalid group ID');
  const group = await groupService.getById(id);
  if (!group) throw new AppError(404, 'Group not found');
  const verdict = deviceAccessVerdict(group.tenantId ?? MASTER_TENANT_ID, tenantId, mode);
  if (verdict === 'forbidden') throw new AppError(403, FOREIGN_GROUP_READ_ONLY);
  if (verdict !== 'ok') throw new AppError(404, 'Group not found');
  return group;
}

export const groupsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const allGroups = await groupService.getAll(req.tenantId);

      if (isAdmin) {
        res.json({ success: true, data: allGroups });
        return;
      }

      const visibleIds = await permissionService.getVisibleGroupIds(req.session.userId!, false, req.tenantId);
      if (visibleIds === 'all') {
        res.json({ success: true, data: allGroups });
        return;
      }

      const visibleSet = new Set(visibleIds);
      const filtered = allGroups.filter((g) => visibleSet.has(g.id));
      res.json({ success: true, data: filtered });
    } catch (err) {
      next(err);
    }
  },

  async tree(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const tree = await groupService.getTree(req.tenantId);

      if (isAdmin) {
        res.json({ success: true, data: tree });
        return;
      }

      const visibleIds = await permissionService.getVisibleGroupIds(req.session.userId!, false, req.tenantId);
      if (visibleIds === 'all') {
        res.json({ success: true, data: tree });
        return;
      }

      // Filter tree to only include visible groups
      const visibleSet = new Set(visibleIds);
      function filterTree(nodes: typeof tree): typeof tree {
        return nodes
          .filter((n) => visibleSet.has(n.id))
          .map((n) => ({ ...n, children: filterTree(n.children) }));
      }
      res.json({ success: true, data: filterTree(tree) });
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const group = await loadGroup(id, req.tenantId, 'read');

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadGroup(req.session.userId!, id, false, req.tenantId);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      res.json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Obliview leftovers accepted from old clients: groupNotifications is
      // ignored, and every group is an agent group (no 'monitor' kind).
      const { groupNotifications: _ignored, kind: _kind, ...rest } = req.body as CreateGroupInput;
      const data = { ...rest, kind: 'agent' as const };

      // The parent must exist in the operating tenant (no Default bypass).
      if (data.parentId) {
        const parent = await groupService.getById(data.parentId);
        const verdict = parent ? deviceAccessVerdict(parent.tenantId ?? MASTER_TENANT_ID, req.tenantId, 'write') : 'not-found';
        if (verdict === 'forbidden') throw new AppError(403, FOREIGN_GROUP_READ_ONLY);
        if (verdict !== 'ok') throw new AppError(400, 'Parent group not found');
      }

      const group = await groupService.create(data, req.tenantId);

      // Auto-assign RW to the creator's teams of this tenant that have canCreate
      if (req.session.role !== 'admin') {
        const userTeams = await teamService.getUserTeams(req.session.userId!);
        for (const team of userTeams) {
          if (team.canCreate && Number(team.tenantId) === Number(group.tenantId)) {
            await teamService.addPermission(team.id, 'group', group.id, 'rw');
          }
        }
      }

      // Broadcast via Socket.io (owning tenant + Default)
      emitToTenantAudience(req.app.get('io'), group.tenantId ?? req.tenantId, 'group:created', { group });

      res.status(201).json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await loadGroup(id, req.tenantId, 'write');
      // groupNotifications is an Obliview leftover: accepted from old clients, ignored.
      const { groupNotifications: _ignored, ...data } = req.body as UpdateGroupInput;
      const group = await groupService.update(id, data);

      if (!group) throw new AppError(404, 'Group not found');

      emitToTenantAudience(req.app.get('io'), group.tenantId ?? req.tenantId, 'group:updated', { group });

      res.json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async move(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { newParentId } = req.body as MoveGroupInput;

      // Both the group and its new parent belong to the operating tenant.
      await loadGroup(id, req.tenantId, 'write');
      if (newParentId !== null) await loadGroup(newParentId, req.tenantId, 'write');

      // Also check write permission on target parent if non-admin
      const isAdmin = req.session.role === 'admin';
      if (!isAdmin && newParentId !== null) {
        const canWriteTarget = await permissionService.canWriteGroup(req.session.userId!, newParentId, false, req.tenantId);
        if (!canWriteTarget) throw new AppError(403, 'No write permission on target group');
      }

      const group = await groupService.move(id, newParentId);
      if (!group) throw new AppError(404, 'Group not found');

      emitToTenantAudience(req.app.get('io'), group.tenantId ?? req.tenantId, 'group:moved', { group });

      res.json({ success: true, data: group });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('circular')) {
        next(new AppError(400, err.message));
      } else {
        next(err);
      }
    }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      // Owning tenant, read before the row is gone (audience of the emit).
      const owner = await loadGroup(id, req.tenantId, 'write');

      const deleted = await groupService.delete(id);
      if (!deleted) throw new AppError(404, 'Group not found');

      emitToTenantAudience(req.app.get('io'), owner?.tenantId ?? req.tenantId, 'group:deleted', { groupId: id });

      res.json({ success: true, message: 'Group deleted' });
    } catch (err) {
      next(err);
    }
  },

  async reorder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const items = req.body?.items as { id: number; sortOrder: number }[];
      if (!Array.isArray(items) || items.length === 0) {
        throw new AppError(400, 'items array is required');
      }
      if (!items.every((i) => i && Number.isInteger(i.id) && Number.isInteger(i.sortOrder))) {
        throw new AppError(400, 'Each item needs an integer id and sortOrder');
      }
      // Every reordered group belongs to the operating tenant (no Default bypass).
      const owners = await groupService.getTenantIds(items.map((i) => i.id));
      for (const item of items) {
        const owner = owners.get(item.id);
        const verdict = owner === undefined ? 'not-found' : deviceAccessVerdict(owner, req.tenantId, 'write');
        if (verdict === 'forbidden') throw new AppError(403, FOREIGN_GROUP_READ_ONLY);
        if (verdict !== 'ok') throw new AppError(404, 'Group not found');
      }
      await groupService.reorder(items, req.tenantId);

      // Reordering is tenant-local (drag-and-drop of the operating tenant).
      emitToTenantAudience(req.app.get('io'), req.tenantId, 'group:reordered', { items });

      res.json({ success: true, message: 'Groups reordered' });
    } catch (err) {
      next(err);
    }
  },

  /** PATCH /groups/:id/agent-config — update agent group config (thresholds + group settings) */
  async updateAgentGroupConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      if (req.session.role !== 'admin') throw new AppError(403, 'Admin only');

      // Operating tenant only, no platform-admin bypass (C17-1): read-only
      // from the Default tenant (403), invisible elsewhere (404).
      const group = await loadGroup(groupId, req.tenantId, 'write');
      if (group.kind !== 'agent') throw new AppError(400, 'Not an agent group');

      const { agentGroupConfig, agentThresholds } = req.body as {
        agentGroupConfig?: unknown;
        agentThresholds?: unknown;
      };
      if (agentGroupConfig !== undefined
        && (agentGroupConfig === null || typeof agentGroupConfig !== 'object' || Array.isArray(agentGroupConfig))) {
        throw new AppError(400, 'agentGroupConfig must be an object');
      }

      // Known keys only: unknown keys are dropped, never merged blindly.
      let clean: Partial<AgentGroupConfig> | undefined;
      if (agentGroupConfig !== undefined) {
        const src = agentGroupConfig as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of AGENT_GROUP_CONFIG_KEYS) {
          if (k in src) out[k] = src[k];
        }
        if ('updatePolicy' in out && out.updatePolicy !== null && !isAgentUpdatePolicy(out.updatePolicy)) {
          throw new AppError(400, 'Invalid updatePolicy');
        }
        clean = out as Partial<AgentGroupConfig>;
      }

      let updated = group;
      if (clean !== undefined) {
        updated = (await groupService.updateAgentGroupConfig(groupId, clean)) ?? updated;
        invalidateAgentUpdatePolicyCache();
        if ('updatePolicy' in clean) {
          if (clean.updatePolicy === 'off') await agentService.cancelOpenAttemptsForGroup(groupId);
          logger.info({
            event: 'agent_update_group_policy', userId: req.session.userId, tenantId: req.tenantId, groupId, to: clean.updatePolicy ?? null,
          }, 'Group agent update policy changed');
        }
      }
      if (agentThresholds !== undefined) {
        updated = (await groupService.updateAgentThresholds(groupId, agentThresholds as any)) ?? updated;
      }

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  },
};
