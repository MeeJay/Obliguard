import crypto from 'crypto';
import { exec } from 'child_process';
import http from 'http';
import net from 'net';
import { Client as SshClient } from 'ssh2';
import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import type {
  RemediationAction,
  RemediationBinding,
  ResolvedRemediationBinding,
  RemediationRun,
  RemediationActionType,
  RemediationTrigger,
  OverrideModeR,
  WebhookRemediationConfig,
  ScriptRemediationConfig,
  DockerRestartRemediationConfig,
  SshRemediationConfig,
  CreateRemediationActionRequest,
  UpdateRemediationActionRequest,
  AddRemediationBindingRequest,
} from '@obliview/shared';

// ─── DB row types ─────────────────────────────────────────────────────────────

interface ActionRow {
  id: number;
  name: string;
  type: string;
  config: unknown;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

interface BindingRow {
  id: number;
  action_id: number;
  scope: string;
  scope_id: number | null;
  override_mode: string;
  trigger_on: string;
  cooldown_seconds: number;
}

interface RunRow {
  id: number;
  action_id: number;
  monitor_id: number;
  triggered_by: string;
  status: string;
  output: string | null;
  error: string | null;
  duration_ms: number | null;
  triggered_at: Date;
  action_name?: string;
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function rowToAction(row: ActionRow): RemediationAction {
  const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
  // Never expose raw SSH credential — replace with masked sentinel
  if (row.type === 'ssh' && cfg && typeof cfg === 'object' && 'credentialEnc' in cfg && cfg.credentialEnc) {
    (cfg as Record<string, unknown>).credentialEnc = '[set]';
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type as RemediationActionType,
    config: cfg as RemediationAction['config'],
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToBinding(row: BindingRow): RemediationBinding {
  return {
    id: row.id,
    actionId: row.action_id,
    scope: row.scope as RemediationBinding['scope'],
    scopeId: row.scope_id,
    overrideMode: row.override_mode as OverrideModeR,
    triggerOn: row.trigger_on as RemediationTrigger,
    cooldownSeconds: row.cooldown_seconds,
  };
}

function rowToRun(row: RunRow): RemediationRun {
  return {
    id: row.id,
    actionId: row.action_id,
    monitorId: row.monitor_id,
    triggeredBy: row.triggered_by as 'down' | 'up',
    status: row.status as RemediationRun['status'],
    output: row.output,
    error: row.error,
    durationMs: row.duration_ms,
    triggeredAt: row.triggered_at.toISOString(),
    actionName: row.action_name,
  };
}

// ─── SSH Credential Encryption (AES-256-GCM) ─────────────────────────────────

const SSH_SALT = 'remediation-ssh';

function deriveKey(): Buffer {
  const secret = (process.env.ENCRYPTION_KEY ?? config.sessionSecret) as string;
  return crypto.scryptSync(secret, SSH_SALT, 32);
}

function encryptCredential(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptCredential(enc: string): string {
  const parts = enc.split(':');
  if (parts.length !== 3) throw new Error('Invalid credential format');
  const [ivB64, tagB64, ctB64] = parts;
  const key = deriveKey();
  const iv  = Buffer.from(ivB64,  'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct  = Buffer.from(ctB64,  'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString('utf8') + decipher.final('utf8');
}

// ─── Inheritance helper (mirrors notification.service) ───────────────────────

type BindingSet = Map<number, RemediationBinding>; // actionId → binding

function applyBindings(current: BindingSet, bindings: RemediationBinding[]): BindingSet {
  if (bindings.length === 0) return current;
  const next = new Map(current);

  const hasReplace = bindings.some(b => b.overrideMode === 'replace');
  if (hasReplace) next.clear();

  for (const b of bindings) {
    if (b.overrideMode !== 'exclude') next.set(b.actionId, b);
  }
  for (const b of bindings) {
    if (b.overrideMode === 'exclude') next.delete(b.actionId);
  }
  return next;
}

// ─── Run result ───────────────────────────────────────────────────────────────

interface RunResult {
  status: 'success' | 'failed' | 'timeout';
  output?: string;
  error?: string;
}

// ─── Main service ─────────────────────────────────────────────────────────────

export const remediationService = {

  // ── Action CRUD ─────────────────────────────────────────────────────────────

  async listActions(): Promise<RemediationAction[]> {
    const rows = await db<ActionRow>('remediation_actions').orderBy('name');
    return rows.map(rowToAction);
  },

  async getActionById(id: number): Promise<RemediationAction | null> {
    const row = await db<ActionRow>('remediation_actions').where({ id }).first();
    return row ? rowToAction(row) : null;
  },

  async createAction(data: CreateRemediationActionRequest): Promise<RemediationAction> {
    let cfg = { ...data.config };

    // Encrypt SSH credential on create
    if (data.type === 'ssh' && cfg.credential && typeof cfg.credential === 'string') {
      cfg = { ...cfg, credentialEnc: encryptCredential(cfg.credential), credential: undefined };
      delete cfg.credential;
    }

    const [row] = await db<ActionRow>('remediation_actions')
      .insert({
        name: data.name,
        type: data.type,
        config: JSON.stringify(cfg) as unknown as Record<string, unknown>,
        enabled: data.enabled ?? true,
      })
      .returning('*');
    return rowToAction(row);
  },

  async updateAction(id: number, data: UpdateRemediationActionRequest): Promise<RemediationAction | null> {
    const upd: Record<string, unknown> = { updated_at: new Date() };
    if (data.name    !== undefined) upd.name    = data.name;
    if (data.enabled !== undefined) upd.enabled = data.enabled;

    if (data.config !== undefined) {
      // Fetch existing to preserve credentialEnc when no new credential provided
      const existing = await db<ActionRow>('remediation_actions').where({ id }).first();
      if (!existing) return null;

      const existingCfg = typeof existing.config === 'string'
        ? JSON.parse(existing.config)
        : { ...(existing.config as Record<string, unknown>) };

      let newCfg = { ...existingCfg, ...data.config };

      if (existing.type === 'ssh') {
        const newCred = (data.config as Record<string, unknown>).credential;
        if (newCred && typeof newCred === 'string') {
          // New credential provided — encrypt and store
          newCfg = { ...newCfg, credentialEnc: encryptCredential(newCred) };
        }
        delete newCfg.credential; // never persist plaintext
      }
      upd.config = JSON.stringify(newCfg);
    }

    const [row] = await db<ActionRow>('remediation_actions')
      .where({ id })
      .update(upd)
      .returning('*');
    return row ? rowToAction(row) : null;
  },

  async deleteAction(id: number): Promise<void> {
    await db('remediation_actions').where({ id }).delete();
  },

  // ── Binding CRUD ─────────────────────────────────────────────────────────────

  async getBindings(scope: string, scopeId: number | null): Promise<RemediationBinding[]> {
    const query = db<BindingRow>('remediation_bindings').where({ scope });
    if (scopeId === null) {
      query.whereNull('scope_id');
    } else {
      query.where({ scope_id: scopeId });
    }
    const rows = await query;
    return rows.map(rowToBinding);
  },

  async addBinding(data: AddRemediationBindingRequest): Promise<RemediationBinding> {
    const [row] = await db<BindingRow>('remediation_bindings')
      .insert({
        action_id:       data.actionId,
        scope:           data.scope,
        scope_id:        data.scopeId ?? null,
        override_mode:   data.overrideMode   ?? 'merge',
        trigger_on:      data.triggerOn      ?? 'down',
        cooldown_seconds: data.cooldownSeconds ?? 300,
      })
      .returning('*');
    return rowToBinding(row);
  },

  async updateBinding(
    id: number,
    data: { overrideMode?: OverrideModeR; triggerOn?: RemediationTrigger; cooldownSeconds?: number },
  ): Promise<RemediationBinding | null> {
    const upd: Record<string, unknown> = {};
    if (data.overrideMode    !== undefined) upd.override_mode     = data.overrideMode;
    if (data.triggerOn       !== undefined) upd.trigger_on        = data.triggerOn;
    if (data.cooldownSeconds !== undefined) upd.cooldown_seconds  = data.cooldownSeconds;
    if (Object.keys(upd).length === 0) return this.getBindingById(id);
    const [row] = await db<BindingRow>('remediation_bindings').where({ id }).update(upd).returning('*');
    return row ? rowToBinding(row) : null;
  },

  async getBindingById(id: number): Promise<RemediationBinding | null> {
    const row = await db<BindingRow>('remediation_bindings').where({ id }).first();
    return row ? rowToBinding(row) : null;
  },

  async deleteBinding(id: number): Promise<void> {
    await db('remediation_bindings').where({ id }).delete();
  },

  // ── Resolution (walk global → group ancestors → monitor) ───────────────────

  async resolveBindingsForMonitor(
    monitorId: number,
    groupId: number | null,
  ): Promise<ResolvedRemediationBinding[]> {
    // 1. Global
    let set: BindingSet = new Map();
    const globalBindings = await this.getBindings('global', null);
    set = applyBindings(set, globalBindings);

    // 2. Group ancestors (root → nearest)
    if (groupId !== null) {
      type AncestorRow = { ancestor_id: number; depth: number };
      const ancestorRows = await db<AncestorRow>('group_closure')
        .where({ descendant_id: groupId })
        .orderBy('depth', 'desc');

      for (const row of ancestorRows) {
        const groupBindings = await this.getBindings('group', row.ancestor_id);
        set = applyBindings(set, groupBindings);
      }
    }

    // 3. Monitor
    const monitorBindings = await this.getBindings('monitor', monitorId);
    set = applyBindings(set, monitorBindings);

    if (set.size === 0) return [];

    // Fetch actions
    const actionIds = Array.from(set.keys());
    const actionRows = await db<ActionRow>('remediation_actions')
      .whereIn('id', actionIds)
      .where({ enabled: true });
    const actionsById = new Map(actionRows.map(r => [r.id, rowToAction(r)]));

    const result: ResolvedRemediationBinding[] = [];
    for (const [actionId, binding] of set) {
      const action = actionsById.get(actionId);
      if (!action) continue; // disabled or deleted
      result.push({ ...binding, action });
    }
    return result;
  },

  /** resolveBindingsWithSources — used by the UI to show inheritance info */
  async resolveBindingsWithSources(
    scope: 'group' | 'monitor',
    scopeId: number,
    groupId?: number | null,
  ): Promise<Array<ResolvedRemediationBinding & {
    source: 'global' | 'group' | 'monitor';
    sourceId: number | null;
    isDirect: boolean;
  }>> {
    interface SourceEntry {
      binding: RemediationBinding;
      source: 'global' | 'group' | 'monitor';
      sourceId: number | null;
      isDirect: boolean;
    }

    const result: Map<number, SourceEntry> = new Map();

    const applyWithSource = (
      bindings: RemediationBinding[],
      source: SourceEntry['source'],
      sourceId: number | null,
      isDirect: boolean,
    ) => {
      if (bindings.length === 0) return;
      const hasReplace = bindings.some(b => b.overrideMode === 'replace');
      if (hasReplace) result.clear();
      for (const b of bindings) {
        if (b.overrideMode !== 'exclude') {
          result.set(b.actionId, { binding: b, source, sourceId, isDirect });
        }
      }
      for (const b of bindings) {
        if (b.overrideMode === 'exclude') result.delete(b.actionId);
      }
    };

    const globalBindings = await this.getBindings('global', null);
    applyWithSource(globalBindings, 'global', null, scope === 'monitor' ? false : false);

    if (groupId != null) {
      type AncestorRow = { ancestor_id: number; depth: number };
      const ancestorRows = await db<AncestorRow>('group_closure')
        .where({ descendant_id: groupId })
        .orderBy('depth', 'desc');
      for (const row of ancestorRows) {
        const gBindings = await this.getBindings('group', row.ancestor_id);
        applyWithSource(gBindings, 'group', row.ancestor_id, false);
      }
    }

    if (scope === 'monitor') {
      const mBindings = await this.getBindings('monitor', scopeId);
      applyWithSource(mBindings, 'monitor', scopeId, true);
    } else {
      // scope === 'group' — direct bindings
      const mBindings = await this.getBindings('group', scopeId);
      applyWithSource(mBindings, 'group', scopeId, true);
    }

    if (result.size === 0) return [];

    const actionIds = Array.from(result.keys());
    const actionRows = await db<ActionRow>('remediation_actions').whereIn('id', actionIds);
    const actionsById = new Map(actionRows.map(r => [r.id, rowToAction(r)]));

    return Array.from(result.values()).map(({ binding, source, sourceId, isDirect }) => ({
      ...binding,
      action: actionsById.get(binding.actionId)!,
      source,
      sourceId,
      isDirect,
    })).filter(r => r.action != null);
  },

  // ── Run history ──────────────────────────────────────────────────────────────

  async getRunsForMonitor(monitorId: number, limit = 50): Promise<RemediationRun[]> {
    const rows = await db<RunRow & { action_name: string }>('remediation_runs as r')
      .join('remediation_actions as a', 'a.id', 'r.action_id')
      .where('r.monitor_id', monitorId)
      .select('r.*', 'a.name as action_name')
      .orderBy('r.triggered_at', 'desc')
      .limit(limit);
    return rows.map(rowToRun);
  },

  async getRunsForAction(actionId: number, limit = 50): Promise<RemediationRun[]> {
    const rows = await db<RunRow>('remediation_runs')
      .where({ action_id: actionId })
      .orderBy('triggered_at', 'desc')
      .limit(limit);
    return rows.map(rowToRun);
  },

  // ── Trigger ───────────────────────────────────────────────────────────────────

  async triggerForMonitor(
    monitorId: number,
    monitorName: string,
    monitorUrl: string | undefined,
    monitorType: string,
    groupId: number | null,
    oldStatus: string,
    newStatus: string,
  ): Promise<void> {
    const resolved = await this.resolveBindingsForMonitor(monitorId, groupId);
    if (resolved.length === 0) return;

    const trigger: 'down' | 'up' = (
      newStatus === 'down' || newStatus === 'ssl_expired' || newStatus === 'ssl_warning' || newStatus === 'alert'
    ) ? 'down' : 'up';

    const ctx: TriggerContext = {
      monitorId, monitorName, monitorUrl, monitorType,
      oldStatus, newStatus, trigger,
      timestamp: new Date().toISOString(),
    };

    for (const binding of resolved) {
      // Filter by trigger_on
      const matchesTrigger =
        binding.triggerOn === 'both' ||
        binding.triggerOn === trigger;
      if (!matchesTrigger) continue;

      // Check cooldown
      if (binding.cooldownSeconds > 0) {
        const recent = await db('remediation_runs')
          .where({ action_id: binding.actionId, monitor_id: monitorId })
          .where('triggered_at', '>', new Date(Date.now() - binding.cooldownSeconds * 1000))
          .whereNot({ status: 'cooldown_skip' })
          .first();
        if (recent) {
          await db('remediation_runs').insert({
            action_id: binding.actionId,
            monitor_id: monitorId,
            triggered_by: trigger,
            status: 'cooldown_skip',
            triggered_at: new Date(),
          });
          logger.debug(`Remediation action ${binding.actionId} skipped (cooldown) for monitor ${monitorId}`);
          continue;
        }
      }

      // Execute async (don't block handleStatusChange)
      this._executeAction(binding.action, ctx).catch(err => {
        logger.error(err, `Unhandled error in remediation action ${binding.actionId}`);
      });
    }
  },

  async _executeAction(action: RemediationAction, ctx: TriggerContext): Promise<void> {
    const start = Date.now();
    let result: RunResult;

    try {
      switch (action.type) {
        case 'webhook':
        case 'n8n':
          result = await this._execWebhook(action.config as WebhookRemediationConfig, ctx);
          break;
        case 'script':
          result = await this._execScript(action.config as ScriptRemediationConfig, ctx);
          break;
        case 'docker_restart':
          result = await this._execDockerRestart(action.config as DockerRestartRemediationConfig, ctx);
          break;
        case 'ssh':
          result = await this._execSsh(action.config as SshRemediationConfig, ctx);
          break;
        default:
          result = { status: 'failed', error: `Unknown action type: ${action.type}` };
      }
    } catch (err) {
      result = {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const durationMs = Date.now() - start;

    await db('remediation_runs').insert({
      action_id:    action.id,
      monitor_id:   ctx.monitorId,
      triggered_by: ctx.trigger,
      status:       result.status,
      output:       result.output ?? null,
      error:        result.error  ?? null,
      duration_ms:  durationMs,
      triggered_at: new Date(),
    });

    logger.info(
      `Remediation action "${action.name}" (id:${action.id}) → ${result.status} in ${durationMs}ms for monitor ${ctx.monitorId}`,
    );
  },

  // ── Executors ─────────────────────────────────────────────────────────────────

  async _execWebhook(cfg: WebhookRemediationConfig, ctx: TriggerContext): Promise<RunResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 10_000);

    const payload = {
      event: `monitor.${ctx.trigger}`,
      monitor: {
        id: ctx.monitorId,
        name: ctx.monitorName,
        url: ctx.monitorUrl,
        type: ctx.monitorType,
      },
      status: ctx.newStatus,
      previousStatus: ctx.oldStatus,
      triggeredAt: ctx.timestamp,
    };

    try {
      const res = await fetch(cfg.url, {
        method: cfg.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.headers ?? {}),
        },
        body: ['GET', 'HEAD'].includes(cfg.method ?? 'POST')
          ? undefined
          : JSON.stringify({ ...payload, ...(cfg.bodyExtra ?? {}) }),
        signal: controller.signal,
      });

      const text = await res.text().catch(() => '');
      if (!res.ok) {
        return { status: 'failed', output: text, error: `HTTP ${res.status} ${res.statusText}` };
      }
      return { status: 'success', output: text.slice(0, 2000) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort') || msg.includes('timeout')) {
        return { status: 'timeout', error: msg };
      }
      return { status: 'failed', error: msg };
    } finally {
      clearTimeout(timer);
    }
  },

  async _execScript(cfg: ScriptRemediationConfig, ctx: TriggerContext): Promise<RunResult> {
    return new Promise((resolve) => {
      const timeoutMs = cfg.timeoutMs ?? 30_000;
      const shell     = cfg.shell ?? '/bin/sh';

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MONITOR_ID:     String(ctx.monitorId),
        MONITOR_NAME:   ctx.monitorName,
        MONITOR_URL:    ctx.monitorUrl ?? '',
        MONITOR_TYPE:   ctx.monitorType,
        STATUS:         ctx.newStatus,
        PREV_STATUS:    ctx.oldStatus,
        TRIGGERED_AT:   ctx.timestamp,
        TRIGGER:        ctx.trigger,
      };

      const child = exec(cfg.script, {
        shell,
        timeout: timeoutMs,
        env,
        maxBuffer: 512 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          if (error.killed || error.signal === 'SIGTERM') {
            resolve({ status: 'timeout', output: stdout.slice(0, 2000), error: 'Script timed out' });
          } else {
            resolve({ status: 'failed', output: stdout.slice(0, 2000), error: stderr.slice(0, 500) || error.message });
          }
        } else {
          resolve({ status: 'success', output: (stdout + '\n' + stderr).trim().slice(0, 2000) });
        }
      });

      // Belt-and-suspenders kill if exec timeout doesn't fire
      const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, timeoutMs + 2000);
      child.once('exit', () => clearTimeout(killer));
    });
  },

