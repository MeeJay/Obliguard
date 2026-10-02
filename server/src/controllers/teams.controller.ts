import type { Request, Response, NextFunction } from 'express';
import { teamService } from '../services/team.service';
import { AppError } from '../middleware/errorHandler';
import { deviceAccessVerdict } from '../utils/tenantWriteRules';
import type {
  CreateTeamInput,
  UpdateTeamInput,
  SetTeamMembersInput,
  SetTeamPermissionsInput,
} from '../validators/team.schema';
import type { UserTeam } from '@obliview/shared';

/**
 * Load a team bound to the operating tenant (owner model, A5): reads may cross
 * tenants from the Default tenant (god view); writes follow the operating
 * tenant, platform role included: 403 from Default, 404 elsewhere.
 */
async function loadTeam(req: Request, mode: 'read' | 'write'): Promise<UserTeam> {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) throw new AppError(400, 'Invalid team ID');
  const team = await teamService.getById(id);
  if (!team) throw new AppError(404, 'Team not found');
  const verdict = deviceAccessVerdict(team.tenantId, req.tenantId, mode);
  if (verdict === 'forbidden') throw new AppError(403, 'This team belongs to another tenant: read-only from the Default tenant');
  if (verdict !== 'ok') throw new AppError(404, 'Team not found');
  return team;
}

export const teamsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Scoped to the operating tenant; the Default tenant reads every tenant
      // (god view), so the legacy ?scope=all adds nothing and widens nothing.
      const teams = await teamService.getAll(req.tenantId);
      res.json({ success: true, data: teams });
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadTeam(req, 'read');

      const [members, permissions] = await Promise.all([
        teamService.getMembers(team.id),
        teamService.getPermissions(team.id),
      ]);

      res.json({ success: true, data: { ...team, memberIds: members, permissions } });
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateTeamInput;
      // Teams are created in the operating tenant: the platform role grants no
      // cross-tenant write (switch tenant first). A body tenantId is stripped
      // by the validator.
      const team = await teamService.create(data, req.tenantId);
      res.status(201).json({ success: true, data: team });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique')) {
        next(new AppError(409, 'Team name already exists'));
      } else {
        next(err);
      }
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const existing = await loadTeam(req, 'write');
      const data = req.body as UpdateTeamInput;
      const team = await teamService.update(existing.id, data);
      if (!team) throw new AppError(404, 'Team not found');
      res.json({ success: true, data: team });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique')) {
        next(new AppError(409, 'Team name already exists'));
      } else {
        next(err);
      }
    }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadTeam(req, 'write');
      const deleted = await teamService.delete(team.id);
      if (!deleted) throw new AppError(404, 'Team not found');
      res.json({ success: true, message: 'Team deleted' });
    } catch (err) {
      next(err);
    }
  },

  // ── Members ──

  async getMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadTeam(req, 'read');
      const members = await teamService.getMembers(team.id);
      res.json({ success: true, data: members });
    } catch (err) {
      next(err);
    }
  },

  async setMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadTeam(req, 'write');
      const { userIds } = req.body as SetTeamMembersInput;
      await teamService.setMembers(team.id, userIds);
      res.json({ success: true, data: userIds });
    } catch (err) {
      next(err);
    }
  },

  // ── Permissions ──

  async getPermissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadTeam(req, 'read');
      const permissions = await teamService.getPermissions(team.id);
      res.json({ success: true, data: permissions });
    } catch (err) {
      next(err);
    }
  },

  async setPermissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadTeam(req, 'write');
      const { permissions } = req.body as SetTeamPermissionsInput;
      const result = await teamService.setPermissions(team.id, permissions);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  async removePermission(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadTeam(req, 'write');
      const permId = parseInt(req.params.permId, 10);
      if (isNaN(permId)) throw new AppError(400, 'Invalid permission ID');
      const deleted = await teamService.removePermission(team.id, permId);
      if (!deleted) throw new AppError(404, 'Permission not found');
      res.json({ success: true, message: 'Permission removed' });
    } catch (err) {
      next(err);
    }
  },
};
