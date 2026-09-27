/**
 * 13 — GET smoke: every real read route answers < 500 within 10 s, /api
 * routes answer JSON, and no outbound network call is attempted.
 *
 * Under NODE_ENV=test the production static handler is active: an unknown
 * authenticated GET falls to client/dist/index.html (or a 500 when client/dist
 * is missing), which is why only real routes are probed.
 *
 * KNOWN_BROKEN: paths answering 5xx on the baseline, each owned by a lot
 * (tagged TODO until that lot lands) or UNTRACKED.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import type { Lot } from '../lots';

const PATHS = [
  '/health', '/api/auth/me', '/api/auth/permissions', '/api/tenants', '/api/bans', '/api/bans/stats',
  '/api/whitelist', '/api/ip-events', '/api/ip-reputation', '/api/ip-reputation?status=banned',
  '/api/ip-labels', '/api/service-templates', '/api/agent/devices', '/api/agent/devices/stats',
  '/api/agent/devices/2', '/api/agent/devices/2/templates', '/api/agent/keys', '/api/agent/version',
  '/api/groups', '/api/groups/tree', '/api/groups/stats', '/api/settings/global/resolved',
  '/api/notifications/plugins', '/api/notifications/channels', '/api/notifications/bindings',
  '/api/users', '/api/teams', '/api/remote-blocklists', '/api/remote-blocklists/ips',
  '/api/remote-blocklists/stats', '/api/rate-limit-policies', '/api/live-alerts', '/api/admin/config',
  '/api/admin/config/agent-global', '/api/system', '/api/permission-sets', '/api/profile',
  '/api/profile/2fa/status', '/api/admin/smtp-servers',
];

// 500 without the ?scope= query param (knex undefined binding in notificationService.getBindings) — no owning lot yet.
const KNOWN_BROKEN: Record<string, Lot> = {
  '/api/notifications/bindings': 'UNTRACKED',
};

describe('13 GET smoke', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const probe = async (c: Client, path: string) => {
    const r = await c.get(path, { timeoutMs: 10_000 });
    assert.ok(r.status < 500, `${path} answered ${r.status}: ${r.text.slice(0, 200)}`);
    if (path.startsWith('/api/')) assert.match(String(r.headers['content-type']), /application\/json/, path);
  };

  for (const actor of ['admin@default', 'member_b'] as const) {
    const client = () => (actor === 'admin@default' ? h.adminIn(1) : h.as('member_b'));
    it(`13.1 ${actor}: read routes answer < 500 [BASELINE]`, async () => {
      const c = await client();
      const failures: string[] = [];
      for (const path of PATHS.filter((p) => !(p in KNOWN_BROKEN))) {
        try { await probe(c, path); } catch (err) { failures.push((err as Error).message); }
      }
      assert.deepEqual(failures, []);
    });
    for (const [path, lot] of Object.entries(KNOWN_BROKEN)) {
      lotIt(lot, `13.1 ${actor}: ${path} answers < 500`, async () => { await probe(await client(), path); });
    }
  }

  it('13.2 no outbound network call was attempted [BASELINE]', () => {
    assert.deepEqual(h.blockedNetwork, []);
  });
});
