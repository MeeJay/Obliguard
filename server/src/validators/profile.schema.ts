import { z } from 'zod';

// Theme ids a user can pick (mirror of AppTheme in shared/src/types.ts: the
// server resolves @obliview/shared from its compiled dist, so the list lives
// here too). Also used by the enrollment wizard (enrollment.controller.ts).
export const APP_THEME_IDS = ['obli-operator', 'obli-daylight', 'obli-dim', 'modern', 'neon'] as const;

const userPreferencesSchema = z.object({
  toastEnabled: z.boolean(),
  toastPosition: z.enum(['top-center', 'bottom-right']),
  // The ThemePicker of ProfilePage sends it: without this field zod stripped
  // it and the chosen theme was never stored server-side.
  preferredTheme: z.enum(APP_THEME_IDS).optional(),
}).nullable().optional();

export const updateProfileSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  preferences: userPreferencesSchema,
  email: z.string().email().max(255).nullable().optional(),
  preferredLanguage: z.string().max(10).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(128),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
