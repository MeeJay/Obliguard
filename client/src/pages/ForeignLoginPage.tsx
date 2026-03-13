/**
 * ForeignLoginPage
 *
 * Entry point for cross-platform SSO.  Obliview (or any other connected platform)
 * redirects here with:
 *
 *   /auth/foreign?token=<one-time-token>&from=<base-url>&source=<source-name>[&redirect=<path>]
 *
 * Flow:
 *   1. Call POST /api/sso/exchange → get { user, isFirstLogin } OR { needsLinking, linkToken, conflictingUsername }
 *   2a. needsLinking=true → show "link-required" stage (enter local Obliguard password to link)
 *   2b. isFirstLogin=true → redirect /sso-enroll
 *   2c. normal → redirect to `redirect` param
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, Loader2, AlertCircle, Eye, EyeOff, Shield } from 'lucide-react';
import apiClient from '@/api/client';
import { useAuthStore } from '@/store/authStore';
import type { ApiResponse, User } from '@obliview/shared';

type Status = 'loading' | 'link-required' | 'link-2fa' | 'error';

export function ForeignLoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { checkSession } = useAuthStore();

  const [status, setStatus]               = useState<Status>('loading');
  const [errorMsg, setErrorMsg]           = useState('');
  const [linkToken, setLinkToken]         = useState('');
  const [linkUsername, setLinkUsername]   = useState('');
  const [linkPassword, setLinkPassword]   = useState('');
  const [showPw, setShowPw]               = useState(false);
  const [linkError, setLinkError]         = useState('');
  const [linking, setLinking]             = useState(false);
  // 2FA link state
  const [mfaMethods, setMfaMethods]       = useState<{ totp: boolean; email: boolean }>({ totp: false, email: false });
  const [mfaMethod, setMfaMethod]         = useState<'totp' | 'email'>('totp');
  const [mfaCode, setMfaCode]             = useState('');
  const [mfaError, setMfaError]           = useState('');
  const [mfaVerifying, setMfaVerifying]   = useState(false);
  const [mfaResending, setMfaResending]   = useState(false);

  const calledRef   = useRef(false);
  const redirectRef = useRef('/');

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;
    const token    = searchParams.get('token');
    const from     = searchParams.get('from');
    const source   = searchParams.get('source') ?? 'obliview';
    const redirect = searchParams.get('redirect') ?? '/';
    redirectRef.current = redirect;

    if (!token || !from) {
      setErrorMsg('Lien SSO invalide — paramètres manquants (token, from).');
      setStatus('error');
      return;
    }

    void (async () => {
      try {
        const res = await apiClient.post<ApiResponse<
          | { user: User; isFirstLogin: boolean }
          | { needsLinking: true; linkToken: string; conflictingUsername: string }
        >>('/sso/exchange', { token, from, foreignSource: source });

        const data = res.data.data!;

        if ('needsLinking' in data) {
          setLinkToken(data.linkToken);
          setLinkUsername(data.conflictingUsername);
          setStatus('link-required');
          return;
        }

        // Session established — sync store then navigate
        await checkSession();
        if (data.isFirstLogin) {
          navigate('/sso-enroll', { replace: true });
        } else {
          navigate(redirect, { replace: true });
        }
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        const msg = axiosErr?.response?.data?.error ?? 'Échec de la connexion SSO.';
        setErrorMsg(msg);
        setStatus('error');
      }
    })();
  }, [searchParams, navigate, checkSession]);

  async function handleLink() {
    setLinkError('');
    if (!linkPassword) { setLinkError('Le mot de passe est requis.'); return; }
    setLinking(true);
    try {
      const res = await apiClient.post<ApiResponse<
        | { user: User; isFirstLogin: boolean }
        | { requires2fa: true; methods: { totp: boolean; email: boolean } }
      >>('/sso/complete-link', { linkToken, password: linkPassword });
      const data = res.data.data!;
      if ('requires2fa' in data) {
        const methods = data.methods;
        setMfaMethods(methods);
        setMfaMethod(methods.totp ? 'totp' : 'email');
        setStatus('link-2fa');
        return;
      }
      await checkSession();
      navigate(redirectRef.current, { replace: true });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setLinkError(axiosErr?.response?.data?.error ?? 'Mot de passe incorrect ou lien expiré.');
    } finally {
      setLinking(false);
    }
  }

  async function handleVerifyMfa() {
    setMfaError('');
    if (!mfaCode) { setMfaError('Le code est requis.'); return; }
    setMfaVerifying(true);
    try {
      await apiClient.post('/sso/verify-link-2fa', { code: mfaCode, method: mfaMethod });
      await checkSession();
      navigate(redirectRef.current, { replace: true });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setMfaError(axiosErr?.response?.data?.error ?? 'Code invalide.');
    } finally {
      setMfaVerifying(false);
    }
  }

  async function handleResendMfa() {
    setMfaResending(true);
    try {
      await apiClient.post('/sso/verify-link-2fa', { resend: true });
    } catch {
      // silent
    } finally {
      setMfaResending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm text-center space-y-6">
        <div className="flex items-center justify-center gap-2 text-accent">
          <ArrowLeftRight size={28} />
          <span className="text-xl font-semibold text-text-primary">Connexion SSO</span>
        </div>

        {status === 'loading' && (
          <div className="space-y-3">
            <Loader2 size={36} className="animate-spin text-primary mx-auto" />
            <p className="text-sm text-text-secondary">Validation du jeton SSO…</p>
          </div>
        )}

        {status === 'link-required' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4 text-left">
            <div className="space-y-1">
              <p className="font-medium text-sm text-text-primary">Relier les comptes</p>
              <p className="text-xs text-text-secondary">
                Un compte <span className="font-medium text-text-primary">{linkUsername}</span> existe
                déjà sur Obliguard. Entrez votre mot de passe local pour relier votre compte Obliview à
                ce compte.
              </p>
            </div>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                value={linkPassword}
                onChange={(e) => setLinkPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleLink(); }}
                placeholder={`Mot de passe Obliguard pour "${linkUsername}"`}
                autoFocus
                className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary pr-9"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              >
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            {linkError && <p className="text-xs text-status-down">{linkError}</p>}
            <button
              onClick={() => void handleLink()}
              disabled={linking || !linkPassword}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {linking ? 'Liaison en cours…' : 'Relier les comptes'}
            </button>
            <a href="/login" className="block text-center text-xs text-text-muted hover:text-text-primary">
              ← Annuler
            </a>
          </div>
        )}

        {status === 'link-2fa' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4 text-left">
            <div className="flex items-center gap-2 mb-1">
              <Shield size={16} className="text-accent shrink-0" />
              <p className="font-medium text-sm text-text-primary">Vérification en deux étapes</p>
            </div>
            <p className="text-xs text-text-secondary">
              Le compte <span className="font-medium text-text-primary">{linkUsername}</span> a la
              double authentification activée. Entrez le code pour finaliser la liaison.
            </p>

            {/* Method tabs — only show if both are available */}
            {mfaMethods.totp && mfaMethods.email && (
              <div className="flex rounded-md border border-border overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => { setMfaMethod('totp'); setMfaCode(''); setMfaError(''); }}
                  className={`flex-1 py-1.5 transition-colors ${mfaMethod === 'totp' ? 'bg-accent/15 text-accent font-medium' : 'text-text-muted hover:text-text-primary'}`}
                >
                  Application TOTP
                </button>
                <button
                  type="button"
                  onClick={() => { setMfaMethod('email'); setMfaCode(''); setMfaError(''); }}
                  className={`flex-1 py-1.5 border-l border-border transition-colors ${mfaMethod === 'email' ? 'bg-accent/15 text-accent font-medium' : 'text-text-muted hover:text-text-primary'}`}
                >
                  E-mail
                </button>
              </div>
            )}

            <input
              type="text"
              inputMode="numeric"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleVerifyMfa(); }}
              placeholder={mfaMethod === 'totp' ? 'Code à 6 chiffres (TOTP)' : 'Code reçu par e-mail'}
              autoFocus
              className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder-text-muted tracking-widest focus:outline-none focus:ring-1 focus:ring-primary text-center"
            />

            {mfaMethod === 'email' && (
              <button
                type="button"
                onClick={() => void handleResendMfa()}
                disabled={mfaResending}
                className="text-xs text-accent hover:text-accent/80 disabled:opacity-50"
              >
                {mfaResending ? 'Envoi…' : 'Renvoyer le code'}
              </button>
            )}

            {mfaError && <p className="text-xs text-status-down">{mfaError}</p>}

            <button
              onClick={() => void handleVerifyMfa()}
              disabled={mfaVerifying || mfaCode.length !== 6}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {mfaVerifying ? 'Vérification…' : 'Confirmer'}
            </button>
            <a href="/login" className="block text-center text-xs text-text-muted hover:text-text-primary">
              ← Annuler
            </a>
          </div>
        )}

        {status === 'error' && (
          <div className="rounded-lg border border-status-down/30 bg-status-down-bg p-5 space-y-3 text-left">
            <div className="flex items-center gap-2 text-status-down">
              <AlertCircle size={18} />
              <span className="font-medium text-sm">Erreur SSO</span>
            </div>
            <p className="text-sm text-text-secondary">{errorMsg}</p>
            <a
              href="/login"
              className="inline-block text-xs text-primary hover:underline mt-1"
            >
              ← Retour à la connexion
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
