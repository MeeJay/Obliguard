/**
 * MikroTik device management service.
 *
 * Handles CRUD for MikroTik remote devices + their API credentials.
 * MikroTik devices are stored as rows in `agent_devices` with device_type='mikrotik',
 * plus a linked row in `mikrotik_credentials`.
 */

import crypto from 'crypto';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { encryptSecret, decryptSecret } from '../../utils/crypto';
import { createRouterOSClient } from './routerosClient';
import type { CreateMikroTikDeviceRequest, UpdateMikroTikCredentialsRequest, MikroTikCredentials } from '@obliview/shared';

export const mikrotikDeviceService = {
  /**
   * Create a new MikroTik remote device.
   */
  async create(
    data: CreateMikroTikDeviceRequest,
    tenantId: number,
    createdBy: number,
  ): Promise<{ deviceId: number; uuid: string }> {
    // Check syslog_identifier uniqueness
    const existing = await db('mikrotik_credentials')
      .where('syslog_identifier', data.syslogIdentifier)
      .first();
    if (existing) {
      throw new Error(`Syslog identifier "${data.syslogIdentifier}" is already used by another device`);
    }

    const uuid = crypto.randomUUID();
    const now = new Date();

    const [device] = await db('agent_devices')
      .insert({
        uuid,
        hostname: data.hostname,
        tenant_id: tenantId,
        name: data.name,
        ip: data.apiHost,
        device_type: 'mikrotik',
        status: 'approved', // No pending approval for admin-created remote devices
        approved_by: createdBy,
        approved_at: now,
        group_id: data.groupId ?? null,
        heartbeat_monitoring: true,
        check_interval_seconds: 60,
        os_info: JSON.stringify({ platform: 'routeros', distro: 'MikroTik', release: null, arch: 'unknown' }),
        created_at: now,
        updated_at: now,
      })
      .returning('id');

    const deviceId = typeof device === 'object' ? (device as { id: number }).id : device as number;

    await db('mikrotik_credentials').insert({
      device_id: deviceId,
      api_host: data.apiHost,
      api_port: data.apiPort ?? 8728,
      api_use_tls: data.apiUseTls ?? false,
      api_username: data.apiUsername,
      api_password_enc: encryptSecret(data.apiPassword),
      syslog_identifier: data.syslogIdentifier,
      address_list_name: data.addressListName ?? 'obliguard_blocklist',
      import_address_lists: data.importAddressLists ?? null,
      ingest_token: crypto.randomBytes(32).toString('hex'),
      created_at: now,
      updated_at: now,
    });


    logger.info({ deviceId, hostname: data.hostname, syslogId: data.syslogIdentifier }, 'MikroTik device created');

    return { deviceId, uuid };
  },

  /**
   * Get credentials for a MikroTik device (password excluded).
   */
  async getCredentials(deviceId: number): Promise<MikroTikCredentials | null> {
    const row = await db('mikrotik_credentials').where('device_id', deviceId).first();
    if (!row) return null;
    return {
      id: row.id,
      deviceId: row.device_id,
      apiHost: row.api_host,
      apiPort: row.api_port,
      apiUseTls: row.api_use_tls,
      apiUsername: row.api_username,
      syslogIdentifier: row.syslog_identifier,
      addressListName: row.address_list_name,
      importAddressLists: row.import_address_lists ?? null,
      ingestToken: row.ingest_token ?? null,
      lastApiConnectedAt: row.last_api_connected_at?.toISOString() ?? null,
      lastApiError: row.last_api_error,
      lastSyslogAt: row.last_syslog_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  },

  /**
   * Update MikroTik credentials.
   */
  async updateCredentials(deviceId: number, data: UpdateMikroTikCredentialsRequest): Promise<void> {
    const updates: Record<string, unknown> = { updated_at: new Date() };

    if (data.apiHost !== undefined) updates.api_host = data.apiHost;
    if (data.apiPort !== undefined) updates.api_port = data.apiPort;
    if (data.apiUseTls !== undefined) updates.api_use_tls = data.apiUseTls;
    if (data.apiUsername !== undefined) updates.api_username = data.apiUsername;
    if (data.apiPassword !== undefined) updates.api_password_enc = encryptSecret(data.apiPassword);
    if (data.syslogIdentifier !== undefined) {
      const conflict = await db('mikrotik_credentials')
        .where('syslog_identifier', data.syslogIdentifier)
        .whereNot('device_id', deviceId)
        .first();
      if (conflict) {
        throw new Error(`Syslog identifier "${data.syslogIdentifier}" is already used`);
      }
      updates.syslog_identifier = data.syslogIdentifier;
    }
    if (data.addressListName !== undefined) updates.address_list_name = data.addressListName;
    if (data.importAddressLists !== undefined) updates.import_address_lists = data.importAddressLists;

    await db('mikrotik_credentials').where('device_id', deviceId).update(updates);

  },

  /**
   * Test API connection to a MikroTik device. Returns the router identity.
   */
  async testConnection(deviceId: number): Promise<{ success: boolean; identity?: string; error?: string }> {
    const row = await db('mikrotik_credentials').where('device_id', deviceId).first();
    if (!row) return { success: false, error: 'Credentials not found' };

    let password: string;
    try {
      password = decryptSecret(row.api_password_enc);
    } catch {
      return { success: false, error: 'Failed to decrypt stored password' };
    }

    try {
      const client = await createRouterOSClient({
        host: row.api_host,
        port: row.api_port,
        useTls: row.api_use_tls,
        username: row.api_username,
        password,
      });
      const identity = await client.testConnection();
      client.close();

      await db('mikrotik_credentials').where('device_id', deviceId).update({
        last_api_connected_at: new Date(),
        last_api_error: null,
      });

      // Mark device as seen so it shows online in the UI
      const { markMikrotikSeen } = await import('../agent.service');
      markMikrotikSeen(deviceId);

      return { success: true, identity };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db('mikrotik_credentials').where('device_id', deviceId).update({
        last_api_error: msg,
      });
      return { success: false, error: msg };
    }
  },

  /**
   * Get the decrypted RouterOS config for a device (internal use only).
   */
  async getRouterOSConfig(deviceId: number) {
    const row = await db('mikrotik_credentials').where('device_id', deviceId).first();
    if (!row) return null;
    return {
      host: row.api_host as string,
      port: row.api_port as number,
      useTls: row.api_use_tls as boolean,
      username: row.api_username as string,
      password: decryptSecret(row.api_password_enc as string),
      addressListName: row.address_list_name as string,
    };
  },
};
