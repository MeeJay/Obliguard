/**
 * 99 — W14-1 agent command queue with ack, result and history (FLEET-AGENT-11).
 *
 *   99.1 a command queued while the agent is offline is delivered as a
 *        'command' frame on connect; command_ack moves it to acked then
 *        succeeded (result kept), a late ack never reopens it; the history
 *        and the audit row follow;
 *   99.2 a connected agent gets a new command at once; firewall_resync
 *        carries the full ban list; the heartbeat drains what its fresh
 *        'cmdqueue' capability allows (after the config frame);
 *   99.3 an agent without 'cmdqueue' (deployed builds) still gets the
 *        uninstall in the config frame, on connect and through HTTP push
 *        (legacy history row); restart / resync are refused for it (409);
 *   99.4 a second uninstall is refused while one is outstanding (409), on
 *        the queue route and the legacy /command route;
 *   99.5 capabilities and scope: uninstall → agents.delete, restart →
 *        agents.manage, update → the update policy ('off' → 409); another
 *        tenant's agent is refused; any reader of the agent reads the history;
 *   99.6 acks from another device are ignored; the sweep expires undelivered
 *        commands and fails the ones that never reported.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, FakeWs, waitFor } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice, insertBan, VIEWER_B } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';
import { agentCommandService, RESULT_TIMEOUT_MS } from '../../src/services/agentCommand.service';
import { __setServedAgentVersionForTest } from '../../src/services/agent.service';

type Row = Record<string, any>;

describe('99 agent command queue (W14-1)', () => {
  let h: Harness;
  const sockets: FakeWs[] = [];

  before(async () => { h = await startHarness(); });
  after(async () => {
    for (const ws of sockets) ws.close();
    __setServedAgentVersionForTest(undefined);
    await h.close();
  });

  const admin = () => h.adminIn(2);
  const newDevice = async (opts: { cmdqueue?: boolean; tenantId?: number; keyId?: number } = {}) => {
    const d = await createDevice(h.db, { tenantId: opts.tenantId ?? 2, keyId: opts.keyId ?? 2 });
    if (opts.cmdqueue) {
      await h.db('agent_devices').where({ id: d.id }).update({ capabilities: JSON.stringify(['update_status', 'cmdqueue']) });
    }
    return d;
  };
  const connect = async (uuid: string, tenantId = 2, keyId = 2) => {
    const ws = new FakeWs();
    sockets.push(ws);
    assert.equal(await obliguardHub.register(uuid, tenantId, keyId, '127.0.0.1', ws as any), true);
    return ws;
  };
  const heartbeat = (hostname: string, capabilities?: string[]) => ({
    type: 'heartbeat', hostname, agentVersion: '1.0.0',
    osInfo: { platform: 'linux', distro: 'v', release: '1', arch: 'amd64' },
    services: [], firewallBanned: [], firewallName: 'verify', lanIPs: [],
    ...(capabilities ? { capabilities } : {}),
  });
  const cmdRow = async (id: number) => await h.db('agent_commands').where({ id }).first() as Row;
  const devRow = async (id: number) => await h.db('agent_devices').where({ id }).first() as Row;
  const commandFrames = (ws: FakeWs) => ws.sent.filter((f) => f?.type === 'command');

  lotIt('W14-1', '99.1 queued while offline, delivered on connect, ack updates status, history + audit', async () => {
    const d = await newDevice({ cmdqueue: true });
    const c = await admin();

    const r = await c.post(`/api/agent/devices/${d.id}/commands`, { type: 'restart' });
    assert.equal(r.status, 201, r.text);
    const cmd = r.json.data;
    assert.equal(cmd.type, 'restart');
    assert.equal(cmd.status, 'queued', 'offline: stays queued');
    assert.equal(cmd.deviceId, d.id);
    assert.ok(cmd.expiresAt, 'restart expires');

    const ws = await connect(d.uuid);
    assert.deepEqual(commandFrames(ws), [{ type: 'command', id: String(cmd.id), command: 'restart', payload: {} }]);
    let row = await cmdRow(cmd.id);
    assert.equal(row.status, 'sent');
    assert.ok(row.sent_at);

    ws.receive({ type: 'command_ack', id: String(cmd.id), status: 'acked' });
    await waitFor(async () => (await cmdRow(cmd.id)).status === 'acked');
    ws.receive({ type: 'command_ack', id: String(cmd.id), status: 'succeeded', result: { message: 'agent restarting' } });
    row = await waitFor(async () => { const x = await cmdRow(cmd.id); return x.status === 'succeeded' ? x : null; });
    assert.ok(row.acked_at && row.finished_at);
    assert.deepEqual(row.result, { message: 'agent restarting' });

    // A late ack never reopens a finished command.
    ws.receive({ type: 'command_ack', id: String(cmd.id), status: 'failed', result: { error: 'late' } });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal((await cmdRow(cmd.id)).status, 'succeeded');

    // Nothing delivered twice on reconnect.
    const again = await connect(d.uuid);
    assert.equal(commandFrames(again).length, 0);

    const list = await c.get(`/api/agent/devices/${d.id}/commands`);
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.data[0].id, cmd.id);
    assert.equal(list.json.data[0].status, 'succeeded');
    assert.ok(list.json.data[0].createdByName, 'requester name');

    const audit = await h.db('audit_logs').where({ device_id: d.id, action: 'agent.command_sent' }).first() as Row | undefined;
    assert.ok(audit, 'the request is audited with the device id');
    assert.equal(audit.details.command, 'restart');
    assert.equal(Number(audit.details.commandId), cmd.id);
  });

  lotIt('W14-1', '99.2 connected agents get commands at once; resync carries the ban list; heartbeat drains', async () => {
    const d = await newDevice({ cmdqueue: true });
    const ws = await connect(d.uuid);
    const banIp = '203.0.113.199';
    await insertBan(h.db, { ip: banIp, scope: 'global' });

    const r = await (await admin()).post(`/api/agent/devices/${d.id}/commands`, { type: 'firewall_resync' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.data.status, 'sent', 'delivered during the request');
    const [frame] = commandFrames(ws);
    assert.equal(frame?.command, 'firewall_resync');
    assert.ok(Array.isArray(frame.payload.bans), 'full ban list in the payload');
    assert.ok(frame.payload.bans.includes(banIp));
    assert.equal(frame.id, String(r.json.data.id));

    // Stored capabilities say legacy: nothing but an uninstall on connect;
    // the heartbeat advertising cmdqueue then gets the queued command.
    const legacy = await newDevice();
    const [rowId] = (await h.db('agent_commands').insert({
      device_id: legacy.id, tenant_id: 2, type: 'restart', status: 'queued',
    }).returning('id')).map((x: { id: number } | number) => (typeof x === 'object' ? x.id : x));
    const lws = await connect(legacy.uuid);
    assert.equal(lws.sent.length, 0);
    lws.receive(heartbeat(legacy.hostname, ['update_status', 'cmdqueue']));
    await waitFor(() => commandFrames(lws).length === 1, 3000);
    const cfgIdx = lws.sent.findIndex((f) => f.type === 'config');
    const cmdIdx = lws.sent.findIndex((f) => f.type === 'command');
    assert.ok(cfgIdx >= 0 && cfgIdx < cmdIdx, 'command after the config frame');
    assert.equal(lws.sent[cmdIdx].id, String(rowId));
    assert.equal((await cmdRow(Number(rowId))).status, 'sent');
  });

  lotIt('W14-1', '99.3 legacy agent still gets uninstall in the config frame; restart refused for it', async () => {
    const c = await admin();
    const d = await newDevice();
    const r = await c.post(`/api/agent/devices/${d.id}/commands`, { type: 'uninstall' });
    assert.equal(r.status, 201, r.text);
    assert.equal((await devRow(d.id)).pending_command, 'uninstall', 'legacy fallback kept');

    const ws = await connect(d.uuid);
    assert.deepEqual(ws.sent, [{ type: 'config', command: 'uninstall' }]);
    const row = await cmdRow(r.json.data.id);
    assert.equal(row.status, 'sent');
    assert.equal(row.legacy, true);
    assert.ok(row.finished_at, 'no ack possible: closed at delivery');
    const dev = await devRow(d.id);
    assert.equal(dev.pending_command, null);
    assert.ok(dev.uninstall_commanded_at);

    // HTTP push path (handlePush) of a legacy agent.
    const p = await newDevice();
    assert.equal((await c.post(`/api/agent/devices/${p.id}/command`, { command: 'uninstall' })).status, 200);
    const push = await h.push(2, p.uuid, { hostname: p.hostname, agentVersion: '1.0.0', events: [] });
    assert.equal(push.status, 200, push.text);
    assert.equal(push.json.command, 'uninstall');
    const pr = await h.db('agent_commands').where({ device_id: p.id }).first() as Row;
    assert.equal(pr.status, 'sent');
    assert.equal(pr.legacy, true);
    assert.equal((await devRow(p.id)).pending_command, null);

    // A pending_command set elsewhere (tenant deletion) gets its history row.
    const t = await newDevice();
    await h.db('agent_devices').where({ id: t.id }).update({ pending_command: 'uninstall' });
    const tws = await connect(t.uuid);
    assert.deepEqual(tws.sent, [{ type: 'config', command: 'uninstall' }]);
    assert.equal((await h.db('agent_commands').where({ device_id: t.id, type: 'uninstall' })).length, 1);

    // Restart / resync need the cmdqueue capability.
    const old = await newDevice();
    for (const type of ['restart', 'firewall_resync']) {
      const x = await c.post(`/api/agent/devices/${old.id}/commands`, { type });
      assert.equal(x.status, 409, x.text);
      assert.equal(x.json.code, 'commandUnsupported');
    }
    assert.equal((await h.db('agent_commands').where({ device_id: old.id })).length, 0);
  });

  lotIt('W14-1', '99.4 a second uninstall is refused while one is outstanding', async () => {
    const c = await admin();
    const d = await newDevice({ cmdqueue: true });
    assert.equal((await c.post(`/api/agent/devices/${d.id}/commands`, { type: 'uninstall' })).status, 201);
    const second = await c.post(`/api/agent/devices/${d.id}/commands`, { type: 'uninstall' });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.json.code, 'commandOutstanding');
    const legacyRoute = await c.post(`/api/agent/devices/${d.id}/command`, { command: 'uninstall' });
    assert.equal(legacyRoute.status, 409, legacyRoute.text);
    assert.equal((await h.db('agent_commands').where({ device_id: d.id, type: 'uninstall' })).length, 1);

    // Delivered and acknowledged: still outstanding until its final result.
    const ws = await connect(d.uuid);
    const [frame] = commandFrames(ws);
    assert.equal(frame.command, 'uninstall');
    assert.ok((await devRow(d.id)).uninstall_commanded_at);
    ws.receive({ type: 'command_ack', id: frame.id, status: 'acked' });
    await waitFor(async () => (await cmdRow(Number(frame.id))).status === 'acked');
    assert.equal((await c.post(`/api/agent/devices/${d.id}/commands`, { type: 'uninstall' })).status, 409);

    // The agent could not start its removal: not deleted by the cleanup job,
    // and a new uninstall may be requested.
    ws.receive({ type: 'command_ack', id: frame.id, status: 'failed', result: { error: 'uninstall: script write failed' } });
    await waitFor(async () => (await cmdRow(Number(frame.id))).status === 'failed');
    assert.equal((await devRow(d.id)).uninstall_commanded_at, null);
    assert.equal((await c.post(`/api/agent/devices/${d.id}/commands`, { type: 'uninstall' })).status, 201);

    // Other types are independent; a finished one can be requested again.
    const r1 = await c.post(`/api/agent/devices/${d.id}/commands`, { type: 'restart' });
    assert.equal(r1.status, 201, r1.text);
    ws.receive({ type: 'command_ack', id: String(r1.json.data.id), status: 'failed', result: { error: 'no service manager' } });
    await waitFor(async () => (await cmdRow(r1.json.data.id)).status === 'failed');
    assert.equal((await c.post(`/api/agent/devices/${d.id}/commands`, { type: 'restart' })).status, 201);
  });

  lotIt('W14-1', '99.5 capabilities, tenant scope, update policy', async () => {
    const d = await newDevice({ cmdqueue: true });
    const member = await h.as('member_b'); // 'user' set: agents.manage, not agents.delete
    const viewer = await h.as(VIEWER_B.username);

    assert.equal((await member.post(`/api/agent/devices/${d.id}/commands`, { type: 'uninstall' })).status, 403);
    assert.equal((await viewer.post(`/api/agent/devices/${d.id}/commands`, { type: 'restart' })).status, 403);
    assert.equal((await member.post(`/api/agent/devices/${d.id}/commands`, { type: 'restart' })).status, 201);
    assert.equal((await member.post(`/api/agent/devices/${d.id}/commands`, { type: 'bogus' })).status, 400);
    assert.equal((await h.db('agent_commands').where({ device_id: d.id, type: 'uninstall' })).length, 0);

    const hist = await viewer.get(`/api/agent/devices/${d.id}/commands`);
    assert.equal(hist.status, 200, hist.text);
    assert.equal(hist.json.data.length, 1);

    // Another tenant's agent: refused, nothing queued.
    const foreign = await newDevice({ cmdqueue: true, tenantId: 3, keyId: 3 });
    const fr = await (await admin()).post(`/api/agent/devices/${foreign.id}/commands`, { type: 'restart' });
    assert.ok(fr.status === 403 || fr.status === 404, `foreign: ${fr.status}`);
    assert.equal((await member.get(`/api/agent/devices/${foreign.id}/commands`)).status, 404);
    assert.equal((await h.db('agent_commands').where({ device_id: foreign.id })).length, 0);

    // 'update' is an update request: the policy decides (off → refused).
    __setServedAgentVersionForTest('9.9.9');
    await h.db('agent_devices').where({ id: d.id }).update({ update_policy: 'off' });
    const off = await (await admin()).post(`/api/agent/devices/${d.id}/commands`, { type: 'update' });
    assert.equal(off.status, 409, off.text);
    assert.equal(off.json.code, 'updatePolicyOff');
    assert.equal((await viewer.post(`/api/agent/devices/${d.id}/commands`, { type: 'update' })).status, 403, 'agents.update');
  });

  lotIt('W14-1', '99.6 foreign acks ignored; sweep expires undelivered and fails silent commands', async () => {
    const a = await newDevice({ cmdqueue: true });
    const b = await newDevice({ cmdqueue: true });
    const r = await (await admin()).post(`/api/agent/devices/${a.id}/commands`, { type: 'restart' });
    assert.equal(r.status, 201);
    const wa = await connect(a.uuid);
    const wb = await connect(b.uuid);
    assert.equal(commandFrames(wa).length, 1);
    wb.receive({ type: 'command_ack', id: String(r.json.data.id), status: 'succeeded' });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal((await cmdRow(r.json.data.id)).status, 'sent', 'ack of another device ignored');

    // Undelivered past its deadline: expired, never sent afterwards.
    const c = await newDevice({ cmdqueue: true });
    const past = new Date(Date.now() - 60_000);
    const [exp] = await h.db('agent_commands').insert({
      device_id: c.id, tenant_id: 2, type: 'firewall_resync', status: 'queued', expires_at: past,
    }).returning('id');
    const expId = typeof exp === 'object' ? (exp as { id: number }).id : exp;
    const wc = await connect(c.uuid);
    assert.equal(commandFrames(wc).length, 0, 'expired commands are not delivered');
    assert.equal((await cmdRow(Number(expId))).status, 'expired');

    // Delivered, never answered: failed by the sweep.
    const later = new Date(Date.now() + RESULT_TIMEOUT_MS + 60_000);
    const closed = await agentCommandService.sweep(later);
    assert.ok(closed >= 1);
    const silent = await cmdRow(r.json.data.id);
    assert.equal(silent.status, 'failed');
    assert.ok(silent.result?.error);
  });
});
