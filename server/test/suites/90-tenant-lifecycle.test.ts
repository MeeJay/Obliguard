/**
 * 90 — W12-2 tenant deletion lifecycle (C13, D19, A15; owner decision 13:
 * refuse while agents remain, "Uninstall all agents", name + step-up).
 *
 *   90.1 the Default tenant cannot be deleted (403), nor its agents uninstalled
 *   90.2 enrolled agents block the deletion: 409 TENANT_HAS_AGENTS + count,
 *        no step-up prompt, nothing deleted; pending registrations do not block
 *   90.3 confirmName must equal the tenant name (400 TENANT_CONFIRM_MISMATCH)
 *   90.4 uninstall-agents queues 'uninstall' on the approved agents and
 *        delivers it to the connected ones; the summary reports them
 *   90.5 after the agents are gone: 200, no row of the tenant left in any
 *        tenant_id table, scoped rows aimed at its groups / agents gone,
 *        routers purged of tagged entries only, channels closed, audit row
 *   90.6 a deletion that goes ahead asks for the step-up 'tenant.delete';
 *        member role writes ask for 'users.role'
 *   90.7 policy 'uninstall': connected agents get the command and the tenant
 *        is deleted at once
 *   90.8 a gate that skipped the prompt (refused state) never lets a deletion
 *        through when the handler then finds it allowed
 */
import { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startHarness, waitFor, FakeWs } from '../harness';
import type { Harness, Client } from '../harness';
import { lotIt } from '../lots';
import { createDevice, createGroup, createKey, createMikrotikDevice, createUser, insertBan, insertWhitelist, nextIp } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';
import { tenantDeleteConfig, tenantService } from '../../src/services/tenant.service';
import { RouterOSClient } from '../../src/services/mikrotik/routerosClient';

const uniq = (p: string) => `${p}-${crypto.randomBytes(5).toString('hex')}`;

