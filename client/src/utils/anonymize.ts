import { useAuthStore } from '../store/authStore';

/** Check whether anonymous mode is active for the current user. */
export function isAnonymous(): boolean {
  return useAuthStore.getState().user?.preferences?.anonymousMode === true;
}

/**
 * Mask a hostname / agent name.
 * "srv-prod-01" → "srv-•••••••"  (keep first 3 chars + mask rest)
 * Short names (≤3) → "•••"
 */
export function anonHostname(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;
  if (value.length <= 3) return '•••';
  return value.slice(0, 3) + '•'.repeat(Math.min(value.length - 3, 8));
}

/**
 * Mask an IP address.
 * "192.168.1.42"  → "192.•••.•.••"
 * "10.0.0.1"      → "10.•.•.•"
 * IPv6            → first segment + ":••••:…"
 */
export function anonIp(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;
  // CIDR suffix: preserve it
  let cidr = '';
  let ip = value;
  const slashIdx = value.indexOf('/');
  if (slashIdx !== -1) {
    cidr = value.slice(slashIdx);
    ip = value.slice(0, slashIdx);
  }
  if (ip.includes(':')) {
    // IPv6
    const parts = ip.split(':');
    return parts[0] + ':' + parts.slice(1).map(() => '••••').join(':') + cidr;
  }
  // IPv4
  const parts = ip.split('.');
  return parts[0] + '.' + parts.slice(1).map(p => '•'.repeat(p.length)).join('.') + cidr;
}

/**
 * Mask a username.
 * "admin"  → "a••••"
 * "root"   → "r•••"
 */
export function anonUsername(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;
  if (value.length <= 1) return '•';
  return value[0] + '•'.repeat(Math.min(value.length - 1, 6));
}

/**
 * Mask a file path.
 * "/var/log/auth.log" → "/•••/•••/••••.•••"
 */
export function anonPath(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;
  // Keep slashes/backslashes, mask segments
  return value.replace(/[^/\\]+/g, seg => '•'.repeat(Math.min(seg.length, 6)));
}

/**
 * Mask raw log lines.
 */
export function anonLog(value: string | null | undefined): string {
  if (!value) return '—';
  if (!isAnonymous()) return value;
  return '••• [anonymized log] •••';
}
