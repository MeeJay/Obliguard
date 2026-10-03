import type { Request, Response, NextFunction } from 'express';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { userService } from '../services/user.service';
import { teamService } from '../services/team.service';
import { userSessionsService } from '../services/userSessions.service';
import { userScope, actorFromReq } from '../services/userScope.service';
import { createUserAccount, updateUserAccount, deleteUserAccount, setUserTenants } from '../services/userAdmin.service';
import { auditService } from '../services/audit.service';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';
import { logger } from '../utils/logger';
import type {
  CreateUserInput,
  UpdateUserInput,
  ChangePasswordInput,
} from '../validators/user.schema';

// ── Scope of `users.manage` ────────────────────────────────────────────────
// The routes are gated by the tenant capability users.manage (users.routes).
// The rules live in services/userScope.service.ts (Obliance port): a holder
// that is not a platform admin may only act on an account it fully
// dominates — never a platform admin nor an SSO (og_) account, a member of
// the operating tenant, and in EVERY tenant of the account: tenant admin
// only if the caller is tenant admin there, otherwise users.manage + every
// capability of the account's permission set there. It may never change a
// platform role, and may only change the operating tenant's membership row.
// Password and 2FA resets of one's own account go through the profile
// (current password / current code), never through here.

function parseUserId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(404, 'User not found');
  return id;
}

export const usersController = {
  // GET /api/users
  //
  // The Default tenant is the "god view": every account of the install.
  // Any other tenant is a customer workspace: only the accounts that are
  // members of it (who can see this tenant?), platform admin included.
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = actorFromReq(req);
      const users = await userService.getAll();
      if (actor.tenantId === MASTER_TENANT_ID) {
        res.json({ success: true, data: users });
        return;
      }
      const memberIds = new Set<number>(
        (await db('user_tenants').where({ tenant_id: actor.tenantId }).pluck('user_id')).map(Number),
      );
      res.json({ success: true, data: users.filter((u) => memberIds.has(u.id)) });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/users/:id
  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseUserId(req);
      await userScope.assertReadableTarget(actorFromReq(req), id);
      const user = await userService.getById(id);
      if (!user) throw new AppError(404, 'User not found');
      res.json({ success: true, data: user });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/users  { username, password, displayName?, role?, tenantRole? }
  // A manager that is not a platform admin creates the account as a member
  // of the operating tenant (tenantRole, default 'user').
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateUserInput & { tenantRole?: string };
      const user = await createUserAccount(actorFromReq(req), data);
      await auditService.logReq(req, {
        action: 'user.created', targetType: 'user', targetId: user.id,
        details: { username: user.username, role: user.role, tenantRole: data.tenantRole ?? null },
      });
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
      const id = parseUserId(req);
      const body = (req.body ?? {}) as UpdateUserInput & Record<string, unknown>;
      const user = await updateUserAccount(actorFromReq(req), id, body);
      await auditService.logReq(req, {
        action: 'user.updated', targetType: 'user', targetId: id,
        details: {
          username: user.username,
          fields: Object.keys(body),
          ...('role' in body ? { role: body.role } : {}),
          ...('isActive' in body ? { isActive: body.isActive } : {}),
        },
      });
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
      const id = parseUserId(req);

      // One's own password is changed from the profile, with the current
      // password: a hijacked admin session must not rotate it without it.
      if (id === req.session.userId) {
        throw new AppError(400, 'Use your profile to change your own password');
      }

      const target = await userScope.assertManageableTarget(actorFromReq(req), id);
      // Block password change for SSO users
      if (target.foreign_source) {
        throw new AppError(400, 'Cannot change password of an SSO user');
      }

      const data = req.body as ChangePasswordInput;
      const success = await userService.changePassword(id, data.password);
      if (!success) throw new AppError(404, 'User not found');
      // A reset password signs the account out everywhere.
      await userSessionsService.destroyForUser(id);
      logger.info({ targetUserId: id, byUserId: req.session.userId }, 'Admin reset a user password');
      await auditService.logReq(req, { action: 'user.password_reset', targetType: 'user', targetId: id, details: { username: target.username } });
      res.json({ success: true, message: 'Password changed' });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/users/:id/2fa — a manager resets every second factor of a
  // locked-out user (lost authenticator) — mirrors Obliance resetMfa.
  async resetMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseUserId(req);
      // One's own 2FA is managed from the profile (with a current code): this
      // route must not be a way around it.
      if (id === req.session.userId) {
        throw new AppError(400, 'Use your profile to manage your own two-factor authentication');
      }
      const target = await userScope.assertManageableTarget(actorFromReq(req), id);

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
      await auditService.logReq(req, { action: 'user.2fa_reset', targetType: 'user', targetId: id, details: { username: target.username } });
      res.json({ success: true, message: 'Two-factor authentication reset' });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/users/:id
  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseUserId(req);
      const before = await db('users').where({ id }).first('username') as { username: string } | undefined;
      await deleteUserAccount(actorFromReq(req), id);
      await auditService.logReq(req, { action: 'user.deleted', targetType: 'user', targetId: id, details: { username: before?.username ?? null } });
      res.json({ success: true, message: 'User deleted' });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/users/:id/teams
  async getTeams(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseUserId(req);
      const actor = actorFromReq(req);
      await userScope.assertReadableTarget(actor, id);
      let teams = await teamService.getUserTeams(id);
      // Outside the god view, only the operating tenant's teams are shown.
      if (actor.tenantId !== MASTER_TENANT_ID) {
        teams = teams.filter((tm) => Number(tm.tenantId) === actor.tenantId);
      }
      res.json({ success: true, data: teams });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/users/:id/tenants
  async getTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseUserId(req);
      const actor = actorFromReq(req);
      await userScope.assertReadableTarget(actor, id);
      let assignments = await userService.getUserTenantAssignments(id);
      // A manager that is not a platform admin sees (and may change) only the
      // operating tenant's row: other tenants are neither listed nor named.
      // PUT /:id/tenants keeps the rows it does not send.
      if (!actor.isPlatformAdmin) {
        assignments = assignments.filter((a) => Number(a.tenantId) === actor.tenantId);
      }
      res.json({ success: true, data: assignments });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/users/:id/tenants
  // Body: { assignments: [{ tenantId: number, role: string }] }
  // role: 'admin' or a permission-set slug ('member' = legacy alias of 'user').
  async setTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseUserId(req);
      const actor = actorFromReq(req);
      if (actor.isPlatformAdmin) {
        const targetUser = await userService.getById(id);
        if (!targetUser) throw new AppError(404, 'User not found');
        if (targetUser.foreignSource === 'obligate') {
          throw new AppError(400, 'Cannot modify SSO user tenant access — manage from Obligate');
        }
      }
      // Other managers: scope, SSO and role rules in userScope (only the
      // operating tenant's row changes, the other rows are kept).
      const assignments = (req.body as { assignments?: unknown } | undefined)?.assignments;
      await setUserTenants(actor, id, assignments);
      await auditService.logReq(req, {
        action: 'user.tenants_changed', targetType: 'user', targetId: id,
        details: { assignments: Array.isArray(assignments) ? assignments : null },
      });
      res.json({ success: true, message: 'Tenant assignments updated' });
    } catch (err) {
      next(err);
    }
  },
};
