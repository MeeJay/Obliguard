import bcrypt from 'bcrypt';
import crypto from 'crypto';

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

// ── AES-256-GCM symmetric encryption (for stored credentials) ───────────────
//
// Key: sha256(CREDENTIAL_ENCRYPTION_KEY) when that variable is set, otherwise
// sha256(SESSION_SECRET) (the historical key). Decryption tries the current
// key, then sha256(SESSION_SECRET), then sha256(PREVIOUS_SESSION_SECRET): a
// value stays readable after CREDENTIAL_ENCRYPTION_KEY is introduced or the
// session secret is rotated, and is re-encrypted with the current key on its
// next write (no migration). The GCM tag rejects a wrong key, so the
// ciphertext format ("iv:tag:ciphertext") does not need a key id.

interface CryptoKeyConfig {
  sessionSecret: string;
  credentialEncryptionKey?: string;
  previousSessionSecret?: string;
}

function keyConfig(): CryptoKeyConfig {
  // Lazy: config pulls in env, keep this module import-light.
  const { config } = require('../config') as { config: CryptoKeyConfig };
  return config;
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

/** Key used for new ciphertexts. */
function encryptionKey(): Buffer {
  const c = keyConfig();
  return sha256(c.credentialEncryptionKey || c.sessionSecret);
}

/** Keys accepted for decryption, current first, without duplicates. */
function decryptionKeys(): Buffer[] {
  const c = keyConfig();
  const secrets = [c.credentialEncryptionKey, c.sessionSecret, c.previousSessionSecret]
    .filter((s): s is string => !!s);
  return [...new Set(secrets)].map(sha256);
}

/** Encrypt plaintext with AES-256-GCM. Returns "iv:tag:ciphertext" (hex). */
export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptWithKey(key: Buffer, iv: Buffer, tag: Buffer, enc: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
}

/**
 * Decrypt a string produced by encryptSecret, with the current key or one of
 * the fallback keys (see above). Throws when no key authenticates it.
 */
export function decryptSecret(encrypted: string): string {
  const [ivHex, tagHex, encHex] = encrypted.split(':');
  if (!ivHex || !tagHex || !encHex) throw new Error('Invalid encrypted format');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  let lastError: unknown = new Error('No decryption key configured');
  for (const key of decryptionKeys()) {
    try {
      return decryptWithKey(key, iv, tag, enc);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
