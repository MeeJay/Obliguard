import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Mail } from 'lucide-react';
import apiClient from '@/api/client';
import { Modal } from './Modal';
import { Button } from './Button';
import { useIsCoarsePointer } from '@/hooks/useMediaQuery';
import { cn } from '@/utils/cn';
import type { StepUpMethod } from '@/utils/twoFactorGate';

// Prompt shown when a sensitive action answers 401 TWO_FACTOR_REQUIRED
// (ported from Obliance TwoFactorPromptModal). Unlike Obliance, the proof is
// not replayed inside the business request: the prompt confirms the SESSION
// (POST /profile/2fa/step-up, valid 10 minutes) and the axios interceptor
// then replays the original request once. Wrong proofs stay in the modal
// with the server message, so the user retries without losing the action.
//
// Built on the shared Modal (portal, focus trap, Escape / Android back =
// cancel), above the other dialogs (z-[300]). On a touch screen a stray
// backdrop tap (e.g. to dismiss the keyboard) does not cancel.

/** Readable names of the server action keys (services/stepUp.service.ts). */
const ACTION_LABELS: Record<string, string> = {
  'bans.wipe': 'Wipe all bans',
  'ipReputation.wipe': 'Wipe IP reputation data',
  'bans.liftGlobal': 'Lift a global ban',
  'bans.promote': 'Promote a ban to global',
  'whitelist.global': 'Change the global whitelist',
  'tenant.delete': 'Delete a tenant',
  'agents.uninstall': 'Uninstall agents',
  'agents.delete': 'Delete agents',
  'firewall.write': 'Change firewall rules',
  'appConfig.secrets': 'Change security settings or integration keys',
  'users.role': 'Change user roles',
  'users.credentials': "Reset a user's password or two-factor authentication",
  'keys.manage': 'Manage agent enrolment keys',
  'remoteBlocklists.write': 'Change remote blocklists',
};

const METHOD_LABELS: Record<StepUpMethod, [key: string, fallback: string]> = {
  totp: ['twoFactor.stepUp.methodTotp', 'Authenticator app'],
  email: ['twoFactor.stepUp.methodEmail', 'E-mail code'],
  password: ['twoFactor.stepUp.methodPassword', 'Password'],
};

interface ApiErrorLike {
  response?: { status?: number; data?: { error?: unknown; code?: unknown; retryAfterSeconds?: unknown } };
  message?: string;
}

