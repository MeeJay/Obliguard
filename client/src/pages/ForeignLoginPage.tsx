/**
 * ForeignLoginPage
 *
 * Entry point for cross-platform SSO.  Obliview (or any other connected platform)
 * redirects here with:
 *
 *   /auth/foreign?token=<one-time-token>&from=<base-url>&source=<source-name>[&redirect=<path>]
 *
 * This page calls POST /api/auth/foreign-login, which:
 *   1. Contacts {from}/api/obliguard/validate-token?token=… (Bearer shared-secret)
 *   2. Finds or creates a local user record
 *   3. Establishes a session
 *
 * On success → redirect to `redirect` param (default `/`)
 * On error   → show error + link back to login
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, Loader2, AlertCircle } from 'lucide-react';
import apiClient from '@/api/client';
import { useAuthStore } from '@/store/authStore';
import type { ApiResponse, User } from '@obliview/shared';

export function ForeignLoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { checkSession } = useAuthStore();

  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const token     = searchParams.get('token');
    const from      = searchParams.get('from');
    const source    = searchParams.get('source') ?? 'obliview';
    const redirect  = searchParams.get('redirect') ?? '/';

    if (!token || !from) {
      setErrorMsg('Lien SSO invalide — paramètres manquants (token, from).');
      setStatus('error');
      return;
    }

    void (async () => {
      try {
        const res = await apiClient.post<ApiResponse<{ user: User; isFirstLogin: boolean }>>('/sso/exchange', {
          token,
          from,
          foreignSource: source,
        });

        // Session established — sync store then navigate
        await checkSession();

        // New users get a chance to set a display name / local password
        if (res.data.data?.isFirstLogin) {
          navigate('/sso-enroll', { replace: true });
        } else {
          navigate(redirect, { replace: true });
        }
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
        const msg = axiosErr?.response?.data?.error ?? 'Échec de la connexion SSO.';
        setErrorMsg(msg);
        setStatus('error');
      }
    })();
  }, [searchParams, navigate, checkSession]);

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
