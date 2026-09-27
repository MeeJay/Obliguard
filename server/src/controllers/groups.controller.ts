import type { Request, Response, NextFunction } from 'express';
import { groupService } from '../services/group.service';
import { permissionService } from '../services/permission.service';
import { teamService } from '../services/team.service';
import { groupNotificationService } from '../services/groupNotification.service';
import { AppError } from '../middleware/errorHandler';
import type { CreateGroupInput, UpdateGroupInput, MoveGroupInput } from '../validators/group.schema';
import { deviceAccessVerdict } from '../utils/tenantWriteRules';
import { isAgentUpdatePolicy } from '../utils/agentUpdate';
import { invalidateAgentUpdatePolicyCache } from '../services/agent.service';
import { logger } from '../utils/logger';
import type { AgentGroupConfig } from '@obliview/shared';
import { MASTER_TENANT_ID } from '@obliview/shared';

/** Keys accepted in PATCH /groups/:id/agent-config (agentGroupConfig). */
const AGENT_GROUP_CONFIG_KEYS = ['pushIntervalSeconds', 'heartbeatMonitoring', 'maxMissedPushes', 'notificationTypes', 'updatePolicy'] as const;

export const groupsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const allGroups = await groupService.getAll(req.tenantId);

      if (isAdmin) {
        res.json({ success: true, data: allGroups });
        return;
      }

      const visibleIds = await permissionService.getVisibleGroupIds(req.session.userId!, false);
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

      const visibleIds = await permissionService.getVisibleGroupIds(req.session.userId!, false);
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
      const group = await groupService.getById(id);
      if (!group) throw new AppError(404, 'Group not found');

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadGroup(req.session.userId!, id, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      res.json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateGroupInput;

      // Validate parent exists if specified
      if (data.parentId) {
        const parent = await groupService.getById(data.parentId);
        if (!parent) throw new AppError(400, 'Parent group not found');
      }

      const group = await groupService.create(data, req.tenantId);

      // Auto-assign RW to creator's teams that have canCreate
      if (req.session.role !== 'admin') {
        const userTeams = await teamService.getUserTeams(req.session.userId!);
        for (const team of userTeams) {
          if (team.canCreate) {
            await teamService.addPermission(team.id, 'group', group.id, 'rw');
          }
        }
      }

      // Broadcast via Socket.io
      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('group:created', { group });
      }

      res.status(201).json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const data = req.body as UpdateGroupInput;
      const group = await groupService.update(id, data);

      if (!group) throw new AppError(404, 'Group not found');

      if (data.groupNotifications !== undefined) {
        groupNotificationService.removeGroup(id);
      }

      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('group:updated', { group });
      }

      res.json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async move(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { newParentId } = req.body as MoveGroupInput;

      // Also check write permission on target parent if non-admin
      const isAdmin = req.session.role === 'admin';
      if (!isAdmin && newParentId !== null) {
        const canWriteTarget = await permissionService.canWriteGroup(req.session.userId!, newParentId, false);
        if (!canWriteTarget) throw new AppError(403, 'No write permission on target group');
      }

      const group = await groupService.move(id, newParentId);
      if (!group) throw new AppError(404, 'Group not found');

      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('group:moved', { group });
      }

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

      groupNotificationService.removeGroup(id);

      const deleted = await groupService.delete(id);
      if (!deleted) throw new AppError(404, 'Group not found');

      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('group:deleted', { groupId: id });
      }

      res.json({ success: true, message: 'Group deleted' });
    } catch (err) {
      next(err);
    }
  },

  /** Stub: no monitors/heartbeats in Obliguard */
  async stats(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: {} });
    } catch (err) {
      next(err);
    }
  },

  /** Stub: no monitors/heartbeats in Obliguard */
  async clearHeartbeats(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: { deleted: 0, monitorCount: 0 } });
    } catch (err) {
      next(err);
    }
  },

  async reorder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const items = req.body.items as { id: number; sortOrder: number }[];
      if (!Array.isArray(items) || items.length === 0) {
        throw new AppError(400, 'items array is required');
      }
      await groupService.reorder(items);

      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('group:reordered', { items });
      }

      res.json({ success: true, message: 'Groups reordered' });
    } catch (err) {
      next(err);
    }
  },

  /** Stub: no monitors in Obliguard */
  async getMonitors(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: [] });
    } catch (err) {
      next(err);
    }
  },

  /** Stub: no heartbeats in Obliguard */
  async heartbeats(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: [] });
    } catch (err) {
      next(err);
    }
  },

  /** Stub: no heartbeat stats in Obliguard */
  async groupDetailStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: { total: 0, up: 0, uptimePct: 100 } });
    } catch (err) {
      next(err);
    }
  },

  /** PATCH /groups/:id/agent-config — update agent group config (thresholds + group settings) */
  async updateAgentGroupConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      if (req.session.role !== 'admin') throw new AppError(403, 'Admin only');

      const group = await groupService.getById(groupId);
      if (!group) throw new AppError(404, 'Group not found');
      // Operating tenant only, no platform-admin bypass (C17-1): read-only
      // from the Default tenant (403), invisible elsewhere (404).
      const verdict = deviceAccessVerdict(group.tenantId ?? MASTER_TENANT_ID, req.tenantId, 'write');
      if (verdict === 'forbidden') throw new AppError(403, 'This group belongs to another tenant: read-only from the Default tenant');
      if (verdict !== 'ok') throw new AppError(404, 'Group not found');
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
