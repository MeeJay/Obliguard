import type { Request, Response, NextFunction } from 'express';
import { settingsService } from '../services/settings.service';
import type { SettingsScope } from '@obliview/shared';
import type { SettingsKey } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import type { SetSettingInput, SetSettingsBulkInput, DeleteSettingInput } from '../validators/settings.schema';

function parseScope(req: Request): { scope: SettingsScope; scopeId: number | null } {
  const { scope, scopeId } = req.params;

  if (scope === 'global') return { scope: 'global', scopeId: null };
  if (scope === 'group') {
    const id = parseInt(scopeId, 10);
    if (isNaN(id)) throw new AppError(400, 'Invalid scope ID');
    return { scope, scopeId: id };
  }
  throw new AppError(400, 'Invalid scope. Must be global or group');
}

export const settingsController = {
  // GET /api/settings/global/resolved
  async getGlobalResolved(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await settingsService.resolveGlobal();
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/settings/group/:scopeId/resolved
  async getGroupResolved(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.scopeId, 10);
      if (isNaN(groupId)) throw new AppError(400, 'Invalid group ID');
      const result = await settingsService.resolveForGroup(groupId);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/settings/monitor/:scopeId/resolved — stub (no monitors in Obliguard)
  async getMonitorResolved(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(404).json({ success: false, error: 'Monitors not supported in Obliguard' });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/settings/:scope/:scopeId
  async set(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { scope, scopeId } = parseScope(req);
      const { key, value } = req.body as SetSettingInput;

      await settingsService.set(scope, scopeId, key as SettingsKey, value);

      // Broadcast settings update
      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('settings:updated', { scope, scopeId, key, value });
      }

      res.json({ success: true, message: 'Setting saved' });
    } catch (err: unknown) {
      if (err instanceof Error && (err.message.includes('must be between') || err.message.includes('Unknown setting'))) {
        next(new AppError(400, err.message));
      } else {
        next(err);
      }
    }
  },

  // PUT /api/settings/:scope/:scopeId/bulk
  async setBulk(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { scope, scopeId } = parseScope(req);
      const { overrides } = req.body as SetSettingsBulkInput;

      await settingsService.setBulk(
        scope,
        scopeId,
        overrides.map((o) => ({ key: o.key as SettingsKey, value: o.value })),
      );

      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').emit('settings:updated', { scope, scopeId, overrides });
      }

      res.json({ success: true, message: 'Settings saved' });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/settings/:scope/:scopeId/:key  (reset to inherited)
  async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { scope, scopeId } = parseScope(req);
      const { key } = req.params;

      const deleted = await settingsService.remove(scope, scopeId, key as SettingsKey);

      if (deleted) {
        const io = req.app.get('io');
        if (io) {
          io.to('role:admin').emit('settings:updated', { scope, scopeId, key, removed: true });
        }
      }

      res.json({ success: true, message: deleted ? 'Setting reset to inherited' : 'No override found' });
    } catch (err) {
      next(err);
    }
  },
};
