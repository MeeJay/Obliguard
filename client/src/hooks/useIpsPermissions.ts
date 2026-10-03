import { useCan, useIsPlatformAdmin } from './usePermission';
import { useIsMasterTenant } from './useIsMasterTenant';

/**
 * What the current user may do with IPs, bans and the whitelist in the
 * current tenant. Mirrors the server:
 *
 *  - bans.routes / whitelist.routes capability guards (bans.create,
 *    bans.lift, bans.promote, whitelist.write, ip.labels,
 *    ip.reputation.clear);
 *  - ban.service: from the master (Default) tenant a Lift is authoritative
 *    and global; from any other tenant it is always local (a per-tenant
 *    exclusion for a global ban). Promote to global is Default-only;
 *  - manual bans / whitelist entries follow the operating tenant: global from
 *    the Default tenant, tenant-scoped elsewhere;
 *  - the platform wipes are platform admin + Default tenant.
 */
export interface IpsPermissions {
  /** Create a ban (scope follows the operating tenant). */
  canBan: boolean;
  /** Lift / exclude a ban (local unless canLiftGlobally). */
  canLift: boolean;
  /** Lift is authoritative for every tenant (Default tenant). */
  canLiftGlobally: boolean;
  /** Promote a tenant ban to global (Default tenant only). */
  canPromote: boolean;
  /** Add / edit / remove whitelist entries. */
  canWhitelist: boolean;
  /** Whitelist entries created here apply to every tenant (Default tenant). */
  canWhitelistGlobally: boolean;
  /** Manage IP display names. */
  canLabel: boolean;
  /** Clear IP reputation rows. */
  canClear: boolean;
  /** Platform wipes of every ban / every IP (platform admin, Default tenant). */
  canWipe: boolean;
  /** Default-tenant god view: data of every tenant, tenant badges and filters. */
  isGodView: boolean;
}

export function useIpsPermissions(): IpsPermissions {
  const isMaster = useIsMasterTenant();
  const isPlatformAdmin = useIsPlatformAdmin();
  const canBan = useCan('bans.create');
  const canLift = useCan('bans.lift');
  const canPromoteCap = useCan('bans.promote');
  const canWhitelist = useCan('whitelist.write');
  const canLabel = useCan('ip.labels');
  const canClear = useCan('ip.reputation.clear');

  return {
    canBan,
    canLift,
    canLiftGlobally: canLift && isMaster,
    canPromote: canPromoteCap && isMaster,
    canWhitelist,
    canWhitelistGlobally: canWhitelist && isMaster,
    canLabel,
    canClear,
    canWipe: isPlatformAdmin && isMaster,
    isGodView: isMaster,
  };
}
