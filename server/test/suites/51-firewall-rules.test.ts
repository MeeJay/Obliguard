/**
 * 51 — W3-3 (SECURITY-PARITY-21): firewall rule writes are validated and the
 * agent payload is rebuilt from the parsed fields only. A protocol, port or
 * remote IP carrying extra nft / firewalld tokens is a 400 and never reaches
 * the agent; a valid rule is forwarded with known keys and canonical values.
 */
import { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, FakeWs } from '../harness';
import type { Harness } from '../harness';
import { lotIt } from '../lots';
import { createDevice } from '../seed';
import { obliguardHub } from '../../src/services/obliguardHub.service';

/** A FakeWs that answers firewall commands like an agent. */
class FirewallAgent extends FakeWs {
  send(d: unknown): void {
    super.send(d);
    const m = JSON.parse(String(d));
    if (typeof m?.type === 'string' && m.type.startsWith('firewall_')) {
      setImmediate(() => this.receive({ type: 'firewall_response', id: m.id, success: true, rules: [] }));
    }
  }

  /** The firewall command frames received so far. */
  commands(): Array<{ type: string; id: string; payload: Record<string, unknown> }> {
    return this.sent.filter((m) => typeof m?.type === 'string' && m.type.startsWith('firewall_'));
  }
}

describe('51 firewall rules (W3-3)', () => {
  let h: Harness;
  const fakes: FakeWs[] = [];
  before(async () => { h = await startHarness({ obligate: true }); });
  after(async () => { await h.close(); });
  afterEach(() => { for (const f of fakes.splice(0)) { try { f.close(); } catch { /* ignore */ } } });

  async function connectedDevice(capabilities: string[] = []): Promise<{ id: number; agent: FirewallAgent }> {
    const t = await createDevice(h.db, { tenantId: 2, keyId: 2 });
    if (capabilities.length) {
      await h.db('agent_devices').where({ id: t.id }).update({ capabilities: JSON.stringify(capabilities) });
    }
    const agent = new FirewallAgent();
    fakes.push(agent);
    await obliguardHub.register(t.uuid, 2, 2, '127.0.0.1', agent as any);
    return { id: t.id, agent };
  }

  const base = { direction: 'in', action: 'block', protocol: 'tcp', localPort: '22' };

  lotIt('W3-3', '51.1 injected nft/firewalld tokens are a 400 and never reach the agent', async () => {
    const { id, agent } = await connectedDevice();
    const c = await h.adminIn(2);
    const bad: Array<Record<string, unknown>> = [
      { ...base, protocol: 'tcp accept' },
      { ...base, remoteIp: '1.2.3.4 accept' },
      { ...base, remoteIp: '0.0.0.0/0 accept' },
      { ...base, remoteIp: '1.2.3.4\naccept' },
      { ...base, remoteIp: 'example.com' },
      { ...base, localPort: '22 accept' },
      { ...base, localPort: '{ 22, 80 }' },
      { ...base, localPort: '70000' },
      { ...base, localPort: '90-80' },
      { ...base, remotePort: '53 counter accept' },
      { ...base, protocol: 'any' },
      { ...base, protocol: 'icmp' },
      { ...base, protocol: ['tcp'] },
      { ...base, direction: 'in out' },
      { ...base, action: 'accept' },
      { ...base, name: 'x" dir=out action=allow' },
      { ...base, name: 'x dir=out' },
      { ...base, name: 'Obliguard-Block-in' },
      { ...base, name: 'all' },
      { ...base, name: 'a'.repeat(65) },
      { direction: 'in', action: 'block' },
      {},
    ];
    for (const body of bad) {
      const r = await c.post(`/api/agent/devices/${id}/firewall/rules`, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`);
      assert.equal(r.json?.success, false);
      assert.equal(typeof r.json?.error, 'string');
    }
    assert.deepEqual(agent.commands(), []);
  });

  lotIt('W3-3', '51.2 a valid rule is forwarded with known keys and canonical values only', async () => {
    const { id, agent } = await connectedDevice();
    const c = await h.adminIn(2);
    const r = await c.post(`/api/agent/devices/${id}/firewall/rules`, {
      name: 'Block SSH', direction: 'in', action: 'block', protocol: 'tcp',
      localPort: '22', remoteIp: '10.1.2.3/24', description: 'note', extra: 'tcp accept', __proto__x: 1,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json?.data?.success, true);
    const cmds = agent.commands();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].type, 'firewall_add');
    assert.deepEqual(cmds[0].payload, {
      name: 'Block SSH', direction: 'in', action: 'block', protocol: 'tcp', localPort: '22', remoteIp: '10.1.2.0/24',
    });

    // "any" / empty fields are dropped; a degenerate range collapses; IPv4-mapped IPv6 becomes IPv4.
    const r2 = await c.post(`/api/agent/devices/${id}/firewall/rules`, {
      name: '', direction: 'out', action: 'allow', protocol: 'udp', localPort: '5000-5000', remoteIp: '::ffff:1.2.3.4',
    });
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    assert.deepEqual(agent.commands()[1].payload, {
      direction: 'out', action: 'allow', protocol: 'udp', localPort: '5000', remoteIp: '1.2.3.4',
    });
    const r3 = await c.post(`/api/agent/devices/${id}/firewall/rules`, {
      direction: 'in', action: 'allow', protocol: 'any', localPort: 'any', remoteIp: 'any',
    });
    assert.equal(r3.status, 200, JSON.stringify(r3.json));
    assert.deepEqual(agent.commands()[2].payload, { direction: 'in', action: 'allow', protocol: 'any' });
  });

  lotIt('W3-3', '51.3 block rules obey the prefix floor, allow rules do not', async () => {
    const { id, agent } = await connectedDevice();
    const c = await h.adminIn(2);
    const wide = await c.post(`/api/agent/devices/${id}/firewall/rules`, { direction: 'in', action: 'block', protocol: 'any', remoteIp: '0.0.0.0/0' });
    assert.equal(wide.status, 400);
    assert.match(wide.json?.error ?? '', /remoteIp/);
    assert.equal((await c.post(`/api/agent/devices/${id}/firewall/rules`, { direction: 'in', action: 'block', protocol: 'any', remoteIp: '2001:db8::/16' })).status, 400);
    assert.deepEqual(agent.commands(), []);
    const allow = await c.post(`/api/agent/devices/${id}/firewall/rules`, { direction: 'in', action: 'allow', protocol: 'any', remoteIp: '10.0.0.0/8' });
    assert.equal(allow.status, 200, JSON.stringify(allow.json));
    assert.equal(agent.commands()[0].payload.remoteIp, '10.0.0.0/8');
  });

  lotIt('W3-3', '51.4 a remote port is only sent to agents that report fw_remote_port', async () => {
    const body = { ...base, remotePort: '1000-2000' };
    const old = await connectedDevice();
    const c = await h.adminIn(2);
    const r = await c.post(`/api/agent/devices/${old.id}/firewall/rules`, body);
    assert.equal(r.status, 409);
    assert.deepEqual(old.agent.commands(), []);

    const cur = await connectedDevice(['update_status', 'fw_remote_port']);
    const r2 = await c.post(`/api/agent/devices/${cur.id}/firewall/rules`, body);
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    assert.deepEqual(cur.agent.commands()[0].payload, { ...base, remotePort: '1000-2000' });
  });

  lotIt('W3-3', '51.5 delete/toggle validate the rule id and the enabled flag', async () => {
    const { id, agent } = await connectedDevice();
    const c = await h.adminIn(2);
    const url = (ruleId: string) => `/api/agent/devices/${id}/firewall/rules/${encodeURIComponent(ruleId)}`;

    for (const ruleId of ['x"y', 'a\nb', 'a\\b', '-F', 'Obliguard-Block-in::in', 'all', 'x'.repeat(257)]) {
      assert.equal((await c.del(url(ruleId))).status, 400, `DELETE ${JSON.stringify(ruleId)}`);
      assert.equal((await c.patch(url(ruleId), { enabled: false })).status, 400, `PATCH ${JSON.stringify(ruleId)}`);
    }
    for (const body of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }]) {
      assert.equal((await c.patch(url('Rule::in'), body)).status, 400, `PATCH ${JSON.stringify(body)}`);
    }
    assert.deepEqual(agent.commands(), []);

    const ids = ['inet:filter:input:12', 'ipt:INPUT:3', 'port:8000-8100/tcp', 'Remote Desktop - User Mode (TCP-In)::in'];
    for (const ruleId of ids) {
      assert.equal((await c.del(url(ruleId))).status, 200, `DELETE ${ruleId}`);
    }
    const t = await c.patch(url('Remote Desktop - User Mode (TCP-In)::in'), { enabled: false, extra: 'x' });
    assert.equal(t.status, 200);
    const cmds = agent.commands();
    assert.deepEqual(cmds.slice(0, ids.length).map((m) => [m.type, m.payload]), ids.map((ruleId) => ['firewall_delete', { ruleId }]));
    assert.equal(cmds[ids.length].type, 'firewall_toggle');
    assert.deepEqual(cmds[ids.length].payload, { ruleId: 'Remote Desktop - User Mode (TCP-In)::in', enabled: false });
  });

  lotIt('W3-3', '51.6 access is checked before validation (god view stays a 403)', async () => {
    const { id, agent } = await connectedDevice();
    const god = await h.adminIn(1);
    assert.equal((await god.post(`/api/agent/devices/${id}/firewall/rules`, { ...base, protocol: 'tcp accept' })).status, 403);
    assert.equal((await god.del(`/api/agent/devices/${id}/firewall/rules/${encodeURIComponent('x"y')}`)).status, 403);
    assert.equal((await (await h.adminIn(3)).post(`/api/agent/devices/${id}/firewall/rules`, base)).status, 404);
    assert.deepEqual(agent.commands(), []);
  });
});
