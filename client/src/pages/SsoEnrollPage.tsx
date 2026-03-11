/**
 * SsoEnrollPage
 *
 * Shown after a brand-new foreign SSO user is created on Obliguard (isFirstLogin = true).
 * Lets them optionally:
 *   - Set a display name
 *   - Set a local password so they can also log in directly (without SSO)
 *
 * Both steps are optional — the user can skip everything.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { UserCircle, KeyRound, Eye, EyeOff } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import apiClient from '@/api/client';
import type { ApiResponse, User } from '@obliview/shared';

export function SsoEnrollPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, checkSession } = useAuthStore();

  // Display name
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  // Local password (optional)
  const [password, setPassword]       = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const redirect = searchParams.get('redirect') ?? '/';

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (password && password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      // Update display name
      await apiClient.put<ApiResponse<User>>('/profile', { displayName: displayName.trim() || null });
      // Optionally set local password
      if (password) {
        await apiClient.post('/sso/set-password', { password });
      }
      await checkSession();
      navigate(redirect, { replace: true });
    } catch {
      setError('Impossible de sauvegarder les informations.');
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = () => navigate(redirect, { replace: true });

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center">
            <div className="rounded-full bg-accent/10 p-4">
              <UserCircle size={36} className="text-accent" />
            </div>
          </div>
          <h1 className="text-xl font-bold text-text-primary">Bienvenue sur Obliguard</h1>
          <p className="text-sm text-text-secondary">
            Ton compte a été créé via SSO depuis Obliview. Ces étapes sont optionnelles.
          </p>
        </div>

        <form
          onSubmit={(e) => { void handleSave(e); }}
          className="rounded-lg border border-border bg-bg-secondary p-6 space-y-5"
        >
          <Input
            label="Nom affiché (optionnel)"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={user?.username ?? 'Ton nom…'}
            autoFocus
          />

          {/* Local password — optional, allows direct login in addition to SSO */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              <span className="flex items-center gap-1.5">
                <KeyRound size={13} />
                Mot de passe local (optionnel)
              </span>
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Laisser vide pour rester SSO uniquement"
                autoComplete="new-password"
                className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary pr-9"
              />
              <button
                type="button"
                onClick={() => setShowPassword(p => !p)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <p className="text-xs text-text-muted mt-1">
              En définissant un mot de passe tu pourras aussi te connecter directement, sans Obliview.
            </p>
          </div>

          {error && (
            <p className="text-sm text-status-down">{error}</p>
          )}

          <div className="flex gap-3">
            <Button type="submit" loading={saving} className="flex-1">
              Sauvegarder
            </Button>
            <Button type="button" variant="secondary" onClick={handleSkip} className="flex-1">
              Ignorer
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
