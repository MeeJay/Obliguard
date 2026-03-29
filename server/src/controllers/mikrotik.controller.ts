import type { Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { logger } from '../utils/logger';
import { mikrotikDeviceService } from '../services/mikrotik/mikrotikDevice.service';
import { mikrotikBanSync } from '../services/mikrotik/mikrotikBanSync.service';
import { mikrotikImport } from '../services/mikrotik/mikrotikImport.service';
import { parseMikroTikSyslog } from '../services/mikrotik/syslogParser';
import { agentService, markMikrotikSeen } from '../services/agent.service';
import type { AgentIpEvent } from '@obliview/shared';

export async function createMikroTikDevice(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = (req as any).tenantId as number;
    const userId = (req as any).userId as number;

    const { name, hostname, groupId, apiHost, apiPort, apiUseTls, apiUsername, apiPassword, syslogIdentifier, addressListName } = req.body;

    if (!name || !hostname || !apiHost || !apiUsername || !apiPassword || !syslogIdentifier) {
      res.status(400).json({ error: 'Missing required fields: name, hostname, apiHost, apiUsername, apiPassword, syslogIdentifier' });
      return;
    }

    const result = await mikrotikDeviceService.create(
      { name, hostname, groupId, apiHost, apiPort, apiUseTls, apiUsername, apiPassword, syslogIdentifier, addressListName },
      tenantId,
      userId,
    );

    res.status(201).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: msg });
  }
}

export async function getMikroTikCredentials(req: Request, res: Response): Promise<void> {
  try {
    const deviceId = parseInt(req.params.id, 10);
    const creds = await mikrotikDeviceService.getCredentials(deviceId);
    if (!creds) {
      res.status(404).json({ error: 'MikroTik credentials not found' });
      return;
    }
    res.json(creds);
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
}

export async function updateMikroTikCredentials(req: Request, res: Response): Promise<void> {
  try {
    const deviceId = parseInt(req.params.id, 10);
    await mikrotikDeviceService.updateCredentials(deviceId, req.body);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: msg });
  }
}

export async function testMikroTikConnection(req: Request, res: Response): Promise<void> {
  try {
    const deviceId = parseInt(req.params.id, 10);
    const result = await mikrotikDeviceService.testConnection(deviceId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal error' });
  }
}

export async function syncMikroTikBans(req: Request, res: Response): Promise<void> {
  try {
    const deviceId = parseInt(req.params.id, 10);
    const result = await mikrotikBanSync.fullSync(deviceId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
}

export async function pollMikroTikImport(req: Request, res: Response): Promise<void> {
  try {
    await mikrotikImport.pollNow();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
}

/**
 * HTTP syslog ingestion endpoint.
 * Used when UDP syslog is not available (reverse proxy, Docker, etc.).
 *
 * Auth: Bearer token (ingest_token from mikrotik_credentials)
 * Body: { lines: ["log line 1", "log line 2", ...] }
 *   or: plain text (one log line per line)
 *
 * MikroTik config:
 *   /tool/fetch url="https://obliguard.example.com/api/agent/mikrotik/ingest" \
 *     http-method=post http-header-field="Authorization: Bearer <token>" \
 *     http-data="<log lines>"
 */
export async function ingestMikroTikSyslog(req: Request, res: Response): Promise<void> {
  // Extract token from Authorization header or query param
  let token = '';
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (typeof req.query.token === 'string') {
    token = req.query.token;
  }

  if (!token) {
    res.status(401).json({ error: 'Missing token (Authorization: Bearer <token> or ?token=<token>)' });
    return;
  }

  // Lookup device by ingest token
  const row = await db('mikrotik_credentials')
    .join('agent_devices', 'agent_devices.id', 'mikrotik_credentials.device_id')
    .where('mikrotik_credentials.ingest_token', token)
    .where('agent_devices.status', 'approved')
    .select('agent_devices.id as device_id', 'agent_devices.tenant_id')
    .first() as { device_id: number; tenant_id: number } | undefined;

  if (!row) {
    res.status(403).json({ error: 'Invalid or unknown ingest token' });
    return;
  }

  // Parse body — accept JSON { lines: [...] } or plain text
  let lines: string[] = [];
  if (req.is('application/json') && Array.isArray(req.body?.lines)) {
    lines = req.body.lines;
  } else if (typeof req.body === 'string') {
    lines = req.body.split('\n').filter(Boolean);
  } else if (typeof req.body?.data === 'string') {
    lines = req.body.data.split('\n').filter(Boolean);
  } else if (Buffer.isBuffer(req.body)) {
    lines = req.body.toString('utf-8').split('\n').filter(Boolean);
  }

  if (lines.length === 0) {
    res.json({ ok: true, processed: 0 });
    return;
  }

  // Update syslog timestamp + mark online
  db('mikrotik_credentials')
    .where('device_id', row.device_id)
    .update({ last_syslog_at: db.fn.now() })
    .catch(() => {});
  markMikrotikSeen(row.device_id);

  // Parse and inject events
  const events: AgentIpEvent[] = [];
  for (const line of lines) {
    const parsed = parseMikroTikSyslog(line.trim());
    if (!parsed) continue;
    events.push({
      id: `${crypto.randomUUID()}-${Date.now()}`,
      ip: parsed.ip,
      username: parsed.username,
      service: parsed.service,
      eventType: parsed.eventType,
      timestamp: new Date().toISOString(),
      rawLog: parsed.rawLog,
    });
  }

  if (events.length > 0) {
    try {
      await agentService.processEventsFlush(row.device_id, row.tenant_id, events);
    } catch (err) {
      logger.warn({ err, deviceId: row.device_id }, 'MikroTik HTTP ingest: event processing error');
    }
  }

  res.json({ ok: true, processed: events.length });
}
