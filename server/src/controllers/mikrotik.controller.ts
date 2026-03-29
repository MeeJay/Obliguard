import type { Request, Response } from 'express';
import { mikrotikDeviceService } from '../services/mikrotik/mikrotikDevice.service';
import { mikrotikBanSync } from '../services/mikrotik/mikrotikBanSync.service';
import { mikrotikImport } from '../services/mikrotik/mikrotikImport.service';

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
