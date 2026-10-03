import { createElement, Fragment, type ReactNode } from 'react';
import type { CapabilityKey } from '@obliview/shared';
import { useAuthStore } from '@/store/authStore';

/**
 * Client permission layer (mirrors the server guards, so the UI shows exactly
 * what the server allows):
 *
 *   const canLift = useCan('bans.lift');
 *   const canSeeAgents = useCan(['agents.keys', 'agents.approve', 'agents.manage']);  // any-of
 *   <Can cap="whitelist.write" fallback={<ReadOnlyHint />}>…</Can>
 *
 * Capabilities are those of the CURRENT tenant (`permissions.tenantCapabilities`,
 * resolved server-side from the membership's permission set). Legacy aliases
 * ('bans', 'monitor_rw', ...) are understood: an alias is held when every
 * capability it stands for is held. A platform admin holds everything.
 *
 * Platform-only areas (workspaces, global settings) are not capabilities: use
 * useIsPlatformAdmin(). Master-tenant (god view) rules: useIsMasterTenant() /
 * useIpsPermissions().
 */

/** One capability, or a list read as ANY-OF. */
export type CapabilityRequirement = CapabilityKey | readonly CapabilityKey[];

function asList(req: CapabilityRequirement): readonly CapabilityKey[] {
  return typeof req === 'string' ? [req] : req;
}

/**
 * Non-hook check (event handlers, stores): true when the signed-in user holds
 * at least one of the capabilities in the current tenant. An empty list is
 * never satisfied.
 */
export function canNow(req: CapabilityRequirement): boolean {
  const { hasCapability } = useAuthStore.getState();
  return asList(req).some((c) => hasCapability(c));
}

/**
 * True when the user holds the capability (or ANY of the list) in the current
 * tenant. Re-renders when the session, the tenant or the permissions change.
 */
export function useCan(req: CapabilityRequirement): boolean {
  // The selector re-runs on every store change: `user` and `permissions` are
  // what hasCapability reads, so a tenant switch / permission refresh updates
  // every gated control.
  return useAuthStore((s) => asList(req).some((c) => s.hasCapability(c)));
}

/** Platform admin (users.role === 'admin'): platform-only areas and the god view. */
export function useIsPlatformAdmin(): boolean {
  return useAuthStore((s) => s.user?.role === 'admin');
}

interface CanProps {
  /** Capability, or a list read as ANY-OF. */
  cap: CapabilityRequirement;
  /** Rendered when the capability is missing (default: nothing). */
  fallback?: ReactNode;
  children?: ReactNode;
}

/** Renders `children` only when the user holds `cap` (any-of), else `fallback`. */
export function Can({ cap, fallback = null, children }: CanProps) {
  const allowed = useCan(cap);
  return createElement(Fragment, null, allowed ? children : fallback);
}
