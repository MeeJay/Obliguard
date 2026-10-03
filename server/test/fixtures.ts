/**
 * Fixture constants of the verification harness.
 *
 * ── IP policy (enforced by review) ──────────────────────────────────────────
 * DYNAMIC addresses come only from nextIp() (seed.ts): 203.0.113.1-254, then
 * 198.51.100.1-254, then it throws. No literal ever uses these two /24s.
 *
 * LITERAL addresses come only from litIp() / these blocks:
 *   - 192.0.2.0/24     whitelist CIDR examples, and suite 14;
 *   - 198.18.0.0/15    ONE distinct third octet per test: 198.18.12.x (05#12),
 *                      198.18.14.x and 198.18.15.x (04#14), 198.18.100-119.x
 *                      (05#7 bulk list); the whole /15, 198.19.0.0/16,
 *                      198.18.0.0/23 and 198.18.2.0/24 only in 06/07;
 *   - 192.0.0.0/8      only as a REFUSED /8 in 06#7;
 *   - 2001:db8::/32    a distinct third group per test.
 * No literal is a string prefix of a dynamic address: the baseline
 * computeBanDelta matches whitelist entries with `banIp.startsWith(...)` and
 * the ban / reputation searches use `ip::text ILIKE %s%`.
 * List assertions compare exact host parts (`r.ip.split('/')[0] === X`),
 * never array lengths or response-text substrings.
 *
 * XFF_BLOCK: each harness Client sends X-Forwarded-For 10.99.<n>>8>.<n&255>
 * (n = per-process counter from 1), so per-IP limiters never aggregate across
 * tests (trust proxy 1). These addresses are never banned or whitelisted.
 */

export const PASSWORD = 'Verify-Pass-1!';
export const VERIFY_HOST = 'verify.local';
export const VERIFY_ORIGIN = 'http://verify.local';
export const OBLIGATE_API_KEY = 'obligate-verify-key-0123456789abcdef';
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export const T = { DEFAULT: 1, B: 2, C: 3 } as const;

export interface UserFixture {
  id: number;
  username: string;
  role: 'admin' | 'user';
  tenants: number[];
  totp?: boolean;
  foreign?: { source: 'obligate'; id: number };
}

export const USERS: UserFixture[] = [
  { id: 1, username: 'admin', role: 'admin', tenants: [] },
  { id: 2, username: 'admin2', role: 'admin', tenants: [] },
  { id: 3, username: 'default_member', role: 'user', tenants: [1] },
  { id: 4, username: 'member_b', role: 'user', tenants: [2] },
  { id: 5, username: 'member_c', role: 'user', tenants: [3] },
  { id: 6, username: 'no_tenant', role: 'user', tenants: [] },
  { id: 7, username: 'member_bc', role: 'user', tenants: [2, 3] },
  { id: 8, username: 'totp_user', role: 'user', tenants: [2], totp: true },
  { id: 9, username: 'og_sso', role: 'user', tenants: [2], foreign: { source: 'obligate', id: 9001 } },
];

/** username → id */
export const U = Object.fromEntries(USERS.map((u) => [u.username, u.id])) as Record<string, number> & {
  admin: number; admin2: number; default_member: number; member_b: number; member_c: number;
  no_tenant: number; member_bc: number; totp_user: number; og_sso: number;
};

export const OG = { obligateUserId: 9001, userId: 9 } as const;

/**
 * Tenant admin of tenant 2 (tenant role 'admin': every capability of tenant 2,
 * no platform role; W7-2). Kept out of USERS (whose memberships are seeded as
 * 'user') like seed.VIEWER_B; suites that need it create it when the seed
 * does not (suites 66/67: ensureAdminB).
 */
export const ADMIN_B = { id: 11, username: 'admin_b', tenant: 2, tenantRole: 'admin' } as const;

/** Agent API keys: key N belongs to tenant N. */
export const KEYS: Record<1 | 2 | 3, string> = {
  1: 'aaaaaaaa-0000-4000-8000-000000000001',
  2: 'aaaaaaaa-0000-4000-8000-000000000002',
  3: 'aaaaaaaa-0000-4000-8000-000000000003',
};

export const G = { DEFAULT: 1, B: 2, C: 3, B_EVAL: 4 } as const;

export interface GroupFixture { id: number; slug: string; tenant: number; evaluateOnly: boolean }
export const GROUPS: GroupFixture[] = [
  { id: 1, slug: 'g-default', tenant: 1, evaluateOnly: false },
  { id: 2, slug: 'g-b', tenant: 2, evaluateOnly: false },
  { id: 3, slug: 'g-c', tenant: 3, evaluateOnly: false },
  { id: 4, slug: 'g-b-eval', tenant: 2, evaluateOnly: true },
];

export interface DeviceFixture {
  id: number;
  uuid: string;
  hostname: string;
  tenant: number;
  keyId: number;
  groupId: number | null;
  status: 'approved' | 'pending';
  version: string;
}

export const D = {
  DEFAULT:   { id: 1, uuid: 'dev-default-0001',   hostname: 'host-default',   tenant: 1, keyId: 1, groupId: 1,    status: 'approved', version: '1.0.0' },
  B:         { id: 2, uuid: 'dev-b-0001',         hostname: 'host-b',         tenant: 2, keyId: 2, groupId: 2,    status: 'approved', version: '1.0.0' },
  C:         { id: 3, uuid: 'dev-c-0001',         hostname: 'host-c',         tenant: 3, keyId: 3, groupId: 3,    status: 'approved', version: '0.9.0' },
  B_EVAL:    { id: 4, uuid: 'dev-b-eval-0001',    hostname: 'host-b-eval',    tenant: 2, keyId: 2, groupId: 4,    status: 'approved', version: '1.0.0' },
  B_PENDING: { id: 5, uuid: 'dev-b-pending-0001', hostname: 'host-b-pending', tenant: 2, keyId: 2, groupId: null, status: 'pending',  version: '1.0.0' },
} as const satisfies Record<string, DeviceFixture>;

export interface TeamFixture {
  id: number;
  name: string;
  tenant: number;
  members: number[];
  perm: { scope: 'group'; scope_id: number; level: 'rw' | 'ro'; capabilities: string[] };
}

export const TEAMS = {
  C_TEAM: { id: 1, name: 'C-team', tenant: 3, members: [4], perm: { scope: 'group', scope_id: 3, level: 'rw', capabilities: ['bans'] } },
  B_TEAM: { id: 2, name: 'B-team', tenant: 2, members: [],  perm: { scope: 'group', scope_id: 2, level: 'rw', capabilities: ['whitelist'] } },
} as const satisfies Record<string, TeamFixture>;

/** The whole DYNAMIC pool, in allocation order. */
export const DYNAMIC_BLOCKS = ['203.0.113', '198.51.100'] as const;
