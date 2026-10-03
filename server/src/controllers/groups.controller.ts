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
import { dashboardService } from '../services/dashboard.service';
import { auditService } from '../services/audit.service';
import { requestAgentScope, scopeAgentIds } from '../services/agentScope.service';
import type { AgentGroupConfig, MonitorGroup } from '@obliview/shared';
import { MASTER_TENANT_ID, SOCKET_EVENTS } from '@obliview/shared';

/**
 * Keys accepted in PATCH /groups/:id/agent-config (agentGroupConfig), the
 * compat endpoint of the IPS settings cascade (W13-1): pushIntervalSeconds
 * (= checkIntervalSeconds), maxMissedPushes and notificationTypes become group
 * settings rows (groupService.updateAgentGroupConfig, validated: 400);
 * updatePolicy stays in the C17 storage (owner directive).
 */
const AGENT_GROUP_CONFIG_KEYS = ['pushIntervalSeconds', 'maxMissedPushes', 'notificationTypes', 'updatePolicy'] as const;

const FOREIGN_GROUP_READ_ONLY = 'This group belongs to another tenant: read-only from the Default tenant';

/**
 * Group creation by a non-platform-admin (groups.manage is checked by the
 * route): the tenant admin (team scope bypassed, W7-1), a team of the
 * operating tenant with canCreate, or RW on the parent group (a sub-group of a
 * group the user may already write).
 */
async function canCreateGroup(userId: number, tenantId: number, parentId: number | null): Promise<boolean> {
  if (await permissionService.bypassesTeamScope(userId, false, tenantId)) return true;
  if (await permissionService.canCreate(userId, false, tenantId)) return true;
  return parentId != null && await permissionService.canWriteGroup(userId, parentId, false, tenantId);
}

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

  /**
   * GET /dashboard/groups — per-group dashboard cards (W8-4): agents,
   * connected, events / failures / bans of the last 24 h. Groups follow the
   * list() visibility, agents and their events the team agent scope.
   */
  async stats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const visibleGroups = req.session.role === 'admin'
        ? 'all' as const
        : await permissionService.getVisibleGroupIds(req.session.userId!, false, req.tenantId);
      const visibleAgents = scopeAgentIds(await requestAgentScope(req));
      const data = await dashboardService.getGroupStats(req.tenantId, visibleGroups, visibleAgents);
      res.json({ success: true, data });
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

      if (req.session.role !== 'admin'
        && !(await canCreateGroup(req.session.userId!, req.tenantId, data.parentId ?? null))) {
        throw new AppError(403, 'Insufficient permissions');
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
      emitToTenantAudience(req.app.get('io'), group.tenantId ?? req.tenantId, SOCKET_EVENTS.GROUP_CREATED, { group });
      await auditService.logReq(req, {
        action: 'group.created', targetType: 'group', targetId: group.id,
        details: { name: group.name, parentId: group.parentId ?? null },
      });

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

      emitToTenantAudience(req.app.get('io'), group.tenantId ?? req.tenantId, SOCKET_EVENTS.GROUP_UPDATED, { group });
      await auditService.logReq(req, {
        action: 'group.updated', targetType: 'group', targetId: id,
        details: { name: group.name, fields: Object.keys(data ?? {}) },
      });

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
      if (!isAdmin && newParentId !== null
        && !(await permissionService.bypassesTeamScope(req.session.userId!, false, req.tenantId))) {
        const canWriteTarget = await permissionService.canWriteGroup(req.session.userId!, newParentId, false, req.tenantId);
        if (!canWriteTarget) throw new AppError(403, 'No write permission on target group');
      }

      const group = await groupService.move(id, newParentId);
      if (!group) throw new AppError(404, 'Group not found');

      emitToTenantAudience(req.app.get('io'), group.tenantId ?? req.tenantId, SOCKET_EVENTS.GROUP_MOVED, { group });
      await auditService.logReq(req, {
        action: 'group.moved', targetType: 'group', targetId: id,
        details: { name: group.name, newParentId },
      });

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

      emitToTenantAudience(req.app.get('io'), owner?.tenantId ?? req.tenantId, SOCKET_EVENTS.GROUP_DELETED, { groupId: id });
      await auditService.logReq(req, { action: 'group.deleted', targetType: 'group', targetId: id, details: { name: owner?.name ?? null } });

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
      // A team member (no tenant-admin bypass) needs RW on every reordered group:
      // the group pages offer Position to groups.manage holders (W10-4).
      if (req.session.role !== 'admin'
        && !(await permissionService.bypassesTeamScope(req.session.userId!, false, req.tenantId))) {
        for (const item of items) {
          if (!(await permissionService.canWriteGroup(req.session.userId!, item.id, false, req.tenantId))) {
            throw new AppError(403, 'No write permission on this group');
          }
        }
      }
      await groupService.reorder(items, req.tenantId);

      // Reordering is tenant-local (drag-and-drop of the operating tenant).
      emitToTenantAudience(req.app.get('io'), req.tenantId, SOCKET_EVENTS.GROUP_REORDERED, { items });
      await auditService.logReq(req, { action: 'group.reordered', targetType: 'group', details: { groups: items.map((i) => i.id) } });

      res.json({ success: true, message: 'Groups reordered' });
    } catch (err) {
      next(err);
    }
  },

  /**
   * PATCH /groups/:id/agent-config — update agent group config (thresholds +
   * group settings). groups.manage (route) on a group of the operating tenant;
   * the update policy itself stays platform-admin only (owner directive C17).
   */
  async updateAgentGroupConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);

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
        if ('updatePolicy' in out && req.session.role !== 'admin') {
          throw new AppError(403, 'The agent update policy is managed by platform administrators');
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
      if (clean !== undefined || agentThresholds !== undefined) {
        await auditService.logReq(req, {
          action: 'group.agent_config_updated', targetType: 'group', targetId: groupId,
          details: {
            name: group.name,
            ...(clean !== undefined ? { config: clean } : {}),
            ...(agentThresholds !== undefined ? { thresholdsChanged: true } : {}),
            ...(clean && 'updatePolicy' in clean ? { updatePolicyFrom: group.agentGroupConfig?.updatePolicy ?? null } : {}),
          },
        });
      }

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  },
};
