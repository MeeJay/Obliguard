import type { AxiosError } from 'axios';
import { isTwoFactorCancelled } from './twoFactorGate';

// Helpers for callers of sensitive actions (ported from Obliance
// client/src/utils/withTwoFactor.ts). The axios interceptor (api/client.ts)
// already handles the step-up prompt and the replay, so callers only need to
// tell the outcomes apart in their catch:
//
//   try { await bansApi.wipe(); }
//   catch (err) {
//     if (isStepUpCancelled(err)) return;      // the user closed the prompt
//     toast.error(...);
//   }

/** Error code of the 401 a sensitive action answers without a fresh step-up. */
export const TWO_FACTOR_REQUIRED = 'TWO_FACTOR_REQUIRED';

/** True for a 401 asking for a step-up (Obliguard `code`, or the Obliance `twoFactorRequired` flag). */
export function is2FARequired(err: unknown): boolean {
  const e = err as AxiosError<{ code?: string; twoFactorRequired?: boolean }>;
  return e?.response?.status === 401
    && (e.response.data?.code === TWO_FACTOR_REQUIRED || !!e.response.data?.twoFactorRequired);
}

/** True when the user closed the step-up prompt (no error toast needed). */
export function isStepUpCancelled(err: unknown): boolean {
  return isTwoFactorCancelled(err);
}