describe('90 tenant deletion lifecycle (W12-2)', () => {
  let h: Harness;
  const fakes: FakeWs[] = [];

  before(async () => { h = await startHarness(); });
  after(async () => { await h.close(); });
  afterEach(() => {
    for (const f of fakes.splice(0)) { try { f.close(); } catch { /* ignore */ } }
    tenantDeleteConfig.agentPolicy = 'refuse';
  });

  async function newTenant(admin: Client): Promise<{ id: number; name: string }> {
    const name = uniq('Doomed');
    const r = await admin.post('/api/tenants', { name, slug: name.toLowerCase() });
    assert.equal(r.status, 201, r.text);
    return { id: r.json.data.id as number, name };
  }

  /** A live agent channel (FakeWs) of `tenantId`, registered on the hub. */
  async function live(uuid: string, tenantId: number, keyId: number): Promise<FakeWs> {
    const ws = new FakeWs();
    fakes.push(ws);
    assert.equal(await obliguardHub.register(uuid, tenantId, keyId, '127.0.0.1', ws as never), true);
    return ws;
  }

  /** Every (table, column) holding a tenant id, from the live schema. */
  async function tenantColumns(): Promise<Array<{ table: string; column: string }>> {
    const r = await h.db.raw(`
      SELECT c.table_name AS "table", c.column_name AS "column"
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
       WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
         AND c.column_name IN ('tenant_id', 'origin_tenant_id', 'preferred_tenant_id')
         AND c.data_type IN ('integer', 'bigint')`) as { rows: Array<{ table: string; column: string }> };
    return r.rows;
  }

  async function leftovers(tid: number): Promise<string[]> {
    const out: string[] = [];
    for (const { table, column } of await tenantColumns()) {
      const [{ n }] = await h.db(table).where(column, tid).count<{ n: string }[]>({ n: '*' });
      if (Number(n) > 0) out.push(`${table}.${column}=${n}`);
    }
    return out;
  }

  lotIt('W12-2', '90.1 the Default tenant cannot be deleted', async () => {
    const admin = await h.as('admin');
    const r = await admin.del('/api/tenants/1', { confirmName: 'Default' });
    assert.equal(r.status, 403, r.text);
    assert.ok(await h.db('tenants').where({ id: 1 }).first());
    const u = await admin.post('/api/tenants/1/uninstall-agents');
    assert.equal(u.status, 403, u.text);
    // Not a platform admin: 403 before anything else.
    const member = await h.as('member_b');
    assert.equal((await member.del('/api/tenants/2', { confirmName: 'B' })).status, 403);
  });

  lotIt('W12-2', '90.2 enrolled agents block the deletion (409, no prompt, nothing deleted)', async () => {
    const admin = await h.as('admin');
    const t = await newTenant(admin);
    const key = await createKey(h.db, t.id);
    await createDevice(h.db, { tenantId: t.id, keyId: key.id, status: 'approved' });
    await createDevice(h.db, { tenantId: t.id, keyId: key.id, status: 'suspended' });
    await createDevice(h.db, { tenantId: t.id, keyId: key.id, status: 'pending' });

    // A fresh session (no step-up yet) gets the 409 directly, not a prompt.
    const fresh = await h.login('admin');
    const r = await fresh.rawRequest('DELETE', `/api/tenants/${t.id}`, { body: { confirmName: t.name } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json?.code, 'TENANT_HAS_AGENTS');
    assert.equal(r.json?.count, 2);
    assert.ok(await h.db('tenants').where({ id: t.id }).first());
    assert.equal(Number((await h.db('agent_devices').where({ tenant_id: t.id }).count<{ n: string }[]>({ n: '*' }))[0].n), 3);

    const s = await admin.get(`/api/tenants/${t.id}/agents-summary`);
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.data.total, 2);
    assert.equal(s.json.data.approved, 1);
    assert.equal(s.json.data.suspended, 1);
    assert.equal(s.json.data.unenrolled, 1);
    assert.equal(s.json.data.policy, 'refuse');
    assert.equal((await (await h.as('member_b')).get(`/api/tenants/${t.id}/agents-summary`)).status, 403);

    // Pending registrations alone never block: they received no ban.
    await h.db('agent_devices').where({ tenant_id: t.id }).whereIn('status', ['approved', 'suspended']).delete();
    const ok = await admin.del(`/api/tenants/${t.id}`, { confirmName: t.name });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(await h.db('agent_devices').where({ tenant_id: t.id }).first(), undefined);
  });

  lotIt('W12-2', '90.3 confirmName must equal the tenant name', async () => {
    const admin = await h.as('admin');
    const t = await newTenant(admin);
    for (const body of [undefined, {}, { confirmName: 'wrong' }, { confirmName: t.name.toUpperCase() }]) {
      const r = await admin.del(`/api/tenants/${t.id}`, body);
      assert.equal(r.status, 400, r.text);
      assert.equal(r.json?.code, 'TENANT_CONFIRM_MISMATCH');
    }
    assert.ok(await h.db('tenants').where({ id: t.id }).first());
    assert.equal((await admin.del('/api/tenants/999999', { confirmName: 'x' })).status, 404);
    assert.equal((await admin.del(`/api/tenants/${t.id}`, { confirmName: `  ${t.name} ` })).status, 200);
  });

  lotIt('W12-2', '90.4 uninstall-agents queues uninstall and delivers it to connected agents', async () => {
    const admin = await h.as('admin');
    const t = await newTenant(admin);
    const key = await createKey(h.db, t.id);
    const on = await createDevice(h.db, { tenantId: t.id, keyId: key.id, status: 'approved' });
    const off = await createDevice(h.db, { tenantId: t.id, keyId: key.id, status: 'approved' });
    const susp = await createDevice(h.db, { tenantId: t.id, keyId: key.id, status: 'suspended' });
    const ws = await live(on.uuid, t.id, key.id);

    const r = await admin.post(`/api/tenants/${t.id}/uninstall-agents`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.queued, 2);
    assert.equal(r.json.data.delivered, 1);
    assert.equal(r.json.data.summary.uninstalling, 2);
    assert.equal(r.json.data.summary.suspended, 1);
    await waitFor(() => ws.sent.some((f) => f.type === 'config' && f.command === 'uninstall'), 1000);

    const rows = await h.db('agent_devices').whereIn('id', [on.id, off.id, susp.id])
      .select('id', 'pending_command', 'uninstall_commanded_at') as Array<{ id: number; pending_command: string | null; uninstall_commanded_at: Date | null }>;
    const byId = new Map(rows.map((x) => [x.id, x]));
    assert.equal(byId.get(on.id)?.pending_command, null);
    assert.ok(byId.get(on.id)?.uninstall_commanded_at);
    assert.equal(byId.get(off.id)?.pending_command, 'uninstall');
    assert.equal(byId.get(susp.id)?.pending_command, null);

    const audit = await h.db('audit_logs').where({ action: 'tenant.agents_uninstall_requested', target_id: String(t.id) }).first();
    assert.ok(audit, 'audit row');
    assert.equal(audit.tenant_id, 1);
    // Still blocked: the agents have not acknowledged yet.
    assert.equal((await admin.del(`/api/tenants/${t.id}`, { confirmName: t.name })).status, 409);
  });

  lotIt('W12-2', '90.5 deletion removes every row of the tenant, purges its routers and closes its channels', async () => {
    const admin = await h.as('admin');
    const t = await newTenant(admin);
    const tid = t.id;
    const key = await createKey(h.db, tid);
    const g = await createGroup(h.db, { tenantId: tid, name: uniq('g') });
    const dev = await createDevice(h.db, { tenantId: tid, keyId: key.id, status: 'approved', groupId: g });
    const router = await createMikrotikDevice(h.db, { tenantId: tid, keyId: key.id, host: 'mt-doomed.verify.invalid' });
    const member = await createUser(h.db, { tenants: [2, tid] });
    await h.db('users').where({ id: member.id }).update({ preferred_tenant_id: tid });

    // Tenant-owned rows across the schema.
    const ownBan = await insertBan(h.db, { ip: nextIp(), scope: 'tenant', scopeId: tid, tenantId: tid });
    const globalBan = await insertBan(h.db, { ip: nextIp(), scope: 'global', originTenantId: tid, banType: 'auto' });
    await h.db('ip_ban_exclusions').insert({ ban_id: globalBan, tenant_id: tid });
    await insertWhitelist(h.db, { ip: `${nextIp()}/32`, scope: 'group', scopeId: g, tenantId: tid });
    await h.db('rate_limit_policies').insert({ type: 'connection', scope: 'agent', scope_id: dev.id, tenant_id: tid, max_value: 10 });
    const [tpl] = await h.db('service_templates').insert({ name: uniq('tpl'), service_type: 'custom', custom_regex: '(?P<ip>x)', tenant_id: tid }).returning('id') as Array<{ id: number }>;
    await h.db('service_template_assignments').insert({ template_id: tpl.id, scope: 'group', scope_id: g });
    const [ch] = await h.db('notification_channels').insert({ name: uniq('ch'), type: 'webhook', config: '{}', tenant_id: tid }).returning('id') as Array<{ id: number }>;
    await h.db('notification_bindings').insert({ channel_id: ch.id, scope: 'global', scope_id: null, tenant_id: tid });
    await h.db('ip_display_names').insert({ ip: nextIp(), label: 'doomed', tenant_id: tid });
    const [team] = await h.db('user_teams').insert({ name: uniq('team'), tenant_id: tid }).returning('id') as Array<{ id: number }>;
    await h.db('team_memberships').insert({ team_id: team.id, user_id: member.id });
    await h.db('smtp_servers').insert({ name: 'doomed', host: 'smtp.verify.invalid', username: 'u', password: 'p', from_address: 'a@verify.test', tenant_id: tid });
    // Rows of OTHER tenants aimed at the doomed tenant's group / agent.
    const [defCh] = await h.db('notification_channels').insert({ name: uniq('defch'), type: 'webhook', config: '{}', tenant_id: 1 }).returning('id') as Array<{ id: number }>;
    await h.db('notification_bindings').insert({ channel_id: defCh.id, scope: 'group', scope_id: g, tenant_id: 1 });
    const [defTeam] = await h.db('user_teams').insert({ name: uniq('defteam'), tenant_id: 1 }).returning('id') as Array<{ id: number }>;
    // (the router: the agent row itself is gone before the deletion)
    await h.db('team_permissions').insert({ team_id: defTeam.id, scope: 'agent', scope_id: router.id, level: 'ro' });

    // Router spy: one Obliguard entry, one operator entry.
    const proto = RouterOSClient.prototype as any;
    const saved: Record<string, unknown> = {};
    const commands: string[][] = [];
    for (const m of ['connect', 'login', 'commitPin', 'close', 'sendCommand']) saved[m] = proto[m];
    proto.connect = async function () { /* spy: no socket */ };
    proto.login = async function () { /* spy */ };
    proto.commitPin = async function () { /* spy */ };
    proto.close = function () { /* spy */ };
    proto.sendCommand = async function (words: string[]) {
      commands.push(words);
      if (words[0].endsWith('/print')) {
        return [
          ['!re', '=.id=*A1', '=address=192.0.2.10', '=comment=Obliguard auto-ban'],
          ['!re', '=.id=*A2', '=address=192.0.2.11', '=comment=operator entry'],
          ['!re', '=.id=*A3', '=address=192.0.2.12', '=comment=Obliguard import'],
          ['!done'],
        ];
      }
      return [['!done']];
    };

    try {
      // Blocked while the agent is there.
      assert.equal((await admin.del(`/api/tenants/${tid}`, { confirmName: t.name })).status, 409);
      assert.ok(await h.db('ip_bans').where({ id: ownBan }).first());

      // The agent acknowledged its uninstall and the cleanup job removed it.
      await h.db('agent_devices').where({ id: dev.id }).delete();
      const ws = await live(uniq('rowless'), tid, key.id);

      const r = await admin.del(`/api/tenants/${tid}`, { confirmName: t.name });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.data.routers.devices, 1);
      assert.equal(r.json.data.routers.removed, 2);
      assert.equal(r.json.data.routers.failed, 0);

      // Routers: only the tagged entries, in one batch.
      const removes = commands.filter((w) => w[0] === '/ip/firewall/address-list/remove');
      assert.deepEqual(removes, [['/ip/firewall/address-list/remove', '=.id=*A1,*A3']]);

      // No row of the tenant anywhere.
      assert.deepEqual(await leftovers(tid), []);
      assert.equal(await h.db('tenants').where({ id: tid }).first(), undefined);
      assert.equal(await h.db('mikrotik_credentials').where({ device_id: router.id }).first(), undefined);
      assert.equal(await h.db('monitor_groups').where({ id: g }).first(), undefined);
      // Scoped rows of other tenants aimed at its group / agent are gone too.
      assert.equal(await h.db('notification_bindings').where({ scope: 'group', scope_id: g }).first(), undefined);
      assert.equal(await h.db('team_permissions').where({ scope: 'agent', scope_id: router.id }).first(), undefined);
      assert.equal(await h.db('service_template_assignments').where({ template_id: tpl.id }).first(), undefined);
      // The global ban it triggered stays (protection of every tenant).
      assert.ok(await h.db('ip_bans').where({ id: globalBan, is_active: true }).first());
      assert.ok(await h.db('users').where({ id: member.id }).first());

      // Channels of the tenant closed; new registrations refused.
      await waitFor(() => ws.closed?.code === 4003, 1000);
      const late = new FakeWs();
      fakes.push(late);
      assert.equal(await obliguardHub.register(uniq('late'), tid, key.id, '127.0.0.1', late as never), false);

      const audit = await h.db('audit_logs').where({ action: 'tenant.deleted', target_id: String(tid) }).first();
      assert.ok(audit, 'audit row');
      assert.equal(audit.tenant_id, 1);
      const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
      assert.equal(details.name, t.name);
      assert.ok(details.rows.agent_devices >= 1);
    } finally {
      for (const [m, fn] of Object.entries(saved)) proto[m] = fn;
    }
  });

  lotIt('W12-2', '90.6 deletion and member role writes ask for a step-up', async () => {
    const admin = await h.as('admin');
    const t = await newTenant(admin);
    const fresh = await h.login('admin');
    const r = await fresh.rawRequest('DELETE', `/api/tenants/${t.id}`, { body: { confirmName: t.name } });
    assert.equal(r.status, 401, r.text);
    assert.equal(r.json?.code, 'TWO_FACTOR_REQUIRED');
    assert.equal(r.json?.action, 'tenant.delete');
    assert.ok(await h.db('tenants').where({ id: t.id }).first());

    const u = await createUser(h.db, { tenants: [] });
    const add = await fresh.rawRequest('POST', `/api/tenants/${t.id}/members`, { body: { userId: u.id, role: 'user' } });
    assert.equal(add.status, 401, add.text);
    assert.equal(add.json?.action, 'users.role');
    assert.equal(await h.db('user_tenants').where({ user_id: u.id, tenant_id: t.id }).first(), undefined);
    const put = await fresh.rawRequest('PUT', `/api/tenants/${t.id}/members/${u.id}`, { body: { role: 'admin' } });
    assert.equal(put.status, 401, put.text);

    // Confirmed (auto step-up of the harness client): both go through.
    assert.equal((await fresh.post(`/api/tenants/${t.id}/members`, { userId: u.id, role: 'user' })).status, 200);
    assert.equal((await fresh.del(`/api/tenants/${t.id}`, { confirmName: t.name })).status, 200);
    assert.equal(await h.db('tenants').where({ id: t.id }).first(), undefined);
  });

  lotIt('W12-2', "90.7 policy 'uninstall' uninstalls the connected agents and deletes at once", async () => {
    tenantDeleteConfig.agentPolicy = 'uninstall';
    const admin = await h.as('admin');
    const t = await newTenant(admin);
    const key = await createKey(h.db, t.id);
    const on = await createDevice(h.db, { tenantId: t.id, keyId: key.id, status: 'approved' });
    await createDevice(h.db, { tenantId: t.id, keyId: key.id, status: 'approved' });
    const ws = await live(on.uuid, t.id, key.id);

    const r = await admin.del(`/api/tenants/${t.id}`, { confirmName: t.name });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.data.uninstall, { queued: 2, delivered: 1 });
    assert.ok(ws.sent.some((f) => f.type === 'config' && f.command === 'uninstall'));
    await waitFor(() => ws.closed?.code === 4003, 1000);
    assert.deepEqual(await leftovers(t.id), []);
  });

  lotIt('W12-2', '90.8 agents gone between the gate and the handler: the step-up is still asked', async () => {
    const admin = await h.as('admin');
    const t = await newTenant(admin);
    // The gate's read sees one agent (no prompt), the handler's read sees none.
    const real = tenantService.agentSummary.bind(tenantService);
    let calls = 0;
    tenantService.agentSummary = async (id: number) => {
      const s = await real(id);
      return calls++ === 0 ? { ...s, approved: 1, total: 1 } : s;
    };
    try {
      const fresh = await h.login('admin');
      const r = await fresh.rawRequest('DELETE', `/api/tenants/${t.id}`, { body: { confirmName: t.name } });
      assert.equal(r.status, 401, r.text);
      assert.equal(r.json?.code, 'TWO_FACTOR_REQUIRED');
      assert.equal(r.json?.action, 'tenant.delete');
      assert.ok(await h.db('tenants').where({ id: t.id }).first());
    } finally {
      tenantService.agentSummary = real;
    }
    assert.equal((await admin.del(`/api/tenants/${t.id}`, { confirmName: t.name })).status, 200);
  });
});
