import { z } from 'zod';

// Theme ids a user can pick (mirror of AppTheme in shared/src/types.ts: the
// server resolves @obliview/shared from its compiled dist, so the list lives
// here too). Also used by the enrollment wizard (enrollment.controller.ts).
export const APP_THEME_IDS = ['obli-operator', 'obli-daylight', 'obli-dim', 'modern', 'neon'] as const;

// NetMap tabs (client/src/netmap/tabStore.ts NetMapTab), persisted in the
// preferences so they follow the user across browsers. Bounded: a preference
// row must not become a storage bucket.
export const MAX_NETMAP_TABS = 20;
export const MAX_NETMAP_TAB_AGENTS = 1000;

const netmapTabSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(100),
  agentIds: z.array(z.number().int().positive()).max(MAX_NETMAP_TAB_AGENTS),
  sortOrder: z.number().int().min(0).max(10_000),
});

// Every key is optional: a write sends only what it changes and the server
// MERGES it into the stored preferences (profile.controller mergePreferences).
// Unknown keys are stripped.
const userPreferencesSchema = z.object({
  toastEnabled: z.boolean().optional(),
  toastPosition: z.enum(['top-center', 'bottom-right']).optional(),
  multiTenantNotificationsEnabled: z.boolean().optional(),
  // The ThemePicker of ProfilePage sends it: without this field zod stripped
  // it and the chosen theme was never stored server-side.
  preferredTheme: z.enum(APP_THEME_IDS).optional(),
  anonymousMode: z.boolean().optional(),
  netmapTabs: z.array(netmapTabSchema).max(MAX_NETMAP_TABS).optional(),
}).nullable().optional();

export const updateProfileSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  preferences: userPreferencesSchema,
  email: z.string().email().max(255).nullable().optional(),
  preferredLanguage: z.string().max(10).optional(),
  // Required (local accounts) when `email` changes the stored address: the
  // address receives password-reset links and e-mail OTP codes.
  currentPassword: z.string().min(1).max(256).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(128),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
