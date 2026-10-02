import type { Request, Response, NextFunction } from 'express';
import { userService } from '../services/user.service';
import { teamService } from '../services/team.service';
import { userSessionsService } from '../services/userSessions.service';
import { invalidateUserState } from '../middleware/sessionUserGuard';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';
import { logger } from '../utils/logger';
import type {
  CreateUserInput,
  UpdateUserInput,
  ChangePasswordInput,
} from '../validators/user.schema';

export const usersController = {
  // GET /api/users
  async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const users = await userService.getAll();
      res.json({ success: true, data: users });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/users/:id
  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const user = await userService.getById(id);
      if (!user) throw new AppError(404, 'User not found');
      res.json({ success: true, data: user });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/users
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateUserInput;
      const user = await userService.create(data);
      res.status(201).json({ success: true, data: user });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique')) {
        next(new AppError(409, 'Username already exists'));
      } else {
        next(err);
      }
    }
  },

  // PUT /api/users/:id
  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const data = req.body as UpdateUserInput;

      // Block role/isActive changes for SSO users — manage from Obligate
      const targetUser = await userService.getById(id);
      if (targetUser?.foreignSource === 'obligate') {
        if (data.role !== undefined || data.isActive !== undefined) {
          throw new AppError(400, 'Cannot modify SSO user — manage from Obligate');
        }
      }

      // Block username change for SSO users
      if (data.username !== undefined) {
        const currentUser = targetUser ?? await userService.getById(id);
        if (currentUser?.foreignSource) {
          throw new AppError(400, 'Cannot change username of an SSO user');
        }
      }

      // Prevent demoting the last admin
      if (data.role === 'user' || data.isActive === false) {
        const currentUser = await userService.getById(id);
        if (currentUser?.role === 'admin') {
          const allUsers = await userService.getAll();
          const activeAdmins = allUsers.filter((u) => u.role === 'admin' && u.isActive && u.id !== id);
          if (activeAdmins.length === 0) {
            throw new AppError(400, 'Cannot remove the last active admin');
          }
        }
      }

      const user = await userService.update(id, data);
      if (!user) throw new AppError(404, 'User not found');
      // Sessions cache userId + role: a demoted or disabled account must not
      // keep its current sessions (or sockets) with the old privileges.
      if (targetUser && (targetUser.role !== user.role || (targetUser.isActive && !user.isActive))) {
        await userSessionsService.destroyForUser(id);
      } else {
        invalidateUserState(id); // e.g. re-enabled: don't keep serving a cached "disabled"
      }
      res.json({ success: true, data: user });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique')) {
        next(new AppError(409, 'Username already exists'));
      } else {
        next(err);
      }
    }
  },

  // PUT /api/users/:id/password
  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(404, 'User not found');

      // One's own password is changed from the profile, with the current
      // password: a hijacked admin session must not rotate it without it.
      if (id === req.session.userId) {
        throw new AppError(400, 'Use your profile to change your own password');
      }

      // Block password change for SSO users
      const currentUser = await userService.getById(id);
      if (currentUser?.foreignSource) {
        throw new AppError(400, 'Cannot change password of an SSO user');
      }

      const data = req.body as ChangePasswordInput;
      const success = await userService.changePassword(id, data.password);
      if (!success) throw new AppError(404, 'User not found');
      // A reset password signs the account out everywhere.
      await userSessionsService.destroyForUser(id);
      logger.info({ targetUserId: id, byUserId: req.session.userId }, 'Admin reset a user password');
      res.json({ success: true, message: 'Password changed' });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/users/:id/2fa — admin resets every second factor of a
  // locked-out user (lost authenticator) — mirrors Obliance resetMfa.
  async resetMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(404, 'User not found');
      // One's own 2FA is managed from the profile (with a current code): this
      // route must not be a way around it.
      if (id === req.session.userId) {
        throw new AppError(400, 'Use your profile to manage your own two-factor authentication');
      }

      const updated = await db('users').where({ id }).update({
        totp_enabled: false,
        totp_secret: null,
        email_otp_enabled: false,
        updated_at: new Date(),
      });
      if (!updated) throw new AppError(404, 'User not found');

      // Sessions (and pending 2FA logins) die with the factors.
      await userSessionsService.destroyForUser(id);
      logger.warn({ targetUserId: id, byUserId: req.session.userId }, 'Admin reset the two-factor authentication of a user');
      res.json({ success: true, message: 'Two-factor authentication reset' });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/users/:id
  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);

      if (id === req.session.userId) {
        throw new AppError(400, 'Cannot delete your own account');
      }

      const user = await userService.getById(id);

      // Block deletion of active SSO users — manage from Obligate. A disabled
      // one (e.g. deleted in Obligate: sso-user-sync disables it) may be removed.
      if (user?.foreignSource === 'obligate' && user.isActive) {
        throw new AppError(400, 'Cannot delete an active SSO user — manage from Obligate');
      }

      if (user?.role === 'admin') {
        const allUsers = await userService.getAll();
        const activeAdmins = allUsers.filter((u) => u.role === 'admin' && u.isActive && u.id !== id);
        if (activeAdmins.length === 0) {
          throw new AppError(400, 'Cannot delete the last admin');
        }
      }

      const deleted = await userService.delete(id);
      if (!deleted) throw new AppError(404, 'User not found');
      await userSessionsService.destroyForUser(id);
      res.json({ success: true, message: 'User deleted' });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/users/:id/teams
  async getTeams(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const teams = await teamService.getUserTeams(id);
      res.json({ success: true, data: teams });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/users/:id/tenants
  async getTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const assignments = await userService.getUserTenantAssignments(id);
      res.json({ success: true, data: assignments });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/users/:id/tenants
  // Body: { assignments: [{ tenantId: number, role: 'admin' | 'member' }] }
  async setTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const targetUser = Number.isSafeInteger(id) && id > 0 ? await userService.getById(id) : null;
      if (!targetUser) throw new AppError(404, 'User not found');
      if (targetUser.foreignSource === 'obligate') {
        throw new AppError(400, 'Cannot modify SSO user tenant access — manage from Obligate');
      }
      const { assignments } = (req.body ?? {}) as {
        assignments: { tenantId: number; role: 'admin' | 'member' }[];
      };
      if (
        !Array.isArray(assignments) ||
        !assignments.every((a) =>
          a && typeof a.tenantId === 'number' && Number.isSafeInteger(a.tenantId) && a.tenantId > 0 &&
          (a.role === 'admin' || a.role === 'member'))
      ) {
        throw new AppError(400, 'assignments must be an array of { tenantId, role }');
      }
      const ids = assignments.map((a) => a.tenantId);
      if (new Set(ids).size !== ids.length) throw new AppError(400, 'Duplicate tenantId in assignments');
      if (ids.length && (await db('tenants').whereIn('id', ids).pluck('id')).length !== ids.length) {
        throw new AppError(404, 'Tenant not found');
      }
      await userService.setUserTenantAssignments(id, assignments);
      // Dropped memberships answer 403 at once; live sockets rejoin their rooms.
      userSessionsService.onMembershipChanged(id);
      res.json({ success: true, message: 'Tenant assignments updated' });
    } catch (err) {
      next(err);
    }
  },
};
