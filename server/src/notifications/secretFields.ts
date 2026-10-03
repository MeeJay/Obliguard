import { encryptSecret, decryptSecret } from '../utils/crypto';
import { getPlugin } from './registry';
import { logger } from '../utils/logger';

/**
 * Secrets at rest (W12-5): SMTP server passwords and the credential fields of
 * notification channel configs are stored as SECRET_ENVELOPE_PREFIX +
 * encryptSecret() ("iv:tag:ciphertext", AES-256-GCM, utils/crypto.ts). No
 * migration: a value without the prefix is a legacy plaintext secret, still
 * accepted on read and sealed on the next write (or by the one-shot
 * re-encryption of each service). Same envelope as the TOTP secrets.
 */
export const SECRET_ENVELOPE_PREFIX = 'enc:v1:';

/**
 * Config keys holding a credential, per plugin type: bot tokens, API keys,
 * passwords, and webhook URLs (the token is part of the URL). The ntfy topic
 * is the read/write capability on a public server, so it is sealed as well.
 * Fields a plugin declares as `password` are added by secretFieldsFor().
 */
export const PLUGIN_SECRET_FIELDS: Readonly<Record<string, readonly string[]>> = {
  webhook: ['url', 'secret'],
  discord: ['webhookUrl'],
  slack: ['webhookUrl'],
  teams: ['webhookUrl'],
  telegram: ['botToken'],
  gotify: ['appToken'],
  ntfy: ['topic', 'token'],
  pushover: ['userKey', 'appToken'],
  freemobile: ['apiKey'],
  // Legacy inline SMTP channels (before smtpServerId) carried the password.
  smtp: ['password'],
};

/** Secret config keys of a plugin type: the static list plus its password fields. */
export function secretFieldsFor(type: string): string[] {
  const keys = new Set(PLUGIN_SECRET_FIELDS[type] ?? []);
  for (const f of getPlugin(type)?.configFields ?? []) {
    if (f.type === 'password') keys.add(f.key);
  }
  return [...keys];
}

/** True when the value is already in the encrypted envelope. */
export function isSealedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_ENVELOPE_PREFIX);
}

/**
 * Envelope of a plaintext secret. A sealed value, and the empty string (no
 * secret; its envelope would not decrypt), are returned unchanged.
 */
export function sealSecret(value: string): string {
  if (value === '' || isSealedSecret(value)) return value;
  return SECRET_ENVELOPE_PREFIX + encryptSecret(value);
}

/**
 * The plaintext behind a stored value: decrypted from the envelope, or the
 * legacy plaintext as is. Throws when no configured key can decrypt it.
 */
export function openSecret(stored: string): string {
  if (!isSealedSecret(stored)) return stored;
  return decryptSecret(stored.slice(SECRET_ENVELOPE_PREFIX.length));
}

/** A legacy plaintext secret, worth sealing: a non-empty string not in the envelope. */
export function isPlaintextSecret(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !isSealedSecret(value);
}

/** True when a channel config still holds a plaintext secret. */
export function configHasPlaintextSecrets(type: string, config: Record<string, unknown>): boolean {
  return secretFieldsFor(type).some((k) => isPlaintextSecret(config[k]));
}

/** Copy of a channel config with every plaintext secret field sealed. */
export function sealChannelConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const k of secretFieldsFor(type)) {
    if (isPlaintextSecret(out[k])) out[k] = sealSecret(out[k] as string);
  }
  return out;
}

/**
 * Copy of a channel config with its secret fields decrypted. A field no key
 * can decrypt keeps its envelope (logged): an owner who saves the form keeps
 * the stored value, and delivery refuses it (unreadableSecretFields).
 */
export function openChannelConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const k of secretFieldsFor(type)) {
    const v = out[k];
    if (!isSealedSecret(v)) continue;
    try {
      out[k] = openSecret(v);
    } catch (err) {
      logger.error({ err, type, field: k }, 'Notification secret cannot be decrypted (CREDENTIAL_ENCRYPTION_KEY / SESSION_SECRET changed?)');
    }
  }
  return out;
}

/** Secret fields of an opened config that are still sealed (decryption failed). */
export function unreadableSecretFields(type: string, config: Record<string, unknown>): string[] {
  return secretFieldsFor(type).filter((k) => isSealedSecret(config[k]));
}
