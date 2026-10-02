import type { Request, Response, NextFunction } from 'express';
import { isMasterTenant } from '@obliview/shared';
import { db } from '../db';
import { notificationService } from '../services/notification.service';
import { smtpServerService } from '../services/smtpServer.service';
import { getPluginMetas } from '../notifications/registry';
import { AppError } from '../middleware/errorHandler';
import type {
  CreateChannelInput,
  UpdateChannelInput,
  AddBindingInput,
  RemoveBindingInput,
  ListBindingsQuery,
  ResolvedBindingsQuery,
} from '../validators/notification.schema';

// Tenant ownership gates for every operation on a notification channel.
// `notificationService.getChannelById` is tenant-agnostic (background jobs fan
// out across tenants), so EVERY request handler that exposes or mutates a
// channel runs one of these first. The Default tenant owns every channel.
//
//   - assertChannelVisible: owner, Default, or a tenant the channel is shared
//     to. Read, test and group/agent bindings ("targeted use").
//   - assertChannelOwnedByCaller: owner or Default only. Edit, delete,
//     sharing and global bindings (a global binding belongs to the channel's
//     owner: the bindings table carries no tenant).
//
// A channel the caller cannot see is a 404, the same shape as "does not
// exist", so foreign channel ids do not leak.

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(404, 'Channel not found');
  return id;
}

async function isSharedTo(channelId: number, tenantId: number): Promise<boolean> {
  const tenantIds = await notificationService.getChannelTenants(channelId);
  return tenantIds.includes(tenantId);
}

async function assertChannelVisible(channelId: number, req: Request): Promise<void> {
  const channel = await notificationService.getChannelById(channelId);
  if (!channel) throw new AppError(404, 'Channel not found');
  if (isMasterTenant(req.tenantId)) return;
  if (channel.tenantId === req.tenantId) return;
  if (await isSharedTo(channelId, req.tenantId)) return;
  throw new AppError(404, 'Channel not found');
}

async function assertChannelOwnedByCaller(channelId: number, req: Request): Promise<void> {
  const channel = await notificationService.getChannelById(channelId);
  if (!channel) throw new AppError(404, 'Channel not found');
  if (isMasterTenant(req.tenantId)) return;
  if (channel.tenantId === req.tenantId) return;
  // A recipient of a shared channel knows it exists (it is in its list):
  // 403. Anyone else gets the "does not exist" 404.
  if (await isSharedTo(channelId, req.tenantId)) {
    throw new AppError(403, 'Cannot modify a channel you do not own');
  }
  throw new AppError(404, 'Channel not found');
}

/**
 * A group/agent binding target must belong to the operating tenant. No
 * Default bypass: the god view covers reads, not writes on another tenant's
 * scopes (same rule as the whitelist and local templates).
 */
async function assertScopeTargetInTenant(scope: 'global' | 'group' | 'agent', scopeId: number | null, tenantId: number): Promise<void> {
  if (scope === 'global') return;
  const table = scope === 'group' ? 'monitor_groups' : 'agent_devices';
  const row = await db(table).where({ id: scopeId }).first('tenant_id') as { tenant_id: number | null } | undefined;
  if (!row || row.tenant_id !== tenantId) {
    throw new AppError(404, scope === 'group' ? 'Group not found' : 'Agent not found');
  }
}

/** An SMTP channel may only reference an SMTP server of the operating tenant. */
async function assertSmtpServerUsable(type: string, config: Record<string, unknown> | undefined, tenantId: number): Promise<void> {
  if (type !== 'smtp' || !config || config.smtpServerId === undefined || config.smtpServerId === '') return;
  const id = Number(config.smtpServerId);
  const server = Number.isInteger(id) && id > 0 ? await smtpServerService.getOwned(id, tenantId) : null;
  if (!server) throw new AppError(400, 'SMTP server not found');
}

/** Binding creation: global = channel owner; group/agent = visible channel + own target. */
async function assertBindingAllowed(data: AddBindingInput, req: Request): Promise<void> {
  if (data.scope === 'global') {
    await assertChannelOwnedByCaller(data.channelId, req);
    return;
  }
  await assertChannelVisible(data.channelId, req);
  await assertScopeTargetInTenant(data.scope, data.scopeId, req.tenantId);
}

