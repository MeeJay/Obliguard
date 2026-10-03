/**
 * 85 — W11-1 audit log (ADMIN-FEATURES-8, SECURITY-PARITY-13, RBAC-18,
 * FLEET-AGENT-18): audit_logs table (migration 039), auditService, the
 * /api/audit-log API and the instrumented write paths.
 *
 *   85.1 a Lift and a whitelist delete each leave a row with the actor, the
 *        client IP (utils/clientIp) and the target
 *   85.2 a firewall rule add is filed in the agent's tenant and linked to the
 *        agent (success when the agent applied it, a failed attempt when it
 *        is offline); /audit-log/device/:id lists it
 *   85.3 disabling an enrolment key leaves a row without the key value
 *   85.4 a failed login (known and unknown account) leaves an instance-level
 *        row with the attempted name and IP, never the password
 *   85.5 tenant isolation: tenant 2 (audit.read) never reads tenant 1 nor
 *        instance rows (?tenants= ignored, foreign agent 404); Default reads
 *        everything; no audit.read → 403
 *   85.6 secrets are absent: redactSecrets, the Obligate API key, the
 *        obli.tools API key and a MikroTik password never reach the table
 *   85.7 filters (action prefix, actor, success), distinct actions, paging;
 *        purge is platform + Default only and leaves 'audit.purged'
 *   85.8 client: AuditLogPage (PageContainer, URL filters, TenantBadge, CSV
 *        export), /audit-log route under audit.read, Sidebar entry, agent
 *        detail Activity tab
 *
 * Routes gated by step-up (W11-2) are confirmed with the password first
 * (stepUp below, a 404 when step-up is absent is ignored).
 */
import { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness, FakeWs } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import { ADMIN_B, PASSWORD, U } from '../fixtures';
import { createDevice, createKey, createUser, createMikrotikDevice, nextIp } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';
import { auditService, redactSecrets, REDACTED } from '../../src/services/audit.service';

const REPO = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

interface AuditRow {
  id: number;
  tenant_id: number | null;
  user_id: number | null;
  username: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  device_id: number | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  success: boolean;
}

/** A FakeWs that answers firewall commands like an agent. */
class FirewallAgent extends FakeWs {
  send(d: unknown): void {
    super.send(d);
    const m = JSON.parse(String(d));
    if (typeof m?.type === 'string' && m.type.startsWith('firewall_')) {
      setImmediate(() => this.receive({ type: 'firewall_response', id: m.id, success: true, rules: [] }));
    }
  }
}

/** Confirms the session with the password when the step-up endpoint exists (W11-2). */
async function stepUp(c: Client): Promise<void> {
  const r = await c.post('/api/profile/2fa/step-up', { method: 'password', password: PASSWORD });
  if (r.status === 404) return;
  assert.equal(r.status, 200, `step-up failed: ${r.status} ${r.text.slice(0, 200)}`);
}

