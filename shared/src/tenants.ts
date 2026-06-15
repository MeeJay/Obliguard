// Master / default tenant — the "god view".
//
// The default tenant (seeded with id=1 in migration 001) acts as a god view:
// when the active session tenant is the master, operational data from ALL
// tenants is visible, and an IP unban there is authoritative (lifts globally).
//
// Identity is positional (id === 1), matching Obliance/Obliview — there is no
// is_master column. Null/undefined are treated as "not master" so a missing
// tenant never accidentally grants god view.
//
// SECURITY RULE: god view applies to OPERATIONAL data only (devices, groups,
// templates, bans, reputation, whitelist, rate-limits, …). Credentials/secrets
// (agent API keys, SMTP passwords, notification channel configs) and per-agent
// enforcement resolvers (resolve*ForAgent) MUST stay tenant-scoped.

export const MASTER_TENANT_ID = 1;

export function isMasterTenant(tenantId: number | null | undefined): boolean {
  return tenantId === MASTER_TENANT_ID;
}
