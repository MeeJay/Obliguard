import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import nodemailer from 'nodemailer';
import { db } from '../db';
import { smtpServerService } from './smtpServer.service';
import { config } from '../config';
import { logger } from '../utils/logger';
import { encryptSecret, decryptSecret } from '../utils/crypto';

/** TOTP period (s) and accepted drift, in steps (±1 step = ±30 s). */
export const TOTP_PERIOD_S = 30;
export const TOTP_WINDOW = 1;

/**
 * Envelope of a TOTP secret encrypted at rest: "enc:v1:" + encryptSecret()
 * ("iv:tag:ciphertext", AES-256-GCM). A base32 secret never contains ':', so
 * a value without the prefix is a legacy plaintext secret: still accepted on
 * read, sealed again on the next write (enable, or the next sign-in).
 */
export const TOTP_SECRET_PREFIX = 'enc:v1:';

/** E-mail codes: lifetime, and wrong attempts before the pending code is dropped. */
export const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
export const EMAIL_OTP_MAX_ATTEMPTS = 5;

/** A pending e-mail code as kept in the session: only its SHA-256, never the code. */
export interface PendingEmailOtp {
  codeHash: string;
  email: string;
  expires: number;
  /** Wrong codes typed against this pending code. */
  attempts?: number;
}

function hashEmailOtp(code: string): string {
  return crypto.createHash('sha256').update(String(code ?? '').trim()).digest('hex');
}

function buildTotp(secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: config.appName,
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD_S,
    secret: OTPAuth.Secret.fromBase32(secret.trim()),
  });
}

