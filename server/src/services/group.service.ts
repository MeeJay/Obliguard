import { db } from '../db';
import type { MonitorGroup, GroupTreeNode, AgentThresholds, AgentGroupConfig } from '@obliview/shared';

interface GroupRow {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  parent_id: number | null;
  sort_order: number;
  is_general: boolean;
  group_notifications: boolean;
  kind: string;
  tenant_id: number;
  agent_thresholds?: AgentThresholds | null;
  agent_group_config?: AgentGroupConfig | null;
  created_at: Date;
  updated_at: Date;
}

function rowToGroup(row: GroupRow): MonitorGroup {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    isGeneral: row.is_general,
    groupNotifications: row.group_notifications,
    kind: (row.kind as MonitorGroup['kind']) || 'monitor',
    agentThresholds: row.agent_thresholds
      ? (typeof row.agent_thresholds === 'string' ? JSON.parse(row.agent_thresholds) : row.agent_thresholds)
      : null,
    agentGroupConfig: row.agent_group_config
      ? (typeof row.agent_group_config === 'string' ? JSON.parse(row.agent_group_config) : row.agent_group_config)
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function ensureUniqueSlug(slug: string, excludeId?: number): Promise<string> {
  let candidate = slug;
  let i = 1;
  while (true) {
    const q = db('monitor_groups').where({ slug: candidate });
    if (excludeId) q.whereNot({ id: excludeId });
    const exists = await q.first();
    if (!exists) return candidate;
    candidate = `${slug}-${i++}`;
  }
}

export const groupService = {
  async getAll(tenantId: number): Promise<MonitorGroup[]> {
    const rows = await db<GroupRow>('monitor_groups').where({ tenant_id: tenantId }).orderBy('sort_order').orderBy('name');
    return rows.map(rowToGroup);
  },

  async getById(id: number): Promise<MonitorGroup | null> {
    const row = await db<GroupRow>('monitor_groups').where({ id }).first();
    return row ? rowToGroup(row) : null;
  },

  async create(data: {
    name: string;
    description?: string | null;
    parentId?: number | null;
    sortOrder?: number;
    isGeneral?: boolean;
    groupNotifications?: boolean;
    kind?: 'monitor' | 'agent';
  }, tenantId: number): Promise<MonitorGroup> {
    const slug = await ensureUniqueSlug(slugify(data.name));

    const [row] = await db<GroupRow>('monitor_groups')
      .insert({
        name: data.name,
        slug,
        description: data.description ?? null,
        parent_id: data.parentId ?? null,
        sort_order: data.sortOrder ?? 0,
        is_general: data.isGeneral ?? false,
        group_notifications: data.groupNotifications ?? false,
        kind: data.kind ?? 'monitor',
        tenant_id: tenantId,
      })
      .returning('*');

    // Maintain closure table
    // Self-reference (depth 0)
    await db('group_closure').insert({
      ancestor_id: row.id,
      descendant_id: row.id,
      depth: 0,
    });

    // Copy ancestor paths from parent
    if (data.parentId) {
      await db.raw(
        `INSERT INTO group_closure (ancestor_id, descendant_id, depth)
         SELECT gc.ancestor_id, ?, gc.depth + 1
         FROM group_closure gc
         WHERE gc.descendant_id = ?`,
        [row.id, data.parentId],
      );
    }

    return rowToGroup(row);
  },

  async update(
    id: number,
    data: {
      name?: string;
      description?: string | null;
      sortOrder?: number;
      isGeneral?: boolean;
      groupNotifications?: boolean;
    },
  ): Promise<MonitorGroup | null> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };

    if (data.name !== undefined) {
      updateData.name = data.name;
      updateData.slug = await ensureUniqueSlug(slugify(data.name), id);
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.sortOrder !== undefined) updateData.sort_order = data.sortOrder;
    if (data.isGeneral !== undefined) updateData.is_general = data.isGeneral;
    if (data.groupNotifications !== undefined) updateData.group_notifications = data.groupNotifications;

    const [row] = await db<GroupRow>('monitor_groups')
      .where({ id })
      .update(updateData)
      .returning('*');

    return row ? rowToGroup(row) : null;
  },

  async move(id: number, newParentId: number | null): Promise<MonitorGroup | null> {
    // Get current group
    const group = await db<GroupRow>('monitor_groups').where({ id }).first();
    if (!group) return null;

    // Prevent circular reference: newParentId must not be a descendant of id
    if (newParentId !== null) {
      const isDescendant = await db('group_closure')
        .where({ ancestor_id: id, descendant_id: newParentId })
        .first();
      if (isDescendant) {
        throw new Error('Cannot move group into its own descendant');
      }
    }

    // Get all descendants of the subtree (including self)
    const subtreeIds = await db('group_closure')
      .where({ ancestor_id: id })
      .select('descendant_id');
    const descIds = subtreeIds.map((r) => r.descendant_id);

    // Remove all closure entries where ancestor is NOT in the subtree
    // but descendant IS in the subtree (these are the "outside" links)
    await db('group_closure')
      .whereIn('descendant_id', descIds)
      .whereNotIn('ancestor_id', descIds)
      .del();

    // Reconnect: for each ancestor of newParent, create links to every node in subtree
    if (newParentId !== null) {
      await db.raw(
        `INSERT INTO group_closure (ancestor_id, descendant_id, depth)
         SELECT p.ancestor_id, s.descendant_id, p.depth + s.depth + 1
         FROM group_closure p
         CROSS JOIN group_closure s
         WHERE p.descendant_id = ?
           AND s.ancestor_id = ?`,
        [newParentId, id],
      );
    }

    // Update the parent_id column
    const [row] = await db<GroupRow>('monitor_groups')
      .where({ id })
      .update({ parent_id: newParentId, updated_at: new Date() })
      .returning('*');

    return row ? rowToGroup(row) : null;
  },

  async delete(id: number): Promise<boolean> {
    // CASCADE in the DB handles closure table and child groups
    const count = await db('monitor_groups').where({ id }).del();
    return count > 0;
  },

  // ── Tree queries using closure table ──

  async getAncestors(groupId: number): Promise<MonitorGroup[]> {
    const rows = await db<GroupRow>('monitor_groups')
      .join('group_closure', 'monitor_groups.id', 'group_closure.ancestor_id')
      .where('group_closure.descendant_id', groupId)
      .where('group_closure.depth', '>', 0)
      .orderBy('group_closure.depth', 'desc')
      .select('monitor_groups.*');
    return rows.map(rowToGroup);
  },

  async getDescendantIds(groupId: number): Promise<number[]> {
    const rows = await db('group_closure')
      .where({ ancestor_id: groupId })
      .select('descendant_id');
    return rows.map((r) => r.descendant_id);
  },

  async getChildren(parentId: number | null): Promise<MonitorGroup[]> {
    const query = db<GroupRow>('monitor_groups').orderBy('sort_order').orderBy('name');
    if (parentId === null) {
      query.whereNull('parent_id');
    } else {
      query.where({ parent_id: parentId });
    }
    const rows = await query;
    return rows.map(rowToGroup);
  },

  async getTree(tenantId: number): Promise<GroupTreeNode[]> {
    const allGroups = await this.getAll(tenantId);
    const groupMap = new Map<number, GroupTreeNode>();

    // Initialize nodes
    for (const g of allGroups) {
      groupMap.set(g.id, { ...g, children: [] });
    }

    // Build tree
    const roots: GroupTreeNode[] = [];
    for (const node of groupMap.values()) {
      if (node.parentId && groupMap.has(node.parentId)) {
        groupMap.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  },

  /** Batch-update sortOrder for multiple groups at once */
  async reorder(items: { id: number; sortOrder: number }[]): Promise<void> {
    await db.transaction(async (trx) => {
      for (const item of items) {
        await trx('monitor_groups')
          .where({ id: item.id })
          .update({ sort_order: item.sortOrder, updated_at: new Date() });
      }
    });
  },

  /**
   * Find the nearest ancestor (or self) with group_notifications = true.
   * Uses the closure table, ordered by depth ASC (self = depth 0 first).
   * Returns the group if found, null otherwise.
   */
  async findGroupNotificationAncestor(groupId: number): Promise<MonitorGroup | null> {
    const row = await db<GroupRow>('monitor_groups')
      .join('group_closure', 'monitor_groups.id', 'group_closure.ancestor_id')
      .where('group_closure.descendant_id', groupId)
      .where('monitor_groups.group_notifications', true)
      .orderBy('group_closure.depth', 'asc')
      .first('monitor_groups.*');
    return row ? rowToGroup(row) : null;
  },

  /** Update the default thresholds for an agent group */
  async updateAgentThresholds(id: number, thresholds: AgentThresholds): Promise<MonitorGroup | null> {
    const [row] = await (db<GroupRow>('monitor_groups')
      .where({ id })
      .update({ agent_thresholds: JSON.stringify(thresholds), updated_at: new Date() } as Record<string, unknown>)
      .returning('*') as Promise<GroupRow[]>);
    return row ? rowToGroup(row) : null;
  },

  /** Update the agent-group config (push interval, heartbeat monitoring, max missed pushes, notification types) */
  async updateAgentGroupConfig(id: number, config: Partial<AgentGroupConfig>): Promise<MonitorGroup | null> {
    // Merge with existing config
    const existing = await db('monitor_groups').where({ id }).select('agent_group_config').first() as
      { agent_group_config: AgentGroupConfig | null } | undefined;
    const merged: AgentGroupConfig = {
      pushIntervalSeconds: null,
      heartbeatMonitoring: null,
      maxMissedPushes: null,
      notificationTypes: null,
      ...(typeof existing?.agent_group_config === 'string'
        ? JSON.parse(existing.agent_group_config)
        : (existing?.agent_group_config ?? {})),
      ...config,
    };
    const [row] = await (db<GroupRow>('monitor_groups')
      .where({ id })
      .update({ agent_group_config: JSON.stringify(merged), updated_at: new Date() } as Record<string, unknown>)
      .returning('*') as Promise<GroupRow[]>);
    return row ? rowToGroup(row) : null;
  },
};