export function TwoFactorPromptModal({
  action,
  methods,
  ttlSeconds,
  onCancel,
  onConfirmed,
}: {
  action: string;
  methods: StepUpMethod[];
  ttlSeconds?: number;
  onCancel: () => void;
  /** The session is confirmed: the caller replays the pending request. */
  onConfirmed: () => void;
}) {
  const { t } = useTranslation();
  const coarse = useIsCoarsePointer();
  const [method, setMethod] = useState<StepUpMethod>(methods[0] ?? 'password');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setError(null);
    setCode('');
    setPassword('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [method]);

  const label = ACTION_LABELS[action]
    ? t(`twoFactor.stepUp.actions.${action.replace(/\./g, '_')}`, ACTION_LABELS[action])
    : t('twoFactor.stepUp.actions.default', 'Sensitive action');
  const minutes = Math.max(1, Math.round((ttlSeconds ?? 600) / 60));
  const isPassword = method === 'password';
  const ready = isPassword ? password.length > 0 : /^\d{6}$/.test(code) && (method !== 'email' || emailSentTo !== null);

  const serverMessage = (err: unknown): string => {
    const e = err as ApiErrorLike;
    const status = e?.response?.status;
    const data = e?.response?.data;
    if (status === 429) {
      if (data?.code === 'STEP_UP_EMAIL_COOLDOWN') {
        return t('twoFactor.stepUp.emailCooldown', 'A code was just sent. Wait a few seconds before asking for another one.');
      }
      return t('twoFactor.stepUp.tooManyAttempts', 'Too many wrong attempts. Try again in 15 minutes.');
    }
    switch (data?.code) {
      case 'STEP_UP_INVALID':
        return isPassword
          ? t('twoFactor.stepUp.wrongPassword', 'Wrong password.')
          : t('twoFactor.stepUp.invalidCode', 'Invalid code.');
      case 'STEP_UP_CODE_USED':
        return t('twoFactor.stepUp.codeUsed', 'This code was already used (for example to sign in). Wait for the next code.');
      case 'STEP_UP_EMAIL_NOT_SENT':
        return t('twoFactor.stepUp.emailNotSent', 'Send a code to your e-mail address first.');
      default:
        return typeof data?.error === 'string'
          ? data.error
          : e?.message || t('twoFactor.stepUp.failed', 'Verification failed');
    }
  };

  const sendEmailCode = async () => {
    setError(null);
    setSending(true);
    try {
      const res = await apiClient.post<{ data?: { email?: string } }>('/profile/2fa/step-up', { method: 'email' });
      setEmailSentTo(res.data?.data?.email ?? '');
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (err) {
      setError(serverMessage(err));
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    if (!ready || busy) return;
    setError(null);
    setBusy(true);
    try {
      await apiClient.post('/profile/2fa/step-up', isPassword ? { method, password } : { method, code });
      onConfirmed();
    } catch (err) {
      setError(serverMessage(err));
      setCode('');
      setPassword('');
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('twoFactor.stepUp.title', 'Confirm this action')}
      icon={<ShieldCheck className="w-4 h-4 text-accent" />}
      size="sm"
      phoneLayout="center"
      closeOnBackdrop={!coarse}
      overlayClassName="z-[300] bg-black/70"
      bodyClassName="py-4 space-y-3"
      data-testid="two-factor-prompt"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button size="sm" onClick={submit} loading={busy} disabled={!ready}>
            {t('twoFactor.stepUp.confirm', 'Confirm')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-secondary">
        <strong className="text-text-primary">{label}</strong>
        {' — '}
        {t('twoFactor.stepUp.description', {
          minutes,
          defaultValue: 'this action needs a fresh confirmation. It stays valid for {{minutes}} minutes in this session.',
        })}
      </p>

      {methods.length > 1 && (
        <div className="flex gap-1 rounded-md bg-bg-tertiary p-1" role="tablist">
          {methods.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={method === m}
              onClick={() => setMethod(m)}
              className={cn(
                'flex-1 rounded px-2 py-1 text-xs transition-colors coarse:min-h-10',
                method === m ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary',
              )}
            >
              {t(METHOD_LABELS[m][0], METHOD_LABELS[m][1])}
            </button>
          ))}
        </div>
      )}

      {method === 'email' && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-text-muted">
            {emailSentTo !== null
              ? t('twoFactor.stepUp.emailSent', { email: emailSentTo, defaultValue: 'Code sent to {{email}}.' })
              : t('twoFactor.stepUp.emailHint', 'A 6-digit code will be sent to the e-mail address of your profile.')}
          </p>
          <Button variant="secondary" size="sm" onClick={sendEmailCode} loading={sending}>
            <Mail className="w-3.5 h-3.5 mr-1.5" />
            {emailSentTo !== null
              ? t('twoFactor.stepUp.resendCode', 'Resend')
              : t('twoFactor.stepUp.sendCode', 'Send code')}
          </Button>
        </div>
      )}

      {isPassword ? (
        <input
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          enterKeyHint="go"
          aria-label={t('twoFactor.stepUp.passwordLabel', 'Current password')}
          placeholder={t('twoFactor.stepUp.passwordLabel', 'Current password')}
          value={password}
          onChange={(e) => setPassword(e.target.value.slice(0, 1024))}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
        />
      ) : (
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          maxLength={6}
          pattern="\d{6}"
          autoComplete="one-time-code"
          enterKeyHint="go"
          aria-label={method === 'totp'
            ? t('twoFactor.stepUp.codeLabel', 'Code from your authenticator app')
            : t('twoFactor.stepUp.emailCodeLabel', 'Code received by e-mail')}
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-center font-mono text-lg tracking-[0.5em] text-text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
        />
      )}

      {method === 'totp' && (
        <p className="text-[11px] text-text-muted">
          {t('twoFactor.stepUp.totpHint', 'Enter a new code: the code used to sign in is refused.')}
        </p>
      )}

      {error && <p className="text-xs text-status-down" role="alert">{error}</p>}
    </Modal>
  );
}