export const twoFactorService = {
  // ── TOTP ──────────────────────────────────────────────────────────────────

  generateTotpSecret(username: string): { secret: string; uri: string } {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: config.appName,
      label: username,
      algorithm: 'SHA1',
      digits: 6,
      period: TOTP_PERIOD_S,
      secret,
    });
    return {
      secret: secret.base32,
      uri: totp.toString(),
    };
  },

  async generateTotpQr(uri: string): Promise<string> {
    return QRCode.toDataURL(uri);
  },

  /**
   * Verifies a TOTP code and returns the ABSOLUTE time step it matched
   * (floor(unix / 30) + drift), or null. The step feeds the anti-replay guard
   * (acceptTotpStep): a caller that only checks `!== null` accepts a replayed
   * code. Window ±1 step (±30 s).
   */
  verifyTotpStep(secret: string, code: string, window: number = TOTP_WINDOW, nowMs: number = Date.now()): number | null {
    const token = String(code ?? '').trim();
    if (!/^\d{6}$/.test(token)) return null;
    try {
      const delta = buildTotp(secret).validate({ token, timestamp: nowMs, window });
      if (delta === null) return null;
      return Math.floor(nowMs / 1000 / TOTP_PERIOD_S) + delta;
    } catch (err) {
      logger.warn({ err }, 'TOTP verification threw an exception (secret may be malformed)');
      return null;
    }
  },

  /**
   * Claims a TOTP step for a user (anti-replay): one atomic UPDATE that only
   * succeeds when the step is newer than the last accepted one. false = the
   * code (or an older one) was already used, it must be refused.
   */
  async acceptTotpStep(userId: number, step: number): Promise<boolean> {
    if (!Number.isSafeInteger(step) || step <= 0) return false;
    const updated = await db('users')
      .where({ id: userId })
      .where((q) => q.whereNull('totp_last_step').orWhere('totp_last_step', '<', step))
      .update({ totp_last_step: step });
    return updated > 0;
  },

  // ── TOTP secret at rest ───────────────────────────────────────────────────

  /** Encrypts a base32 TOTP secret for storage in users.totp_secret. */
  sealTotpSecret(secret: string): string {
    return TOTP_SECRET_PREFIX + encryptSecret(secret.trim());
  },

  /** True when the stored value is already in the encrypted envelope. */
  isSealedTotpSecret(stored: string | null | undefined): boolean {
    return typeof stored === 'string' && stored.startsWith(TOTP_SECRET_PREFIX);
  },

  /**
   * The base32 secret behind a stored users.totp_secret: decrypted from the
   * envelope, or the legacy plaintext value as is. null when absent or when
   * no configured key can decrypt it (logged; the code is then refused).
   */
  openTotpSecret(stored: string | null | undefined): string | null {
    if (!stored) return null;
    if (!stored.startsWith(TOTP_SECRET_PREFIX)) return stored.trim() || null;
    try {
      return decryptSecret(stored.slice(TOTP_SECRET_PREFIX.length));
    } catch (err) {
      logger.error({ err }, 'TOTP secret cannot be decrypted (CREDENTIAL_ENCRYPTION_KEY / SESSION_SECRET changed?)');
      return null;
    }
  },

  // ── Email OTP ──────────────────────────────────────────────────────────────

  /** A 6-digit code from the CSPRNG. */
  generateEmailOtp(): string {
    return String(crypto.randomInt(100000, 1000000));
  },

  /**
   * A new e-mail code and its session record: the code goes out by e-mail,
   * the session only keeps its SHA-256 (a session-store dump does not reveal
   * a usable code).
   */
  newEmailOtp(email: string): { code: string; pending: PendingEmailOtp } {
    const code = this.generateEmailOtp();
    return { code, pending: { codeHash: hashEmailOtp(code), email, expires: Date.now() + EMAIL_OTP_TTL_MS, attempts: 0 } };
  },

  /**
   * Checks a typed code against a pending e-mail code (constant-time compare
   * of the hashes). Expired or malformed pending records never match. The
   * caller counts wrong attempts (EMAIL_OTP_MAX_ATTEMPTS).
   */
  emailOtpMatches(pending: PendingEmailOtp | undefined, code: unknown): boolean {
    if (!pending || typeof pending.codeHash !== 'string' || Date.now() > pending.expires) return false;
    const typed = String(code ?? '').trim();
    if (!/^\d{6}$/.test(typed)) return false;
    const a = Buffer.from(hashEmailOtp(typed), 'hex');
    const b = Buffer.from(pending.codeHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  async sendEmailOtp(smtpServerId: number, toEmail: string, code: string): Promise<void> {
    // getTransportConfig() decrypts the password and throws a clear error when
    // it cannot be decrypted (never an SMTP login with the ciphertext).
    const server = await smtpServerService.getTransportConfig(smtpServerId);
    if (!server) throw new Error('SMTP server not configured for OTP');

    const transport = nodemailer.createTransport({
      host: server.host,
      port: server.port,
      secure: server.secure,
      auth: { user: server.username, pass: server.password },
    });

    await transport.sendMail({
      from: server.fromAddress,
      to: toEmail,
      subject: `${config.appName} — Your login code`,
      text: `Your login verification code is: ${code}\n\nThis code expires in 10 minutes.`,
      html: `
        <h2>${config.appName} — Login verification</h2>
        <p>Your verification code is:</p>
        <h1 style="letter-spacing:8px;font-family:monospace">${code}</h1>
        <p style="color:#888;font-size:12px">This code expires in 10 minutes. If you did not request this, ignore this email.</p>
      `,
    });

    logger.info(`Email OTP sent to ${toEmail}`);
  },

  /** Security notice (second factor added / removed / replaced). English,
   *  like the OTP mails; static text only (no code, secret or address). */
  async sendSecurityNotice(smtpServerId: number, toEmail: string, subject: string, lines: string[]): Promise<void> {
    // getTransportConfig() decrypts the password and throws a clear error when
    // it cannot be decrypted (never an SMTP login with the ciphertext).
    const server = await smtpServerService.getTransportConfig(smtpServerId);
    if (!server) throw new Error('SMTP server not configured for OTP');
    const transport = nodemailer.createTransport({
      host: server.host,
      port: server.port,
      secure: server.secure,
      auth: { user: server.username, pass: server.password },
    });
    const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    await transport.sendMail({
      from: server.fromAddress,
      to: toEmail,
      subject: `${config.appName} — ${subject}`,
      text: lines.join('\n\n'),
      html: `<h2>${esc(config.appName)} — ${esc(subject)}</h2>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}`,
    });
    logger.info({ subject }, 'Security notice sent');
  },
};
