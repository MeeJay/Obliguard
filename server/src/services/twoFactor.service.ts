import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import nodemailer from 'nodemailer';
import { smtpServerService } from './smtpServer.service';
import { config } from '../config';
import { logger } from '../utils/logger';

export const twoFactorService = {
  // ── TOTP ──────────────────────────────────────────────────────────────────

  generateTotpSecret(username: string): { secret: string; uri: string } {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: config.appName,
      label: username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
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

  verifyTotp(secret: string, code: string): boolean {
    try {
      const totp = new OTPAuth.TOTP({
        issuer: config.appName,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret.trim()),
      });
      // Use a wide window (10 = ±5 minutes) purely for diagnostics —
      // we still only ACCEPT within ±2 windows (±60 s) for security.
      const serverCounter = Math.floor(Date.now() / 1000 / 30);
      const delta = totp.validate({ token: code.trim(), window: 10 });

      if (delta === null) {
        // Code doesn't match ANY window in ±5 min — completely wrong code or corrupted secret
        logger.warn(
          { serverCounter, serverTime: new Date().toISOString() },
          '[2FA] TOTP completely invalid — no match in ±10 windows (±5 min). Wrong code or bad secret.',
        );
        return false;
      }

      // Code IS correct for some time window — log how many steps off we are
      const driftSeconds = delta * 30;
      if (Math.abs(delta) <= 2) {
        logger.info({ delta, driftSeconds, serverCounter }, '[2FA] TOTP valid (within ±60 s tolerance)');
        return true;
      } else {
        // Valid code but clock is too far off — log it so we can fix the root cause
        logger.warn(
          { delta, driftSeconds, serverCounter, serverTime: new Date().toISOString() },
          `[2FA] TOTP clock drift too large: ${driftSeconds}s off. Increase NTP sync on server or phone.`,
        );
        return false;
      }
    } catch (err) {
      logger.warn({ err }, '[2FA] TOTP verification threw an exception (secret may be malformed)');
      return false;
    }
  },

  // ── Email OTP ──────────────────────────────────────────────────────────────

  generateEmailOtp(): string {
    return String(Math.floor(100000 + Math.random() * 900000));
  },

  async sendEmailOtp(smtpServerId: number, toEmail: string, code: string): Promise<void> {
    const server = await smtpServerService.getById(smtpServerId);
    if (!server) throw new Error('SMTP server not configured for OTP');

    const transport = nodemailer.createTransport({
      host: server.host,
      port: server.port,
      secure: server.secure,
      auth: { user: server.username, pass: server.password },
    });

    await transport.sendMail({
      from: server.from_address,
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
};
