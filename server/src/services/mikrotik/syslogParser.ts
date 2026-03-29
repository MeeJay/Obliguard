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
 *    "denied winbox/dude connect from 3.131.220.121"
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
 * followed by a timestamp and hostname, then the message.
 */

export interface MikroTikSyslogEvent {
  ip: string;
  username: string;
  service: string; // mikrotik_ssh, mikrotik_winbox, mikrotik_web, etc.
  eventType: 'auth_failure' | 'auth_success';
  rawLog: string;
}

// ── Login failure ────────────────────────────────────────────────────────────
// "login failure for user admin from 10.0.0.5 via winbox"
const loginFailureRe = /login failure for user (\S+) from ([\d.]+|[0-9a-f:]+) via (\w+)/i;

// ── Denied connection ────────────────────────────────────────────────────────
// "denied winbox/dude connect from 3.131.220.121"
// "denied ssh connect from 10.0.0.5"
const deniedConnectRe = /denied (\S+?)(?:\/\S+)? connect from ([\d.]+|[0-9a-f:]+)/i;

// ── Login success ────────────────────────────────────────────────────────────
// "user admin logged in from 10.0.0.5 via winbox"
const loginSuccessRe = /user (\S+) logged in from ([\d.]+|[0-9a-f:]+) via (\w+)/i;

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
 * Parse a raw MikroTik syslog line into a structured event.
 * Returns null if the line is not a recognized auth/deny event.
 */
export function parseMikroTikSyslog(raw: string): MikroTikSyslogEvent | null {
  // Strip syslog priority prefix <NNN> if present
  let line = raw;
  if (line.startsWith('<')) {
    const end = line.indexOf('>');
    if (end > 0 && end < 6) {
      line = line.slice(end + 1);
    }
  }

  // Login failure
  const failMatch = loginFailureRe.exec(line);
  if (failMatch) {
    return {
      ip: failMatch[2],
      username: failMatch[1],
      service: mapService(failMatch[3]),
      eventType: 'auth_failure',
      rawLog: raw,
    };
  }

  // Denied connection (service-level block)
  const denyMatch = deniedConnectRe.exec(line);
  if (denyMatch) {
    return {
      ip: denyMatch[2],
      username: '',
      service: mapService(denyMatch[1]),
      eventType: 'auth_failure',
      rawLog: raw,
    };
  }

  // Login success
  const successMatch = loginSuccessRe.exec(line);
  if (successMatch) {
    return {
      ip: successMatch[2],
      username: successMatch[1],
      service: mapService(successMatch[3]),
      eventType: 'auth_success',
      rawLog: raw,
    };
  }

  return null;
}
