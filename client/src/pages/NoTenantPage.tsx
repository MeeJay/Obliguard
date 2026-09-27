import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2 } from 'lucide-react';
import { useAuthStore, resyncSession } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { ProfilePage } from '@/pages/ProfilePage';

/**
 * Full-screen page for a signed-in non-admin without any usable workspace.
 * Profile and 2FA stay reachable (global endpoints); a periodic session check
 * reloads the app as soon as an administrator assigns a workspace.
 */
export function NoTenantPage() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const [showProfile, setShowProfile] = useState(false);
  const [checking, setChecking] = useState(false);
  const isSso = user?.foreignSource === 'obligate';

  const retry = useCallback(async () => {
    setChecking(true);
    try {
      await resyncSession();
    } finally {
      setChecking(false);
    }
  }, []);

  // No socket is connected in this state: poll so a new membership is picked
  // up (resyncSession reloads to '/' when access returns). Never goes through
  // SSO on its own — only the SSO button does.
  useEffect(() => {
    const id = setInterval(() => { void retry(); }, 30_000);
    return () => clearInterval(id);
  }, [retry]);

  if (showProfile) {
    return (
      <div className="min-h-screen bg-bg-primary p-4">
        <div className="mx-auto max-w-4xl">
          <Button variant="secondary" onClick={() => setShowProfile(false)}>
            {t('common.back', 'Back')}
          </Button>
          <ProfilePage />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg-primary p-4 text-center">
      <Building2 size={40} className="text-text-muted" />
      <h1 className="mt-4 text-xl font-semibold text-text-primary">
        {t('tenant.noAccess.title', 'No workspace assigned')}
      </h1>
      <p className="mt-2 max-w-md text-sm text-text-secondary">
        {isSso
          ? t('tenant.noAccess.ssoBody', 'Your workspaces are assigned in Obligate, and a local workspace with the same identifier must exist here. Ask an administrator, then sign in again.')
          : t('tenant.noAccess.body', 'Your account is not a member of any workspace yet. Ask an administrator to add you to a workspace, then check again.')}
      </p>
      {user && <p className="mt-2 font-mono text-xs text-text-muted">{user.username}</p>}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {isSso ? (
          <Button onClick={() => window.location.assign('/auth/sso-redirect')}>
            {t('tenant.noAccess.ssoRetry', 'Sign in again')}
          </Button>
        ) : (
          <Button onClick={() => { void retry(); }} loading={checking}>
            {t('tenant.noAccess.retry', 'Check again')}
          </Button>
        )}
        <Button variant="secondary" onClick={() => setShowProfile(true)}>
          {t('nav.profile', 'Profile')}
        </Button>
        <Button variant="secondary" onClick={() => { void logout(); }}>
          {t('nav.signOut', 'Sign out')}
        </Button>
      </div>
    </div>
  );
}
