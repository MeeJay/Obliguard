import { z } from 'zod';

const BINDING_SCOPES = ['global', 'group', 'agent'] as const;

export const createChannelSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(50),
  config: z.record(z.unknown()),
  isEnabled: z.boolean().optional(),
});

export const updateChannelSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.record(z.unknown()).optional(),
  isEnabled: z.boolean().optional(),
});

export const channelTenantsSchema = z.object({
  tenantIds: z.array(z.number().int().positive()).max(1000),
});

export const addBindingSchema = z.object({
  channelId: z.number().int().positive(),
  scope: z.enum(BINDING_SCOPES),
  scopeId: z.number().int().positive().nullable(),
  overrideMode: z.enum(['merge', 'replace', 'exclude']).optional(),
}).refine((b) => (b.scope === 'global') === (b.scopeId === null), {
  message: 'scopeId must be null for the global scope and set otherwise',
  path: ['scopeId'],
});

export const removeBindingSchema = z.object({
  channelId: z.number().int().positive(),
  scope: z.enum(BINDING_SCOPES),
  scopeId: z.number().int().positive().nullable(),
}).refine((b) => (b.scope === 'global') === (b.scopeId === null), {
  message: 'scopeId must be null for the global scope and set otherwise',
  path: ['scopeId'],
});

// Query strings: "" and "null" (legacy client) mean "no scope id".
const optionalScopeId = z.preprocess(
  (v) => (v === undefined || v === '' || v === 'null' ? undefined : v),
  z.coerce.number().int().positive().optional(),
);

/** GET /notifications/bindings — without scope: every binding visible to the tenant. */
export const listBindingsQuerySchema = z.object({
  scope: z.enum(BINDING_SCOPES).optional(),
  scopeId: optionalScopeId,
});

/** GET /notifications/bindings/resolved */
export const resolvedBindingsQuerySchema = z.object({
  scope: z.enum(['group', 'agent']),
  scopeId: z.coerce.number().int().positive(),
});

export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;
export type AddBindingInput = z.infer<typeof addBindingSchema>;
export type RemoveBindingInput = z.infer<typeof removeBindingSchema>;
export type ListBindingsQuery = z.infer<typeof listBindingsQuerySchema>;
export type ResolvedBindingsQuery = z.infer<typeof resolvedBindingsQuerySchema>;
