/**
 * Firewall rule management (SECURITY-PARITY-21): every field of a
 * firewall_add / firewall_delete / firewall_toggle command is validated here
 * and the agent payload is rebuilt from the parsed fields only, never from
 * req.body. agent/firewall_rules.go re-validates with the same rules before
 * anything reaches nft / firewalld / ufw / iptables / netsh.
 *
 * client/src/components/agent/FirewallPanel.tsx mirrors these rules for
 * inline errors: keep the three in step.
 */
import { z } from 'zod';
import { banPrefixFloor, parseIpOrCidr } from '../utils/ipValidation';

export const FIREWALL_RULE_NAME_RE = /^[A-Za-z0-9 _.-]{1,64}$/;

/**
 * Rule ids are produced by the agent's own listing. Backend ids (nft
 * family:table:chain:handle, ufw:N, ipt:CHAIN:N, rich:N, pf:N) match this
 * strict form.
 */
export const FIREWALL_RULE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * netsh rule ids are the Windows rule display name plus '::in' / '::out'
 * (e.g. "Remote Desktop - User Mode (TCP-In)::in", localized names with
 * accents) and firewalld port ids carry a '/' ("port:8080/tcp"): they cannot
 * fit the strict form. Accepted: printable text without quotes, backslashes
 * or control characters, not starting with '-'. Each agent backend then
 * re-parses its own id format strictly; the id is always one argv element.
 */
const FIREWALL_RULE_ID_DISPLAY_RE = /^(?!-)[^\u0000-\u001f\u007f-\u009f"\\]{1,256}$/u;

/**
 * Names a custom rule never takes: the agent's ban rules (Obliguard-Block-*)
 * and netsh's "all" wildcard (delete rule name=all removes every rule).
 * Surrounding spaces are ignored: netsh may trim "all " into the wildcard.
 */
export function isReservedFirewallRuleName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === 'all' || n.startsWith('obliguard-block-');
}

const PORT_RE = /^([1-9][0-9]{0,4})(?:-([1-9][0-9]{0,4}))?$/;

/** Canonical port spec ("22" or "1000-2000"); null when invalid. */
export function normalizeFirewallPort(raw: string): string | null {
  const m = PORT_RE.exec(raw);
  if (!m) return null;
  const a = Number(m[1]);
  if (a > 65535) return null;
  if (m[2] === undefined) return String(a);
  const b = Number(m[2]);
  if (b > 65535 || b < a) return null;
  return a === b ? String(a) : `${a}-${b}`;
}

/** '' / 'any' (any case) / absent mean "no constraint". */
function isAny(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && (v.trim() === '' || v.trim().toLowerCase() === 'any'));
}

const optionalPort = z.preprocess(
  (v) => (isAny(v) ? undefined : typeof v === 'number' ? String(v) : v),
  z.string()
    .max(11)
    .transform((s, ctx) => {
      const p = normalizeFirewallPort(s.trim());
      if (p == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Port must be a number from 1 to 65535 or a range like 8000-8100' });
        return z.NEVER;
      }
      return p;
    })
    .optional(),
);

const optionalRemoteIp = z.preprocess(
  (v) => (isAny(v) ? undefined : v),
  z.string()
    .max(64)
    .transform((s, ctx) => {
      const p = parseIpOrCidr(s);
      if (!p) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Remote IP must be an IP address or a CIDR network' });
        return z.NEVER;
      }
      const full = p.family === 4 ? 32 : 128;
      return { cidr: p.prefix === full ? p.address : `${p.address}/${p.prefix}`, family: p.family, prefix: p.prefix };
    })
    .optional(),
);

const optionalName = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string()
    .regex(FIREWALL_RULE_NAME_RE, 'Rule name: 1-64 characters, letters, digits, space, _ . - only')
    .refine((s) => s.trim() === s, 'Rule name must not start or end with a space')
    .refine((s) => !isReservedFirewallRuleName(s), 'Rule name is reserved')
    .optional(),
);

export const firewallAddSchema = z.object({
  name: optionalName,
  direction: z.enum(['in', 'out'], { errorMap: () => ({ message: "Direction must be 'in' or 'out'" }) }),
  action: z.enum(['allow', 'block'], { errorMap: () => ({ message: "Action must be 'allow' or 'block'" }) }),
  protocol: z.enum(['tcp', 'udp', 'icmp', 'any'], { errorMap: () => ({ message: 'Protocol must be tcp, udp, icmp or any' }) }),
  localPort: optionalPort,
  remotePort: optionalPort,
  remoteIp: optionalRemoteIp,
}).superRefine((r, ctx) => {
  if ((r.localPort || r.remotePort) && r.protocol !== 'tcp' && r.protocol !== 'udp') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [r.localPort ? 'localPort' : 'remotePort'],
      message: 'A port needs protocol tcp or udp',
    });
  }
  // Allow rules take any network (that is their point). A block rule obeys
  // the ban floor: the widest network an operator may cut off in one rule.
  if (r.action === 'block' && r.remoteIp) {
    const floors = banPrefixFloor();
    const floor = r.remoteIp.family === 4 ? floors.v4 : floors.v6;
    if (r.remoteIp.prefix < floor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remoteIp'],
        message: `Network too broad for a block rule: the widest is /${floor} for IPv${r.remoteIp.family}`,
      });
    }
  }
});

export const firewallRuleIdSchema = z.string()
  .refine((s) => !s.startsWith('-') && (FIREWALL_RULE_ID_RE.test(s) || FIREWALL_RULE_ID_DISPLAY_RE.test(s)), 'Invalid firewall rule id')
  // The agent's own ban rules are managed by the agent, never from here.
  .refine((s) => !isReservedFirewallRuleName(s.replace(/::(in|out)$/, '')), 'Reserved firewall rule');

export const firewallToggleSchema = z.object({
  enabled: z.boolean({ errorMap: () => ({ message: 'enabled must be a boolean' }) }),
});

/** The firewall_add payload sent to the agent: known keys only, canonical values. */
export type FirewallAddPayload = {
  name?: string;
  direction: 'in' | 'out';
  action: 'allow' | 'block';
  protocol: 'tcp' | 'udp' | 'icmp' | 'any';
  localPort?: string;
  remotePort?: string;
  remoteIp?: string;
};

export function toFirewallAddPayload(r: z.infer<typeof firewallAddSchema>): FirewallAddPayload {
  const p: FirewallAddPayload = { direction: r.direction, action: r.action, protocol: r.protocol };
  if (r.name) p.name = r.name;
  if (r.localPort) p.localPort = r.localPort;
  if (r.remotePort) p.remotePort = r.remotePort;
  if (r.remoteIp) p.remoteIp = r.remoteIp.cidr;
  return p;
}

/** First issue as "field: message" plus zod's per-field map (same shape as middleware/validate.ts). */
export function firewallValidationError(err: z.ZodError): { error: string; details: Record<string, string[] | undefined> } {
  const first = err.errors[0];
  const field = first?.path?.[0];
  return {
    error: first ? (field !== undefined ? `${String(field)}: ${first.message}` : first.message) : 'Invalid input',
    details: err.flatten().fieldErrors,
  };
}
