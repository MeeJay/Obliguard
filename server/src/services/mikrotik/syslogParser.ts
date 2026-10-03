/**
 * MikroTik syslog message parser.
 *
 * MikroTik RouterOS sends syslog messages in several formats. The ones we care about:
 *
 * 1. Login failures (auth):
 *    "login failure for user admin from 10.0.0.5 via winbox"
 *    "login failure for user admin from 10.0.0.5 via ssh"
 *    "login failure for user admin from 10.0.0.5 via web"
 *    "login failure for user admin from 10.0.0.5 via api"
 *
 * 2. Denied connections (firewall service filter):
 *    "denied winbox/dude connect from 198.51.100.121"
 *    "denied ssh connect from 10.0.0.5"
 *    "denied web connect from 10.0.0.5"
 *    "denied ftp connect from 10.0.0.5"
 *    "denied telnet connect from 10.0.0.5"
 *
 * 3. Login successes:
 *    "user admin logged in from 10.0.0.5 via winbox"
 *    "user admin logged in from 10.0.0.5 via ssh"
 *    "user admin logged in from 10.0.0.5 via web"
 *
 * The syslog line arrives with an optional RFC3164 priority prefix: <NNN>
 * followed by a timestamp and hostname, then the message. The API log poller
 * passes the bare message.
 *
 * Log injection: the user name of a failed login is chosen by the remote
 * party and may contain spaces or a fake "from 198.51.100.66 via ssh". The address
 * is therefore bound to the LAST "from <ip> via <method>" trailer, anchored to
 * the end of the message (RouterOS writes nothing after it); a user name that
 * carries its own " from " is dropped (no such account exists, the attempt
 * cannot succeed); the event must start the message, after at most two
 * header tokens, so a message quoting client text (DHCP host names, hotspot
 * users...) cannot pass for an auth event; and the address must be a literal
 * IP. These are the same rules as the agent's log parsers (agent/logwatcher.go).
 */
import net from 'node:net';

export interface MikroTikSyslogEvent {
  ip: string;
  username: string;
  service: string; // mikrotik_ssh, mikrotik_winbox, mikrotik_web, etc.
  eventType: 'auth_failure' | 'auth_success';
  rawLog: string;
}

// ── Login failure ────────────────────────────────────────────────────────────
// "login failure for user admin from 10.0.0.5 via winbox"
// Greedy user capture + end anchor: the address is the last trailer.
const loginFailureRe = /^login failure for user (.*) from (\S+) via ([\w-]+)$/i;

// ── Denied connection ────────────────────────────────────────────────────────
// "denied winbox/dude connect from 198.51.100.121"
// "denied ssh connect from 10.0.0.5"
const deniedConnectRe = /^denied (\S+?)(?:\/\S+)? connect from (\S+)$/i;

// ── Login success ────────────────────────────────────────────────────────────
// "user admin logged in from 10.0.0.5 via winbox"
const loginSuccessRe = /^user (.*) logged in from (\S+) via ([\w-]+)$/i;

// ── Syslog header ────────────────────────────────────────────────────────────
// Optional timestamps before the hostname / topics:
//   RFC3164 "Jan 15 10:20:30 ", RFC3339 "2024-01-15T10:20:30.000+01:00 ",
//   RouterOS "2024-01-15 10:20:30 " / "jan/15/2024 10:20:30 ".
const timestampRe = new RegExp(
  '^(?:' +
    '[A-Z][a-z]{2} {1,2}\\d{1,2} \\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?' +
    '|\\d{4}-\\d\\d-\\d\\d[T ]\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?(?:Z|[+-]\\d\\d:?\\d\\d)?' +
    '|[a-z]{3}\\/\\d\\d\\/\\d{4} \\d\\d:\\d\\d:\\d\\d' +
  ') +',
  'i',
);

