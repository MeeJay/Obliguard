import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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
import { GroupManagePage } from '@/pages/GroupManagePage';
import { SettingsPage } from '@/pages/SettingsPage';
import { WorkspaceSettingsPage } from '@/pages/WorkspaceSettingsPage';
import { NotificationsPage } from '@/pages/NotificationsPage';
import { AdminUsersPage } from '@/pages/AdminUsersPage';
import { AdminAgentPage } from '@/pages/AdminAgentPage';
import { AgentDetailPage } from '@/pages/AgentDetailPage';
import { AgentListPage } from '@/pages/AgentListPage';
import { LiveEventsPage } from '@/pages/LiveEventsPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { GroupDetailPage } from '@/pages/GroupDetailPage';
import { GroupEditPage } from '@/pages/GroupEditPage';
import { DownloadPage } from '@/pages/DownloadPage';
import { AdminTenantsPage } from '@/pages/AdminTenantsPage';
import { PoliciesPage } from '@/pages/PoliciesPage';
import { AuditLogPage } from '@/pages/AuditLogPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ConfirmProvider } from '@/components/common/ConfirmDialog';
import '@/i18n';
import { initTheme } from '@/utils/theme';

// Apply saved theme immediately to avoid flash of unstyled content
initTheme();

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
        {/* Protected routes */}
        <Route element={<ProtectedRoute />}>
          {/* Enrollment — full-screen, outside AppLayout */}
          <Route path="/enroll" element={<EnrollmentPage />} />
          <Route element={<AppLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/netmap" element={<NetMapPage />} />
            <Route path="/ip-reputation" element={<IPReputationPage />} />
            <Route path="/download" element={<DownloadPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/group/:id" element={<GroupDetailPage />} />

            {/* Viewable by any tenant member — "View monitors, groups, events".
                Write actions inside are gated by capability (client) + route
                middleware (server). /agents is the fleet list (owner
                decision: every member, read-only included, sees the fleet). */}
            <Route path="/agents" element={<AgentListPage />} />
            <Route path="/agents/:deviceId" element={<AgentDetailPage />} />
            <Route path="/live-events" element={<LiveEventsPage />} />

            {/* Legacy Bans / Whitelist pages → the matching tab of the IP
                Reputation hub. Open to every member (the header ban chip
                links to /bans). */}
            <Route path="/bans" element={<Navigate to="/ip-reputation?tab=bans" replace />} />
            <Route path="/whitelist" element={<Navigate to="/ip-reputation?tab=whitelist" replace />} />

            {/* Capability-gated routes (any-of, platform admin always passes).
                Each page further gates its own write actions; the server
                enforces the same capabilities (routePermissions). */}

            {/* Agent management: enrolment keys, approvals or agent edits. */}
            <Route element={<ProtectedRoute requiredCapabilities={['agents.keys', 'agents.approve', 'agents.manage']} />}>
              <Route path="/manage/agents" element={<AdminAgentPage />} />
            </Route>

            <Route element={<ProtectedRoute requiredCapabilities={['groups.manage']} />}>
              <Route path="/groups" element={<GroupManagePage />} />
              {/* Editing one group: per-group RW is checked by the page and the server. */}
              <Route path="/group/:id/edit" element={<GroupEditPage />} />
            </Route>

            <Route element={<ProtectedRoute requiredCapabilities={['notifications.manage']} />}>
              <Route path="/notifications" element={<NotificationsPage />} />
            </Route>

            <Route element={<ProtectedRoute requiredCapabilities={['users.manage']} />}>
              <Route path="/manage/users" element={<AdminUsersPage />} />
            </Route>

            {/* Audit log: audit.read (Default = every tenant, else the operating tenant). */}
            <Route element={<ProtectedRoute requiredCapabilities={['audit.read']} />}>
              <Route path="/audit-log" element={<AuditLogPage />} />
            </Route>

            {/* IPS Policies hub: service templates (templates.write, read-only
                with ips.view), network limits (rate_limit.write) and remote
                blocklists (remote_blocklists). Each tab is shown only to the
                holders of its capability. */}
            <Route element={<ProtectedRoute requiredCapabilities={['templates.write', 'ips.view', 'rate_limit.write', 'remote_blocklists']} />}>
              <Route path="/policies" element={<PoliciesPage />} />
            </Route>

            {/* Legacy pages → the matching tab of the Policies hub (same gate
                as the tab, so a link never lands on a hidden tab). */}
            <Route element={<ProtectedRoute requiredCapabilities={['templates.write', 'ips.view']} />}>
              <Route path="/manage/service-templates" element={<Navigate to="/policies?tab=templates" replace />} />
            </Route>

            <Route element={<ProtectedRoute requiredCapabilities={['rate_limit.write']} />}>
              <Route path="/manage/network-limiting" element={<Navigate to="/policies?tab=limits" replace />} />
            </Route>

            {/* Workspace level of the IPS settings cascade (W13): settings
                rows are tenant-scoped, so the 'settings' capability opens it. */}
            <Route element={<ProtectedRoute requiredCapabilities={['settings']} />}>
              <Route path="/settings/workspace" element={<WorkspaceSettingsPage />} />
            </Route>

            {/* Platform-admin only: workspaces, and the global settings page
                (instance-wide sections: SMTP, retention, blocklists, danger zone). */}
            <Route element={<ProtectedRoute requiredRole="admin" />}>
              <Route path="/manage/tenants" element={<AdminTenantsPage />} />
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
      {/* Host for useConfirm() / usePrompt() / confirmDialog() / promptDialog()
          — replaces window.confirm / window.prompt. */}
      <ConfirmProvider />
    </BrowserRouter>
  );
}