describe('85 audit log (W11-1)', () => {
  let h: Harness;
  const fakes: FakeWs[] = [];
  before(async () => {
    h = await startHarness();
    const row = await h.db('users').where({ username: ADMIN_B.username }).first('id') as { id: number } | undefined;
    if (!row) {
      await createUser(h.db, { username: ADMIN_B.username, tenants: [ADMIN_B.tenant], tenantRole: ADMIN_B.tenantRole });
    } else {
      await h.db('user_tenants').where({ user_id: row.id, tenant_id: ADMIN_B.tenant }).update({ role: ADMIN_B.tenantRole });
    }
  });
  after(async () => { await h.close(); });
  afterEach(() => { for (const f of fakes.splice(0)) { try { f.close(); } catch { /* ignore */ } } });

  const rows = (where: Record<string, unknown>): Promise<AuditRow[]> =>
    h.db('audit_logs').where(where).orderBy('id', 'asc') as Promise<AuditRow[]>;

  const lastRow = async (where: Record<string, unknown>): Promise<AuditRow> => {
    const r = await rows(where);
    assert.ok(r.length > 0, `no audit row for ${JSON.stringify(where)}`);
    return r[r.length - 1];
  };

  lotIt('W11-1', '85.1 Lift and whitelist delete leave a row with actor, IP and target', async () => {
    const c = await h.adminIn(2);
    const ip = nextIp();
    const created = await c.post('/api/bans', { ip, reason: 'audit test' });
    assert.equal(created.status, 201, created.text);
    const banId = created.json.data.id as number;
    const createdRow = await lastRow({ action: 'bans.created', target_id: String(banId) });
    assert.equal(createdRow.tenant_id, 2);
    assert.equal(createdRow.details?.ip, ip);

    const lift = await c.del(`/api/bans/${banId}`);
    assert.equal(lift.status, 200, lift.text);
    const lifted = await lastRow({ action: 'bans.lifted', target_id: String(banId) });
    assert.equal(lifted.user_id, U.admin);
    assert.equal(lifted.username, 'admin');
    assert.equal(lifted.tenant_id, 2);
    assert.equal(lifted.ip_address, c.xff, 'client IP through utils/clientIp');
    assert.equal(lifted.success, true);
    assert.equal(lifted.details?.ip, ip);
    assert.ok(lifted.user_agent === null || typeof lifted.user_agent === 'string');

    const wip = nextIp();
    const wl = await c.post('/api/whitelist', { ip: wip, label: 'audit wl' });
    assert.equal(wl.status, 201, wl.text);
    const wlId = wl.json.data.id as number;
    assert.ok(await lastRow({ action: 'whitelist.created', target_id: String(wlId) }));
    const del = await c.del(`/api/whitelist/${wlId}`);
    assert.equal(del.status, 200, del.text);
    const deleted = await lastRow({ action: 'whitelist.deleted', target_id: String(wlId) });
    assert.equal(deleted.user_id, U.admin);
    assert.equal(deleted.ip_address, c.xff);
    assert.equal(deleted.tenant_id, 2);
    assert.ok(String(deleted.details?.ip ?? '').startsWith(wip), JSON.stringify(deleted.details));
  });

  lotIt('W11-1', '85.2 firewall rule add: agent tenant, device link, failed attempt when offline', async () => {
    const t = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const agent = new FirewallAgent();
    fakes.push(agent);
    await obliguardHub.register(t.uuid, 2, 2, '127.0.0.1', agent as any);
    const c = await h.adminIn(2);
    await stepUp(c);
    const rule = { name: 'Audit SSH', direction: 'in', action: 'block', protocol: 'tcp', localPort: '22' };
    const r = await c.post(`/api/agent/devices/${t.id}/firewall/rules`, rule);
    assert.equal(r.status, 200, r.text);
    const ok = await lastRow({ action: 'firewall.rule_added', device_id: t.id });
    assert.equal(ok.success, true);
    assert.equal(ok.tenant_id, 2);
    assert.equal(ok.user_id, U.admin);
    assert.equal(ok.ip_address, c.xff);
    assert.equal((ok.details?.rule as Record<string, unknown>)?.localPort, '22');

    // Offline agent: 503, recorded as a failed attempt.
    const off = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    const r2 = await c.post(`/api/agent/devices/${off.id}/firewall/rules`, rule);
    assert.equal(r2.status, 503, r2.text);
    const failed = await lastRow({ action: 'firewall.rule_added', device_id: off.id });
    assert.equal(failed.success, false);

    // Per-agent activity (agent detail Activity tab).
    const act = await c.get(`/api/audit-log/device/${t.id}`);
    assert.equal(act.status, 200, act.text);
    const items = act.json.data as Array<{ action: string; deviceId: number; username: string | null }>;
    assert.ok(items.some((i) => i.action === 'firewall.rule_added' && i.deviceId === t.id && i.username === 'admin'));
    assert.ok(items.every((i) => i.deviceId === t.id));

    // A row linked to an agent without an explicit tenant is filed in the
    // agent's tenant, not the operating one (a Default admin's action shows
    // in the customer's log and in the agent's Activity tab).
    const fakeReq = { tenantId: 1, session: { userId: U.admin, username: 'admin' }, headers: {}, socket: {} } as any;
    await auditService.logReq(fakeReq, { action: 'test.agent_tenant', targetType: 'agent', targetId: t.id, deviceId: t.id });
    assert.equal((await lastRow({ action: 'test.agent_tenant', device_id: t.id })).tenant_id, 2);
    await auditService.logReqMany(fakeReq, [{ action: 'test.agent_tenant_many', deviceId: t.id }, { action: 'test.agent_tenant_many' }]);
    const many = await rows({ action: 'test.agent_tenant_many' });
    assert.deepEqual(many.map((m) => m.tenant_id), [2, 1]);
    await auditService.logReq(fakeReq, { action: 'test.agent_tenant_override', deviceId: t.id, tenantId: null });
    assert.equal((await lastRow({ action: 'test.agent_tenant_override' })).tenant_id, null);
  });

  lotIt('W11-1', '85.3 disabling an enrolment key leaves a row without the key value', async () => {
    const key = await createKey(h.db, 2);
    const c = await h.adminIn(2);
    await stepUp(c);
    const r = await c.put(`/api/agent/keys/${key.id}`, { isActive: false });
    assert.equal(r.status, 200, r.text);
    const row = await lastRow({ action: 'agent_key.disabled', target_id: String(key.id) });
    assert.equal(row.tenant_id, 2);
    assert.equal(row.user_id, U.admin);
    assert.equal(row.ip_address, c.xff);
    assert.ok(!JSON.stringify(row).includes(key.key), 'the key value is never audited');
  });

  lotIt('W11-1', '85.4 a failed login leaves an instance row with the attempted name and IP, never the password', async () => {
    const anon = h.anon();
    const secret = 'Wrong-Pass-For-Audit-1!';
    const r = await anon.post('/api/auth/login', { username: 'member_b', password: secret });
    assert.equal(r.status, 401);
    const row = await lastRow({ action: 'auth.login', success: false, username: 'member_b' });
    assert.equal(row.user_id, U.member_b, 'the designated account');
    assert.equal(row.tenant_id, null, 'instance-level row');
    assert.equal(row.ip_address, anon.xff);
    assert.ok(!JSON.stringify(row).includes(secret));

    const anon2 = h.anon();
    const r2 = await anon2.post('/api/auth/login', { username: 'nobody-audit', password: secret });
    assert.equal(r2.status, 401);
    const row2 = await lastRow({ action: 'auth.login', success: false, username: 'nobody-audit' });
    assert.equal(row2.user_id, null);
    assert.equal(row2.ip_address, anon2.xff);
    assert.equal(row2.details?.reason, 'unknown_account');

    // Success is audited too, in the landing tenant.
    const ok = await h.login('member_b');
    const okRow = await lastRow({ action: 'auth.login', success: true, user_id: U.member_b });
    assert.equal(okRow.ip_address, ok.xff);
    assert.equal(okRow.tenant_id, 2);

    const all = JSON.stringify(await h.db('audit_logs').select('*'));
    assert.ok(!all.includes(secret), 'no password anywhere in the table');
  });

  lotIt('W11-1', '85.5 tenant 2 never reads tenant 1 or instance rows; Default reads all; audit.read required', async () => {
    // A tenant-1 row and an instance row to be hidden.
    const admin1 = await h.adminIn(1);
    const ip1 = nextIp();
    assert.equal((await admin1.post('/api/bans', { ip: ip1 })).status, 201);
    const dev1 = await createDevice(h.db, { tenantId: 1, keyId: 1 });
    await h.db('audit_logs').insert({ tenant_id: 1, action: 'agent.updated', device_id: dev1.id, target_type: 'agent', target_id: String(dev1.id) });
    await h.anon().post('/api/auth/login', { username: 'nobody-isolation', password: 'x-Wrong-1' });

    const b = await h.as(ADMIN_B.username);
    const list = await b.get('/api/audit-log?pageSize=500');
    assert.equal(list.status, 200, list.text);
    const items = list.json.data.items as Array<{ tenantId: number | null; action: string }>;
    assert.ok(items.length > 0);
    assert.ok(items.every((i) => i.tenantId === 2), `foreign rows leaked: ${JSON.stringify(items.filter((i) => i.tenantId !== 2)).slice(0, 300)}`);
    // The chip filter cannot widen a non-Default view.
    const widened = await b.get('/api/audit-log?tenants=1&pageSize=500');
    assert.ok((widened.json.data.items as Array<{ tenantId: number }>).every((i) => i.tenantId === 2));
    const actions = await b.get('/api/audit-log/distinct-actions');
    assert.equal(actions.status, 200);
    const tenant2Actions = new Set((await h.db('audit_logs').where({ tenant_id: 2 }).distinct('action')).map((r: { action: string }) => r.action));
    assert.ok((actions.json.data as string[]).every((a) => tenant2Actions.has(a)));
    // A foreign agent's activity does not exist for tenant 2.
    assert.equal((await b.get(`/api/audit-log/device/${dev1.id}`)).status, 404);
    // A platform admin standing on tenant 2 reads tenant 2 only too.
    const p2 = await h.adminIn(2);
    const p2list = await p2.get('/api/audit-log?pageSize=500');
    assert.ok((p2list.json.data.items as Array<{ tenantId: number | null }>).every((i) => i.tenantId === 2));

    // Default: every tenant + instance rows, narrowed by ?tenants=.
    const all = await admin1.get('/api/audit-log?pageSize=500');
    const allItems = all.json.data.items as Array<{ tenantId: number | null; tenantName: string | null }>;
    assert.ok(allItems.some((i) => i.tenantId === 1));
    assert.ok(allItems.some((i) => i.tenantId === 2 && typeof i.tenantName === 'string'), 'tenant name for the badge');
    assert.ok(allItems.some((i) => i.tenantId === null), 'instance rows');
    const narrowed = await admin1.get('/api/audit-log?tenants=2&pageSize=500');
    assert.ok((narrowed.json.data.items as Array<{ tenantId: number }>).every((i) => i.tenantId === 2));
    assert.equal((await admin1.get(`/api/audit-log/device/${dev1.id}`)).status, 200);

    // No audit.read: 403 on every read.
    const member = await h.as('member_b');
    assert.equal((await member.get('/api/audit-log')).status, 403);
    assert.equal((await member.get('/api/audit-log/distinct-actions')).status, 403);
    assert.equal((await member.get(`/api/audit-log/device/${dev1.id}`)).status, 403);
    assert.equal((await h.anon().get('/api/audit-log')).status, 401);
  });

  lotIt('W11-1', '85.6 secrets never reach the audit table', async () => {
    // Unit: every secret-named key is redacted, recursively.
    const red = redactSecrets({
      password: 'p', apiKey: 'k', nested: { clientSecret: 's', list: [{ token: 't', ok: 1 }] }, name: 'visible',
    }) as Record<string, any>;
    assert.equal(red.password, REDACTED);
    assert.equal(red.apiKey, REDACTED);
    assert.equal(red.nested.clientSecret, REDACTED);
    assert.equal(red.nested.list[0].token, REDACTED);
    assert.equal(red.nested.list[0].ok, 1);
    assert.equal(red.name, 'visible');

    const admin = await h.adminIn(1);
    await stepUp(admin);
    const obligateKey = 'obligate-audit-secret-0123456789';
    const ob = await admin.put('/api/admin/config/obligate', { apiKey: obligateKey });
    assert.equal(ob.status, 200, ob.text);
    const obRow = await lastRow({ action: 'app_config.obligate_updated' });
    assert.equal(obRow.tenant_id, null);
    assert.equal(obRow.details?.apiAccess, 'set');

    const otKey = 'oblitools-audit-secret-abcdef';
    const ot = await admin.put('/api/admin/config/oblitools_api_key', { value: otKey });
    assert.equal(ot.status, 200, ot.text);
    const otRow = await lastRow({ action: 'app_config.updated', target_id: 'oblitools_api_key' });
    assert.equal(otRow.details?.value, REDACTED);

    // MikroTik credentials: field names only.
    const mk = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: `mk-audit-${Date.now()}` });
    const c2 = await h.adminIn(2);
    const mkPass = 'mikrotik-audit-secret-pw';
    const up = await c2.put(`/api/mikrotik/${mk.id}/credentials`, { apiPassword: mkPass });
    assert.equal(up.status, 200, up.text);
    const mkRow = await lastRow({ action: 'mikrotik.credentials_updated', device_id: mk.id });
    assert.deepEqual(mkRow.details?.fields, ['apiPassword']);
    assert.equal(mkRow.tenant_id, 2);

    const all = JSON.stringify(await h.db('audit_logs').select('*'));
    for (const s of [obligateKey, otKey, mkPass]) assert.ok(!all.includes(s), `secret leaked: ${s}`);
  });

  lotIt('W11-1', '85.7 filters, distinct actions, paging; purge is platform + Default only', async () => {
    const admin1 = await h.adminIn(1);
    for (let i = 0; i < 3; i++) await h.anon().post('/api/auth/login', { username: `filter-${i}`, password: 'x-Wrong-1' });

    const prefix = await admin1.get('/api/audit-log?action=auth.&pageSize=500');
    assert.equal(prefix.status, 200);
    assert.ok((prefix.json.data.items as Array<{ action: string }>).every((i) => i.action.startsWith('auth.')));
    const failed = await admin1.get('/api/audit-log?action=auth.login&success=false&actor=filter-&pageSize=500');
    const fItems = failed.json.data.items as Array<{ username: string; success: boolean }>;
    assert.equal(fItems.length, 3);
    assert.ok(fItems.every((i) => i.success === false && i.username.startsWith('filter-')));
    const page = await admin1.get('/api/audit-log?action=auth.login&success=false&actor=filter-&pageSize=2&page=2');
    assert.equal(page.json.data.total, 3);
    assert.equal(page.json.data.items.length, 1);
    assert.equal((await admin1.get('/api/audit-log?from=not-a-date')).status, 400);
    const distinct = await admin1.get('/api/audit-log/distinct-actions');
    assert.ok((distinct.json.data as string[]).includes('auth.login'));

    // Purge: tenant admin and platform admin outside Default refused.
    const b = await h.as(ADMIN_B.username);
    assert.equal((await b.del('/api/audit-log')).status, 403);
    const p2 = await h.adminIn(2);
    assert.equal((await p2.del('/api/audit-log')).status, 403);
    const before = Number((await h.db('audit_logs').count<{ c: string }[]>({ c: 'id' }))[0].c);
    const keepOld = await admin1.del('/api/audit-log?olderThanDays=30');
    assert.equal(keepOld.status, 200, keepOld.text);
    assert.equal(keepOld.json.data.deleted, 0, 'nothing older than 30 days');
    assert.equal(Number((await h.db('audit_logs').count<{ c: string }[]>({ c: 'id' }))[0].c), before + 1);
    const purge = await admin1.del('/api/audit-log?tenants=3');
    assert.equal(purge.status, 200);
    const trace = await lastRow({ action: 'audit.purged' });
    assert.equal(trace.user_id, U.admin);
    assert.deepEqual(trace.details?.tenants, [3]);
  });

  lotIt('W11-1', '85.8 client: page, route, sidebar entry and agent Activity tab', () => {
    const page = read('client/src/pages/AuditLogPage.tsx');
    assert.match(page, /<PageContainer/);
    assert.match(page, /useSearchParams/, 'filters live in the URL');
    assert.match(page, /TenantBadge/);
    assert.match(page, /saveText|downloadText|download/, 'CSV export through utils/download');
    assert.match(read('client/src/api/audit.api.ts'), /\/audit-log/);
    const app = read('client/src/App.tsx');
    assert.match(app, /requiredCapabilities=\{\['audit\.read'\]\}[\s\S]{0,200}path="\/audit-log"/);
    assert.match(read('client/src/components/layout/Sidebar.tsx'), /path: '\/audit-log'/);
    assert.ok(fs.existsSync(path.join(REPO, 'client/src/pages/agentDetail/ActivityTab.tsx')));
    assert.match(read('client/src/pages/AgentDetailPage.tsx'), /ActivityTab|activity/);
    assert.match(read('client/src/pages/agentDetail/ActivityTab.tsx'), /audit-log\?device=/, 'Activity links to the log filtered on the agent');
    assert.match(page, /deviceId:/, 'device filter from the URL');
  });
});