/** Header tokens (hostname, topics such as "system,error,critical") skipped before the message. */
const MAX_HEADER_TOKENS = 2;
const headerTokenRe = /^[\w.:,\-[\]]+$/;

/** Map MikroTik service/method names to Obliguard service types. */
function mapService(method: string): string {
  const m = method.toLowerCase();
  if (m === 'ssh' || m === 'telnet') return 'mikrotik_ssh';
  if (m === 'winbox' || m.startsWith('winbox')) return 'mikrotik_winbox';
  if (m === 'web' || m === 'webfig' || m === 'www' || m === 'www-ssl') return 'mikrotik_web';
  if (m === 'api' || m === 'api-ssl') return 'mikrotik_api';
  if (m === 'ftp') return 'mikrotik_ftp';
  // Default: use the raw method prefixed
  return `mikrotik_${m}`;
}

/**
 * Canonical literal IP address, or null (host names, "-", CIDR...). An
 * IPv4-mapped IPv6 address is folded to plain IPv4, IPv6 is lower-cased.
 */
export function cleanSyslogIp(raw: string): string | null {
  let s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) s = mapped[1];
  const family = net.isIP(s);
  if (family === 4) return s;
  if (family === 6) return s.toLowerCase();
  return null;
}

/** The username carries its own "from <ip>" trailer: an injection attempt. */
function hasInjectedFrom(username: string): boolean {
  return / from[\s:]/i.test(username);
}

/**
 * Match one message (header already removed) against the known events.
 * false = a known event that is refused (invalid address, injected user name).
 */
function matchMessage(msg: string, raw: string): MikroTikSyslogEvent | false | null {
  // Login failure
  const failMatch = loginFailureRe.exec(msg);
  if (failMatch) {
    const ip = cleanSyslogIp(failMatch[2]);
    if (!ip || hasInjectedFrom(failMatch[1])) return false;
    return {
      ip,
      username: failMatch[1],
      service: mapService(failMatch[3]),
      eventType: 'auth_failure',
      rawLog: raw,
    };
  }

  // Denied connection (service-level block)
  const denyMatch = deniedConnectRe.exec(msg);
  if (denyMatch) {
    const ip = cleanSyslogIp(denyMatch[2]);
    if (!ip) return false;
    return {
      ip,
      username: '',
      service: mapService(denyMatch[1]),
      eventType: 'auth_failure',
      rawLog: raw,
    };
  }

  // Login success
  const successMatch = loginSuccessRe.exec(msg);
  if (successMatch) {
    const ip = cleanSyslogIp(successMatch[2]);
    if (!ip || hasInjectedFrom(successMatch[1])) return false;
    return {
      ip,
      username: successMatch[1],
      service: mapService(successMatch[3]),
      eventType: 'auth_success',
      rawLog: raw,
    };
  }

  return null;
}

/**
 * Parse a raw MikroTik syslog line into a structured event.
 * Returns null if the line is not a recognized auth/deny event.
 */
export function parseMikroTikSyslog(raw: string): MikroTikSyslogEvent | null {
  // Strip syslog priority prefix <NNN> if present
  let line = raw.trim();
  if (line.startsWith('<')) {
    const end = line.indexOf('>');
    if (end > 0 && end < 6) {
      line = line.slice(end + 1);
    }
  }
  line = line.trimStart().replace(timestampRe, '');

  // The event must start the message: try the line itself, then after each
  // of the first header tokens (hostname, topics). Client text deeper in a
  // message never gets there.
  let rest = line;
  for (let skipped = 0; ; skipped++) {
    const ev = matchMessage(rest, raw);
    if (ev !== null) return ev || null; // refused: never retry deeper in the message
    if (skipped >= MAX_HEADER_TOKENS) return null;
    const sp = rest.indexOf(' ');
    if (sp <= 0) return null;
    const token = rest.slice(0, sp);
    if (!headerTokenRe.test(token)) return null;
    rest = rest.slice(sp + 1).trimStart();
  }
}
