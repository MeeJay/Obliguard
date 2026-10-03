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

/**
 * Team permission scopes: 'group' (a group and its subtree), 'agent' (one
 * agent) and 'ungrouped' (every agent of the team's tenant without a group;
 * scopeId 0 by convention, as in Obliance).
 */
export const TEAM_PERMISSION_SCOPES = ['group', 'agent', 'ungrouped'] as const;

export const setTeamPermissionsSchema = z.object({
  permissions: z.array(
    z.object({
      scope: z.enum(TEAM_PERMISSION_SCOPES),
      // 'ungrouped' has no entity: any id is accepted and stored as 0.
      scopeId: z.number().int().nonnegative(),
      level: z.enum(['ro', 'rw']),
    }).refine((p) => p.scope === 'ungrouped' || p.scopeId > 0, {
      message: 'scopeId must be a positive id',
      path: ['scopeId'],
    }),
  ),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type SetTeamMembersInput = z.infer<typeof setTeamMembersSchema>;
export type SetTeamPermissionsInput = z.infer<typeof setTeamPermissionsSchema>;
