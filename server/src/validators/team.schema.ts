import { z } from 'zod';

export const createTeamSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).nullable().optional(),
  canCreate: z.boolean().optional(),
});

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  canCreate: z.boolean().optional(),
});

export const setTeamMembersSchema = z.object({
  userIds: z.array(z.number().int().positive()),
});

/** Team permission scopes (matches PermissionScope in @obliview/shared). */
export const TEAM_PERMISSION_SCOPES = ['group', 'agent'] as const;

export const setTeamPermissionsSchema = z.object({
  permissions: z.array(
    z.object({
      scope: z.enum(TEAM_PERMISSION_SCOPES),
      scopeId: z.number().int().positive(),
      level: z.enum(['ro', 'rw']),
    }),
  ),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type SetTeamMembersInput = z.infer<typeof setTeamMembersSchema>;
export type SetTeamPermissionsInput = z.infer<typeof setTeamPermissionsSchema>;
