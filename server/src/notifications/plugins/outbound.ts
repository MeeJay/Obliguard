import { assertPublicHttpUrl, SsrfRefusedError } from '../../utils/ssrfGuard';

// Outbound guard of the notification plugins (B11, decision 18). A channel
// creator chooses the URL a plugin posts to, and "test" fires it on demand:
// without a guard a channel is a probe into the server's network.
//
//   - Webhook: public targets only (assertPublicHttpUrl).
//   - Gotify / ntfy: often self-hosted on the LAN, so private targets are
//     allowed by default.
//   - Discord / Slack / Teams: https to their official hosts only.
//
// NOTIFICATION_ALLOW_PRIVATE_TARGETS flips the private-target rule for every
// user-URL plugin (webhook, gotify, ntfy): 'true'/'1' allows private targets
// everywhere, 'false'/'0' refuses them everywhere, unset keeps the defaults
// above. It never relaxes the host pinning of Discord / Slack / Teams.
//
// Every guarded fetch uses redirect: 'manual' (a 3xx is an error), so a
// public URL cannot bounce the request onto an internal target.

export { SsrfRefusedError };

/** Tri-state NOTIFICATION_ALLOW_PRIVATE_TARGETS: true / false / null (unset = per-plugin default). */
export function privateTargetsOverride(): boolean | null {
  const raw = (process.env.NOTIFICATION_ALLOW_PRIVATE_TARGETS ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return null;
}

function parseHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfRefusedError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfRefusedError(`Refused non-HTTP scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new SsrfRefusedError('Refused URL with embedded credentials');
  }
  return url;
}

/**
 * Check a user-supplied target URL right before the fetch. `privateByDefault`
 * is the plugin's default (true for gotify/ntfy, false for webhook);
 * NOTIFICATION_ALLOW_PRIVATE_TARGETS overrides it. A hostname that does not
 * resolve is let through (the fetch then fails to resolve as well).
 */
export async function assertNotificationTarget(rawUrl: string, opts: { privateByDefault: boolean }): Promise<URL> {
  const allowPrivate = privateTargetsOverride() ?? opts.privateByDefault;
  if (allowPrivate) return parseHttpUrl(rawUrl);
  return assertPublicHttpUrl(rawUrl, { allowUnresolved: true });
}

export interface PinnedHosts {
  /** Exact host names. */
  exact?: readonly string[];
  /** Parent domains: any sub-domain matches (the bare domain does not). */
  suffixes?: readonly string[];
}

/**
 * The URL must be https, on the default port, without credentials, and its
 * host must be one of the service's official hosts.
 */
export function assertPinnedHost(rawUrl: string, hosts: PinnedHosts, service: string): URL {
  const url = parseHttpUrl(rawUrl);
  if (url.protocol !== 'https:') throw new SsrfRefusedError(`${service} webhook URL must use https`);
  if (url.port !== '' && url.port !== '443') throw new SsrfRefusedError(`${service} webhook URL must use the default port`);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const ok = (hosts.exact ?? []).includes(host)
    || (hosts.suffixes ?? []).some((s) => host.endsWith(`.${s}`));
  if (!ok) throw new SsrfRefusedError(`${service} webhook URL must point to an official ${service} host (got ${host})`);
  return url;
}

export const DISCORD_HOSTS: PinnedHosts = {
  exact: ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'],
};
export const SLACK_HOSTS: PinnedHosts = { exact: ['hooks.slack.com'] };
// Teams: legacy O365 connectors (<tenant>.webhook.office.com) and Power
// Automate "Workflows" webhooks (Logic Apps and the Power Platform endpoints).
export const TEAMS_HOSTS: PinnedHosts = {
  suffixes: ['webhook.office.com', 'logic.azure.com', 'api.powerplatform.com'],
};

/**
 * fetch() for a guarded target: never follows a redirect (a 3xx response is
 * an error) and times out after 10 s by default.
 */
export async function guardedFetch(url: URL | string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    redirect: 'manual',
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
  });
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    throw new SsrfRefusedError(`Refused redirect (HTTP ${res.status}) from the notification target`);
  }
  return res;
}
