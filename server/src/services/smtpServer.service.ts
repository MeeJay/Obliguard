import { db } from '../db';
import nodemailer from 'nodemailer';
import type { SmtpServer } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';
import { codedError } from '../utils/errorCodes';
import { logger } from '../utils/logger';
import { SECRET_ENVELOPE_PREFIX, isPlaintextSecret, isSealedSecret, openSecret, sealSecret } from '../notifications/secretFields';

interface SmtpServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from_address: string;
  tenant_id: number | null;
  created_at: Date;
  updated_at: Date;
}

/** smtp_servers.password is a varchar(255): the sealed value must fit. */
const PASSWORD_COLUMN_LENGTH = 255;

function rowToServer(row: SmtpServerRow): SmtpServer {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    fromAddress: row.from_address,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The password as stored: encrypted at rest (notifications/secretFields).
 * 400 when the envelope would not fit the column (plaintext over ~95 bytes).
 */
function sealPassword(password: string): string {
  const sealed = sealSecret(password);
  if (sealed.length > PASSWORD_COLUMN_LENGTH) {
    throw codedError(400, 'SMTP_PASSWORD_TOO_LONG', 'SMTP password is too long to be stored encrypted');
  }
  return sealed;
}

/**
 * The row with its password decrypted (a legacy plaintext password is kept
 * as is). A password no key can decrypt keeps its envelope (logged); the
 * transport builders refuse it (assertReadable).
 */
function openRow(row: SmtpServerRow): SmtpServerRow {
  if (!isSealedSecret(row.password)) return row;
  try {
    return { ...row, password: openSecret(row.password) };
  } catch (err) {
    logger.error({ err, smtpServerId: row.id }, 'SMTP password cannot be decrypted (CREDENTIAL_ENCRYPTION_KEY / SESSION_SECRET changed?)');
    return row;
  }
}

function assertReadable(row: SmtpServerRow): void {
  if (isSealedSecret(row.password)) {
    throw new Error(`SMTP server #${row.id}: password cannot be decrypted (CREDENTIAL_ENCRYPTION_KEY / SESSION_SECRET changed?)`);
  }
}

// One-shot re-encryption of legacy plaintext passwords, started on the first
// access of the service, in the background (a failure is logged, never thrown;
// rows left plaintext are sealed on their next write).
let reencryption: Promise<number> | null = null;

function startReencryption(): void {
  if (reencryption) return;
  reencryption = smtpServerService.reencryptSecrets().catch((err) => {
    logger.warn({ err }, 'SMTP password re-encryption failed');
    return 0;
  });
}

export const smtpServerService = {
  async list(tenantId?: number): Promise<SmtpServer[]> {
    startReencryption();
    const query = db<SmtpServerRow>('smtp_servers').orderBy('name');
    if (tenantId !== undefined && isMasterTenant(tenantId)) {
      // Legacy rows without a tenant belong to the Default tenant.
      query.where(function () { this.where({ tenant_id: tenantId }).orWhereNull('tenant_id'); });
    } else if (tenantId !== undefined) {
      query.where({ tenant_id: tenantId });
    } else {
      query.whereNull('tenant_id');
    }
    const rows = await query;
    return rows.map(rowToServer);
  },

  /** The row with its password decrypted (callers build transports from it). */
  async getById(id: number): Promise<SmtpServerRow | null> {
    startReencryption();
    const row = await db<SmtpServerRow>('smtp_servers').where({ id }).first();
    return row ? openRow(row) : null;
  },

  /**
   * The server row when `tenantId` may manage it, else null (callers answer
   * 404 so foreign ids do not leak). The Default tenant owns every server,
   * including legacy rows without a tenant.
   */
  async getOwned(id: number, tenantId: number): Promise<SmtpServerRow | null> {
    if (!Number.isInteger(id) || id <= 0) return null;
    const row = await this.getById(id);
    if (!row) return null;
    if (isMasterTenant(tenantId) || row.tenant_id === tenantId) return row;
    return null;
  },

  async create(data: {
    name: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromAddress: string;
    tenantId?: number;
  }): Promise<SmtpServer> {
    startReencryption();
    const [row] = await db<SmtpServerRow>('smtp_servers')
      .insert({
        name: data.name,
        host: data.host,
        port: data.port,
        secure: data.secure,
        username: data.username,
        password: sealPassword(data.password),
        from_address: data.fromAddress,
        tenant_id: data.tenantId ?? null,
      })
      .returning('*');
    return rowToServer(row);
  },

  async update(id: number, data: Partial<{
    name: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromAddress: string;
  }>): Promise<SmtpServer | null> {
    startReencryption();
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.host !== undefined) update.host = data.host;
    if (data.port !== undefined) update.port = data.port;
    if (data.secure !== undefined) update.secure = data.secure;
    if (data.username !== undefined) update.username = data.username;
    if (data.password !== undefined) {
      update.password = sealPassword(data.password);
    } else {
      // Any write also seals a legacy plaintext password left in place.
      const current = await db<SmtpServerRow>('smtp_servers').where({ id }).first('password');
      if (current && isPlaintextSecret(current.password)) {
        const sealed = sealSecret(current.password);
        if (sealed.length <= PASSWORD_COLUMN_LENGTH) update.password = sealed;
      }
    }
    if (data.fromAddress !== undefined) update.from_address = data.fromAddress;

    const [row] = await db<SmtpServerRow>('smtp_servers').where({ id }).update(update).returning('*');
    return row ? rowToServer(row) : null;
  },

  async delete(id: number): Promise<boolean> {
    const count = await db('smtp_servers').where({ id }).del();
    return count > 0;
  },

  async test(id: number): Promise<void> {
    const row = await this.getById(id);
    if (!row) throw new Error('SMTP server not found');
    assertReadable(row);

    const transport = nodemailer.createTransport({
      host: row.host,
      port: row.port,
      secure: row.secure,
      auth: { user: row.username, pass: row.password },
    });

    await transport.verify();
  },

  /** Build a nodemailer transport config from a server row (password decrypted). */
  async getTransportConfig(id: number): Promise<{ host: string; port: number; secure: boolean; username: string; password: string; fromAddress: string } | null> {
    const row = await this.getById(id);
    if (!row) return null;
    assertReadable(row);
    return {
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      password: row.password,
      fromAddress: row.from_address,
    };
  },

  /**
   * Seals every legacy plaintext password. Idempotent: sealed rows are
   * skipped. Each row is re-read under a row lock, so a concurrent update is
   * never overwritten; updated_at is left alone (not a user change). Returns
   * the number of rows sealed.
   */
  async reencryptSecrets(): Promise<number> {
    const candidates = await db<SmtpServerRow>('smtp_servers')
      .whereNot('password', 'like', `${SECRET_ENVELOPE_PREFIX}%`)
      .whereNot('password', '')
      .select('id');
    let sealed = 0;
    for (const { id } of candidates) {
      await db.transaction(async (trx) => {
        const row = await trx<SmtpServerRow>('smtp_servers').where({ id }).forUpdate().first('id', 'password');
        if (!row || !isPlaintextSecret(row.password)) return;
        const value = sealSecret(row.password);
        if (value.length > PASSWORD_COLUMN_LENGTH) {
          logger.warn({ smtpServerId: id }, 'SMTP password too long to be stored encrypted, left as is');
          return;
        }
        await trx('smtp_servers').where({ id }).update({ password: value });
        sealed++;
      });
    }
    if (sealed > 0) logger.info({ count: sealed }, 'SMTP passwords encrypted at rest');
    return sealed;
  },
};
