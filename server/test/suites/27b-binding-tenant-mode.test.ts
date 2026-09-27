// verify-env: AGENT_KEY_BINDING=tenant
/**
 * 27b — A5 AGENT_KEY_BINDING=tenant (first-deploy mode): any key of the
 * device's own tenant re-binds it; cross-tenant keys and MikroTik rows are
 * still refused.
 */
import { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import WebSocket from 'ws';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { KEYS } from '../fixtures';
import { createDevice, createKey, createMikrotikDevice } from '../seed';
import { AGENT_KEY_BINDING } from '../../src/services/agent.service';

describe('27b key binding, tenant mode (A5)', () => {
  let h: Harness;
  const clients: WebSocket[] = [];
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });
  afterEach(() => { for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* ignore */ } } });

  function upgrade(key: string, uuid: string): Promise<{ kind: string; code?: number }> {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/agent/ws?uuid=${encodeURIComponent(uuid)}`, { headers: { 'x-api-key': key } });
    clients.push(ws);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'timeout' }), 3000);
      ws.on('open', () => { clearTimeout(timer); resolve({ kind: 'open' }); });
      ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve({ kind: 'refused', code: res.statusCode }); });
      ws.on('error', () => { /* reported above */ });
    });
  }

  lotIt('A5', '27b.1 same-tenant key re-binds; other tenant and MikroTik stay refused', async () => {
    assert.equal(AGENT_KEY_BINDING, 'tenant');
    const ka1 = await createKey(h.db, 2);
    const ka2 = await createKey(h.db, 2);
    const d = await createDevice(h.db, { tenantId: 2, keyId: ka1.id });
    assert.equal((await upgrade(ka2.key, d.uuid)).kind, 'open');
    assert.equal((await h.db('agent_devices').where({ id: d.id }).first()).api_key_id, ka2.id);

    const e = await createDevice(h.db, { tenantId: 2, keyId: ka1.id });
    const r = await upgrade(KEYS[3], e.uuid);
    assert.equal(r.code, 403);
    assert.equal((await h.db('agent_devices').where({ id: e.id }).first()).api_key_id, ka1.id);

    const m = await createMikrotikDevice(h.db, { tenantId: 2, keyId: ka1.id, host: `mt-${crypto.randomBytes(3).toString('hex')}` });
    const rm = await upgrade(ka2.key, m.uuid);
    assert.equal(rm.code, 403);
    assert.equal((await h.db('agent_devices').where({ id: m.id }).first()).api_key_id, ka1.id);
  });
});
