import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { AppLayout } from '@/components/layout/AppLayout';
import { LoginPage } from '@/pages/LoginPage';
import { EnrollmentPage } from '@/pages/EnrollmentPage';
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { NetMapPage } from '@/pages/NetMapPage';
import { IPReputationPage } from '@/pages/IPReputationPage';
import { BansPage } from '@/pages/BansPage';
import { WhitelistPage } from '@/pages/WhitelistPage';
import { GroupManagePage } from '@/pages/GroupManagePage';
import { SettingsPage } from '@/pages/SettingsPage';
import { NotificationsPage } from '@/pages/NotificationsPage';
import { AdminUsersPage } from '@/pages/AdminUsersPage';
import { AdminAgentPage } from '@/pages/AdminAgentPage';
import { AgentDetailPage } from '@/pages/AgentDetailPage';
import { LiveEventsPage } from '@/pages/LiveEventsPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { GroupDetailPage } from '@/pages/GroupDetailPage';
import { GroupEditPage } from '@/pages/GroupEditPage';
import { DownloadPage } from '@/pages/DownloadPage';
import { ImportExportPage } from '@/pages/ImportExportPage';
import { AdminTenantsPage } from '@/pages/AdminTenantsPage';
import { ServiceTemplatesPage } from '@/pages/ServiceTemplatesPage';
import { ForeignLoginPage } from '@/pages/ForeignLoginPage';
import { SsoEnrollPage } from '@/pages/SsoEnrollPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import '@/i18n';

export default function App() {
  const { checkSession } = useAuthStore();

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        {/* Foreign SSO entry — public, handles token validation server-side */}
        <Route path="/auth/foreign" element={<ForeignLoginPage />} />

        {/* Protected routes */}
        <Route element={<ProtectedRoute />}>
          {/* Enrollment — full-screen, outside AppLayout */}
          <Route path="/enroll" element={<EnrollmentPage />} />
          {/* SSO new-user enrollment — full-screen, outside AppLayout */}
          <Route path="/sso-enroll" element={<SsoEnrollPage />} />
          <Route element={<AppLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/netmap" element={<NetMapPage />} />
            <Route path="/ip-reputation" element={<IPReputationPage />} />
            <Route path="/download" element={<DownloadPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/group/:id" element={<GroupDetailPage />} />
            <Route path="/group/:id/edit" element={<GroupEditPage />} />

            {/* Admin-only routes */}
            <Route element={<ProtectedRoute requiredRole="admin" />}>
              <Route path="/bans" element={<BansPage />} />
              <Route path="/whitelist" element={<WhitelistPage />} />
              <Route path="/groups" element={<GroupManagePage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/admin/users" element={<AdminUsersPage />} />
              <Route path="/admin/agents" element={<AdminAgentPage />} />
              <Route path="/admin/import-export" element={<ImportExportPage />} />
              <Route path="/admin/tenants" element={<AdminTenantsPage />} />
              <Route path="/admin/service-templates" element={<ServiceTemplatesPage />} />
              <Route path="/agents/:deviceId" element={<AgentDetailPage />} />
              <Route path="/live-events" element={<LiveEventsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Route>
        </Route>

        {/* 404 */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>

      <Toaster
        position="top-right"
        toastOptions={{
          className: '!bg-bg-secondary !text-text-primary !border !border-border',
          duration: 4000,
        }}
      />
    </BrowserRouter>
  );
}