export const notificationsController = {
  // GET /api/notifications/plugins — list available plugin types
  async plugins(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const metas = getPluginMetas();
      res.json({ success: true, data: metas });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/notifications/channels
  async listChannels(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const channels = await notificationService.getAllChannels(req.tenantId);
      res.json({ success: true, data: channels });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/notifications/channels/:id
  async getChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      await assertChannelVisible(id, req);
      // Redacted (readOnly) when the caller is a recipient, not the owner.
      const channel = await notificationService.getChannelById(id, req.tenantId);
      if (!channel) throw new AppError(404, 'Channel not found');
      res.json({ success: true, data: channel });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/notifications/channels
  async createChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateChannelInput;
      await assertSmtpServerUsable(data.type, data.config, req.tenantId);
      const channel = await notificationService.createChannel({
        ...data,
        createdBy: req.session.userId!,
      }, req.tenantId);
      res.status(201).json({ success: true, data: channel });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Unknown notification')) {
        next(new AppError(400, err.message));
      } else {
        next(err);
      }
    }
  },

  // PUT /api/notifications/channels/:id
  async updateChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      await assertChannelOwnedByCaller(id, req);
      const data = req.body as UpdateChannelInput;
      const current = await notificationService.getChannelById(id);
      if (!current) throw new AppError(404, 'Channel not found');
      await assertSmtpServerUsable(current.type, data.config, req.tenantId);
      const channel = await notificationService.updateChannel(id, data, req.tenantId);
      if (!channel) throw new AppError(404, 'Channel not found');
      res.json({ success: true, data: channel });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/notifications/channels/:id
  async deleteChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      await assertChannelOwnedByCaller(id, req);
      const deleted = await notificationService.deleteChannel(id);
      if (!deleted) throw new AppError(404, 'Channel not found');
      res.json({ success: true, message: 'Channel deleted' });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/notifications/channels/:id/test
  async testChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      await assertChannelVisible(id, req);
      await notificationService.testChannel(id);
      res.json({ success: true, message: 'Test notification sent' });
    } catch (err: unknown) {
      if (err instanceof Error && !(err instanceof AppError)) {
        next(new AppError(400, `Test failed: ${err.message}`));
      } else {
        next(err);
      }
    }
  },

  // GET /api/notifications/channels/:id/tenants — list tenant IDs the channel is shared to
  async getChannelTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      await assertChannelOwnedByCaller(id, req);
      const tenantIds = await notificationService.getChannelTenants(id);
      res.json({ success: true, data: tenantIds });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/notifications/channels/:id/tenants — replace sharing list
  async setChannelTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      await assertChannelOwnedByCaller(id, req);
      const channel = await notificationService.getChannelById(id);
      if (!channel) throw new AppError(404, 'Channel not found');
      const requested = [...new Set((req.body as { tenantIds: number[] }).tenantIds)]
        .filter((t) => t !== channel.tenantId);
      if (requested.length > 0) {
        const known = await db('tenants').whereIn('id', requested).pluck('id') as number[];
        if (known.length !== requested.length) throw new AppError(400, 'Unknown tenant id');
      }
      await notificationService.setChannelTenants(id, requested);
      res.json({ success: true, message: 'Channel tenants updated' });
    } catch (err) {
      next(err);
    }
  },

  // ── Bindings ──

  // GET /api/notifications/bindings?scope=global|group|agent&scopeId=N
  // Without scope: every binding visible to the caller tenant.
  async listBindings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { scope, scopeId } = req.query as unknown as ListBindingsQuery;
      const bindings = await notificationService.listBindingsForTenant(req.tenantId, scope, scopeId);
      res.json({ success: true, data: bindings });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/notifications/bindings
  async addBinding(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as AddBindingInput;
      await assertBindingAllowed(data, req);
      const binding = await notificationService.addBinding(
        data.channelId,
        data.scope,
        data.scopeId,
        data.overrideMode,
      );
      res.status(201).json({ success: true, data: binding });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/notifications/bindings
  async removeBinding(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as RemoveBindingInput;
      if (data.scope === 'global') {
        await assertChannelOwnedByCaller(data.channelId, req);
      } else {
        // Removing a binding from the tenant's own group/agent is always
        // allowed, even once the channel is no longer shared to it: otherwise
        // a revoked share would leave a binding the tenant cannot clean up.
        await assertScopeTargetInTenant(data.scope, data.scopeId, req.tenantId);
      }
      const removed = await notificationService.removeBinding(data.channelId, data.scope, data.scopeId);
      res.json({ success: true, message: removed ? 'Binding removed' : 'Binding not found' });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/notifications/bindings/resolved?scope=group|agent&scopeId=N
  async resolvedBindings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { scope, scopeId } = req.query as unknown as ResolvedBindingsQuery;
      // Reads: the Default tenant may inspect any tenant's scopes (god view).
      if (!isMasterTenant(req.tenantId)) await assertScopeTargetInTenant(scope, scopeId, req.tenantId);

      // Agent scope uses its own resolution method (global → agent group hierarchy → agent)
      if (scope === 'agent') {
        const resolved = await notificationService.resolveBindingsWithSourcesForAgent(scopeId);
        res.json({ success: true, data: resolved });
        return;
      }

      const resolved = await notificationService.resolveBindingsWithSources(scope, scopeId);
      res.json({ success: true, data: resolved });
    } catch (err) {
      next(err);
    }
  },
};
