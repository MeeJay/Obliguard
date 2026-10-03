// Module-level event bridge between the axios response interceptor (which
// lives outside the React tree) and the <TwoFactorGate> component (which
// owns the modal UI). Ported from Obliance client/src/utils/twoFactorGate.ts.
//
// A single listener is registered when the app shell mounts. When the server
// answers 401 { code: 'TWO_FACTOR_REQUIRED' } to a sensitive action, axios
// calls `awaitStepUp`; the gate pops the prompt, the prompt confirms the
// session itself (POST /profile/2fa/step-up) and resolves the promise, then
// axios replays the original request once. Closing the prompt rejects with
// TWO_FACTOR_CANCELLED.

/** Proofs the account can give (401 `methods`). */
export type StepUpMethod = 'totp' | 'email' | 'password';

export interface StepUpRequest {
  /** Server action key (e.g. 'bans.wipe'), shown with a readable label. */
  action: string;
  methods: StepUpMethod[];
  /** Validity of the confirmation, seconds (401 `ttlSeconds`). */
  ttlSeconds?: number;
}

interface Pending extends StepUpRequest {
  resolve: () => void;
  reject: (err: Error) => void;
}

type Listener = (pending: Pending) => void;

let listener: Listener | null = null;

/** Rejection message when the user closes the prompt — callers can tell a
 *  cancellation from a failure with isTwoFactorCancelled(). */
export const TWO_FACTOR_CANCELLED = 'Two-factor verification cancelled';

export function isTwoFactorCancelled(err: unknown): boolean {
  return (err as { message?: unknown } | null)?.message === TWO_FACTOR_CANCELLED;
}

export function setTwoFactorListener(fn: Listener | null): void {
  listener = fn;
}

/**
 * Opens the step-up prompt; resolves once the session is confirmed (the
 * prompt called POST /profile/2fa/step-up successfully), rejects with
 * TWO_FACTOR_CANCELLED when the user closes it.
 */
export function awaitStepUp(request: StepUpRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!listener) {
      reject(new Error('Two-factor gate is not mounted. Did you forget <TwoFactorGate /> in the app shell?'));
      return;
    }
    listener({ ...request, resolve, reject });
  });
}