  async _execDockerRestart(cfg: DockerRestartRemediationConfig, ctx: TriggerContext): Promise<RunResult> {
    const containerName = cfg.containerName;
    const socketPath    = cfg.socketPath ?? '/var/run/docker.sock';
    const path          = `/containers/${encodeURIComponent(containerName)}/restart`;

    return new Promise((resolve) => {
      const req = http.request(
        { socketPath, method: 'POST', path },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: 'success', output: `Container "${containerName}" restarted (HTTP ${res.statusCode})` });
            } else if (res.statusCode === 404) {
              resolve({ status: 'failed', error: `Container "${containerName}" not found` });
            } else {
              resolve({ status: 'failed', error: `Docker API returned HTTP ${res.statusCode}: ${body.slice(0, 200)}` });
            }
          });
        },
      );

      req.on('error', (err) => {
        resolve({ status: 'failed', error: err.message });
      });

      setTimeout(() => {
        req.destroy();
        resolve({ status: 'timeout', error: 'Docker API request timed out after 15s' });
      }, 15_000);

      req.end();
    });
  },

  async _execSsh(cfg: SshRemediationConfig, ctx: TriggerContext): Promise<RunResult> {
    // Fetch the real encrypted credential from DB (the API returns '[set]' masking)
    // We need to re-query the action from DB to get the unmasked config.
    // This is handled by the caller (_executeAction) which passes the DB config directly,
    // but since rowToAction masks it, we need to re-query without masking.
    let encryptedCred: string | undefined;
    try {
      const raw = await db('remediation_actions')
        .where({ id: ctx._actionId })
        .select('config')
        .first() as { config: unknown } | undefined;
      if (raw) {
        const c = typeof raw.config === 'string' ? JSON.parse(raw.config) : raw.config as Record<string, unknown>;
        encryptedCred = c.credentialEnc as string | undefined;
      }
    } catch (err) {
      logger.error(err, 'Failed to fetch SSH credential from DB');
    }

    if (!encryptedCred) {
      return { status: 'failed', error: 'No SSH credential configured' };
    }

    let credential: string;
    try {
      credential = decryptCredential(encryptedCred);
    } catch (err) {
      return { status: 'failed', error: 'Failed to decrypt SSH credential' };
    }

    const timeoutMs = cfg.timeoutMs ?? 15_000;

    return new Promise((resolve) => {
      const conn = new SshClient();
      let resolved = false;
      const done = (r: RunResult) => { if (!resolved) { resolved = true; resolve(r); } };

      const timer = setTimeout(() => {
        conn.end();
        done({ status: 'timeout', error: `SSH command timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      conn.on('ready', () => {
        // Inject context variables into the command via env vars prepended as shell assignments
        const envPrefix = [
          `MONITOR_ID="${ctx.monitorId}"`,
          `MONITOR_NAME="${ctx.monitorName.replace(/"/g, '\\"')}"`,
          `STATUS="${ctx.newStatus}"`,
          `PREV_STATUS="${ctx.oldStatus}"`,
          `TRIGGER="${ctx.trigger}"`,
        ].join(' ');
        const fullCmd = `${envPrefix} ${cfg.command}`;

        conn.exec(fullCmd, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            done({ status: 'failed', error: err.message });
            return;
          }

          let stdout = '';
          let stderr = '';
          stream.on('data', (d: Buffer) => { stdout += d.toString(); });
          stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          stream.on('close', (code: number | null) => {
            clearTimeout(timer);
            conn.end();
            const output = (stdout + '\n' + stderr).trim().slice(0, 2000);
            if (code === 0 || code === null) {
              done({ status: 'success', output });
            } else {
              done({ status: 'failed', output, error: `Exit code ${code}` });
            }
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timer);
        done({ status: 'failed', error: err.message });
      });

      const connectOptions: Parameters<SshClient['connect']>[0] = {
        host:     cfg.host,
        port:     cfg.port ?? 22,
        username: cfg.username,
        readyTimeout: timeoutMs,
      };
      if (cfg.authType === 'password') {
        connectOptions.password = credential;
      } else {
        connectOptions.privateKey = credential;
      }
      conn.connect(connectOptions);
    });
  },
};

// ─── Trigger context ─────────────────────────────────────────────────────────

interface TriggerContext {
  monitorId:   number;
  monitorName: string;
  monitorUrl?: string;
  monitorType: string;
  oldStatus:   string;
  newStatus:   string;
  trigger:     'down' | 'up';
  timestamp:   string;
  /** Internal: action id for re-fetching unmasked SSH credential */
  _actionId?:  number;
}

// Patch _executeAction to inject _actionId into ctx before passing to _execSsh
const origExecAction = remediationService._executeAction.bind(remediationService);
remediationService._executeAction = async function (action: RemediationAction, ctx: TriggerContext) {
  return origExecAction(action, { ...ctx, _actionId: action.id });
};
