import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { CapabilityKey } from '@obliview/shared';
import { useAuthStore } from '@/store/authStore';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { NoTenantPage } from '@/pages/NoTenantPage';

// Must match REQUIRED_ENROLLMENT_VERSION in server/src/controllers/enrollment.controller.ts
const REQUIRED_ENROLLMENT_VERSION = 2;

interface ProtectedRouteProps {
  /** Hard role gate: only users with this exact platform role pass. */
  requiredRole?: string;
  /** Gate the route on one capability (platform admin ⇒ always allowed). */
  requiredCapability?: CapabilityKey;
  /**
   * Capability gate, ANY-OF (Obliance ProtectedRoute): passes when the user is
   * platform admin or holds at least one of the listed capabilities in the
   * current tenant (tenant capabilities or legacy aliases, see
   * authStore.hasCapability). Used for pages a tenant admin / delegated role
   * may reach. When several gates are passed, all of them must pass.
   */
  requiredCapabilities?: readonly CapabilityKey[];
}

export function ProtectedRoute({ requiredRole, requiredCapability, requiredCapabilities }: ProtectedRouteProps) {
  const { user, isInitialized, hasCapability, noTenantAccess, requires2faSetup } = useAuthStore();
  const location = useLocation();

  if (!isInitialized) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-primary">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Redirect to enrollment if user hasn't completed the required enrollment version.
  // Skip the check when already on /enroll to prevent a redirect loop.
  // Skip for Obligate SSO users — onboarding is managed by Gate.
  if (
    user.foreignSource !== 'obligate' &&
    (user.enrollmentVersion ?? 0) < REQUIRED_ENROLLMENT_VERSION &&
    location.pathname !== '/enroll'
  ) {
    return <Navigate to="/enroll" replace />;
  }

  // Non-admin without any usable workspace: profile / 2FA / sign-out only.
  // The enrollment page uses global endpoints and stays reachable.
  if (
    noTenantAccess &&
    user.role !== 'admin' &&
    location.pathname !== '/enroll'
  ) {
    return <NoTenantPage />;
  }

  // force_2fa: until a second factor is set up the server answers 403
  // twoFactorSetupRequired on every tenant API, so the only useful page is the
  // profile's 2FA section. Obligate (og_) accounts never get the flag.
  if (requires2faSetup && location.pathname !== '/profile' && location.pathname !== '/enroll') {
    return <Navigate to="/profile?setup2fa=1" replace />;
  }

  if (requiredRole && user.role !== requiredRole) {
    return <Navigate to="/" replace />;
  }

  if (requiredCapability && !hasCapability(requiredCapability)) {
    return <Navigate to="/" replace />;
  }

  if (requiredCapabilities && requiredCapabilities.length > 0
    && !requiredCapabilities.some((c) => hasCapability(c))) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
