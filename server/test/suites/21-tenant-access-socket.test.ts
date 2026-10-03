/**
 * 21 — A1 tenant access on Socket.io: membership changes and tenant deletion
 * evict live sockets; no-tenant non-admins are refused at the handshake.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, waitFor } from '../harness';
import type { Harness, RecordedEvent } from '../harness';
import { lotIt } from '../lots';
import { createUser } from '../seed';

describe('21 tenant access — sockets (A1)', () => {
  let h: Harness;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });

  const serverDisconnect = (events: RecordedEvent[]) =>
    events.some((e) => e.event === 'disconnect' && e.args[0] === 'io server disconnect');

  const socketIdsIn = async (room: string) => (await h.io.in(room).fetchSockets()).map((s) => s.id);

  lotIt('A1', '21.1 removing a member evicts its socket and refuses a new handshake', async () => {
    const u = await createUser(h.db, { tenants: [2] });
    const c = await h.login(u.username);
    const s = await h.socket(c);
    assert.ok(s.ok, 'member socket should connect');
    if (!s.ok) return;
    assert.ok((await socketIdsIn('tenant:2')).includes(s.socket.id!));

    const admin = await h.as('admin');
    assert.equal((await admin.del(`/api/tenants/2/members/${u.id}`)).status, 200);
    await waitFor(() => serverDisconnect(s.events), 1000);
    const ids = await socketIdsIn('tenant:2');
    assert.ok(!(await h.roomsOf(u.id)).includes('tenant:2'));
    assert.ok(ids.every((id) => id !== s.socket.id));

    const again = await h.socket(c);
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.error, 'No tenant access');

    const a = await h.socket(await h.as('admin'));
    assert.ok(a.ok, 'admin handshake still connects');
  });

  lotIt('A1', '21.2 adding a member closes its live sockets (they rejoin with the new rooms)', async () => {
    const u = await createUser(h.db, { tenants: [3] });
    const c = await h.login(u.username);
    const s = await h.socket(c);
    assert.ok(s.ok);
    if (!s.ok) return;
    const admin = await h.as('admin');
    assert.equal((await admin.post('/api/tenants/2/members', { userId: u.id, role: 'member' })).status, 200);
    await waitFor(() => serverDisconnect(s.events), 1000);
  });

  lotIt('A1', '21.3 deleting a tenant disconnects every socket sitting in it', async () => {
    const admin2 = await h.login('admin2');
    const t = await admin2.post('/api/tenants', { name: 'Sock', slug: `sock-${Date.now()}` });
    assert.equal(t.status, 201);
    const tid = t.json.data.id as number;
    const a1 = await h.login('admin');
    assert.equal((await a1.switchTenant(tid)).status, 200);
    const s = await h.socket(a1);
    assert.ok(s.ok);
    if (!s.ok) return;
    assert.ok((await socketIdsIn(`tenant:${tid}`)).includes(s.socket.id!));
    assert.equal((await admin2.del(`/api/tenants/${tid}`, { confirmName: 'Sock' })).status, 200);
    await waitFor(() => serverDisconnect(s.events), 1000);
    const r = await a1.get('/api/bans');
    assert.equal(r.status, 403);
    assert.equal(r.json?.code, 'noTenantAccess');
    assert.equal((await a1.get('/api/auth/me')).json.data.currentTenantId, 1);
  });

  lotIt('A1', '21.4 a no-tenant user is refused at the handshake', async () => {
    const nt = await h.login('no_tenant');
    const s = await h.socket(nt);
    assert.equal(s.ok, false);
    if (!s.ok) assert.equal(s.error, 'No tenant access');
  });
});
