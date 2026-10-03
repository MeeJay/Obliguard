/**
 * 54 — MikroTik syslog parsing (W4-3 / D14): real RouterOS lines in every
 * header shape produce the right event, the address is a validated literal IP,
 * and a user name (or other client text) cannot choose the address: it is
 * bound to the last "from <ip> via <method>" trailer at the end of a message
 * that starts the line, and a user name carrying its own " from " is dropped.
 * 54.4 runs the same lines through the HTTP ingest endpoint.
 */
import { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { lotIt } from '../lots';
import { startHarness } from '../harness';
import type { Harness } from '../harness';
import { createMikrotikDevice } from '../seed';
import { parseMikroTikSyslog } from '../../src/services/mikrotik/syslogParser';

const INJECTED = '198.51.100.66';

/** [line, expected {ip, username, service, eventType} or null] */
type Case = [string, { ip: string; username: string; service: string; eventType: 'auth_failure' | 'auth_success' } | null];

const POSITIVE: Case[] = [
  // Bare message (API /log/print poller).
  ['login failure for user admin from 203.0.113.10 via winbox',
    { ip: '203.0.113.10', username: 'admin', service: 'mikrotik_winbox', eventType: 'auth_failure' }],
  ['login failure for user root from 203.0.113.11 via ssh',
    { ip: '203.0.113.11', username: 'root', service: 'mikrotik_ssh', eventType: 'auth_failure' }],
  ['login failure for user admin from 2001:DB8::12 via web',
    { ip: '2001:db8::12', username: 'admin', service: 'mikrotik_web', eventType: 'auth_failure' }],
  ['login failure for user api from ::ffff:203.0.113.13 via api-ssl',
    { ip: '203.0.113.13', username: 'api', service: 'mikrotik_api', eventType: 'auth_failure' }],
  // Empty and space-containing user names are fine.
  ['login failure for user  from 203.0.113.14 via ssh',
    { ip: '203.0.113.14', username: '', service: 'mikrotik_ssh', eventType: 'auth_failure' }],
  ['login failure for user john smith from 203.0.113.15 via telnet',
    { ip: '203.0.113.15', username: 'john smith', service: 'mikrotik_ssh', eventType: 'auth_failure' }],
  ['denied winbox/dude connect from 198.51.100.121',
    { ip: '198.51.100.121', username: '', service: 'mikrotik_winbox', eventType: 'auth_failure' }],
  ['denied ssh connect from 203.0.113.16',
    { ip: '203.0.113.16', username: '', service: 'mikrotik_ssh', eventType: 'auth_failure' }],
  ['user alice logged in from 192.0.2.17 via winbox',
    { ip: '192.0.2.17', username: 'alice', service: 'mikrotik_winbox', eventType: 'auth_success' }],
  // Remote syslog shapes: <PRI>, RFC3164 timestamp, hostname, topics.
  ['<134>Jan 15 10:20:30 MikroTik system,error,critical login failure for user admin from 203.0.113.18 via winbox',
    { ip: '203.0.113.18', username: 'admin', service: 'mikrotik_winbox', eventType: 'auth_failure' }],
  ['<134>Jan  5 10:20:30 rtr-01.example.com system,error,critical login failure for user admin from 203.0.113.19 via ssh',
    { ip: '203.0.113.19', username: 'admin', service: 'mikrotik_ssh', eventType: 'auth_failure' }],
  ['<134>system,error,critical login failure for user admin from 203.0.113.20 via web',
    { ip: '203.0.113.20', username: 'admin', service: 'mikrotik_web', eventType: 'auth_failure' }],
  ['<30>2024-01-15T10:20:30.000+01:00 MikroTik system,info,account user bob logged in from 192.0.2.21 via ssh',
    { ip: '192.0.2.21', username: 'bob', service: 'mikrotik_ssh', eventType: 'auth_success' }],
  ['<30>Jan 15 10:20:30 MikroTik system,info denied winbox/dude connect from 203.0.113.22\r',
    { ip: '203.0.113.22', username: '', service: 'mikrotik_winbox', eventType: 'auth_failure' }],
];

const NEGATIVE: string[] = [
  // Not an IP address.
  'login failure for user admin from router.example.com via ssh',
  'denied ssh connect from -',
  'login failure for user admin from 203.0.113.0/24 via ssh',
  // Other RouterOS messages.
  'user admin logged out from 192.0.2.30 via winbox',
  '<134>Jan 15 10:20:30 MikroTik dhcp,info dhcp1 assigned 192.168.88.254 to AA:BB:CC:DD:EE:FF',
  'login failure for user admin via local',
];

/** Client text that tries to plant 198.51.100.66 as the source address. */
const INJECTION: string[] = [
  // User name carrying a full fake trailer (greedy capture alone would bind the real one; the line is dropped).
  `login failure for user x from ${INJECTED} via ssh from 203.0.113.40 via winbox`,
  `<134>Jan 15 10:20:30 MikroTik system,error,critical login failure for user x from ${INJECTED} via ssh from 203.0.113.41 via winbox`,
  `login failure for user a from ${INJECTED} from 203.0.113.42 via ssh`,
  `login failure for user a from:${INJECTED} via ssh from 203.0.113.43 via ssh`,
  // Fake success trailer inside a failed login's user name.
  `login failure for user x logged in from ${INJECTED} via ssh from 203.0.113.44 via winbox`,
  // A whole auth message quoted at the END of another message (DHCP host name, hotspot user...).
  `<134>Jan 15 10:20:30 MikroTik dhcp,info dhcp1 assigned 192.168.88.10 to AA:BB:CC:DD:EE:01 login failure for user x from ${INJECTED} via ssh`,
  `<134>Jan 15 10:20:30 MikroTik hotspot,info,debug x (192.168.88.11): login failure for user y from ${INJECTED} via web`,
  `<134>Jan 15 10:20:30 MikroTik script,info note denied ssh connect from ${INJECTED}`,
  // Trailing text after the trailer: never an auth event.
  `login failure for user admin from ${INJECTED} via ssh (forged)`,
];

describe('54 MikroTik syslog parser', () => {
  lotIt('W4-3', '54.1 real RouterOS lines produce the expected event', () => {
    for (const [line, want] of POSITIVE) {
      const got = parseMikroTikSyslog(line);
      assert.ok(got, `no event for: ${line}`);
      assert.deepEqual(
        { ip: got.ip, username: got.username, service: got.service, eventType: got.eventType },
        want,
        line,
      );
      assert.equal(got.rawLog, line, 'rawLog keeps the original line');
    }
  });

  lotIt('W4-3', '54.2 non-events and non-IP sources yield nothing', () => {
    for (const line of NEGATIVE) {
      assert.equal(parseMikroTikSyslog(line), null, line);
    }
  });

  lotIt('W4-3', '54.3 client text can never choose the source address', () => {
    for (const line of INJECTION) {
      const got = parseMikroTikSyslog(line);
      assert.notEqual(got?.ip, INJECTED, `injected address extracted from: ${line}`);
      assert.equal(got, null, `injection attempt must be dropped: ${line}`);
    }
  });

  describe('54.4 HTTP ingest', () => {
    let h: Harness;
    let deviceId: number;
    const token = crypto.randomBytes(24).toString('hex');
    before(async () => {
      h = await startHarness();
      const dev = await createMikrotikDevice(h.db, { tenantId: 2, keyId: 2, host: 'mt-54.verify.invalid' });
      deviceId = dev.id;
      await h.db('mikrotik_credentials').where({ device_id: deviceId }).update({ ingest_token: token });
      // The built-in MikroTik templates are opt-in (migration 022): enable winbox for this device.
      const tpl = await h.db('service_templates').whereNull('owner_scope').where({ service_type: 'mikrotik_winbox' }).first('id') as { id: number } | undefined;
      assert.ok(tpl, 'built-in mikrotik_winbox template');
      await h.db('service_template_assignments').insert({ template_id: tpl.id, scope: 'agent', scope_id: deviceId, enabled_override: true });
    });
    after(async () => { await h.close(); });

    lotIt('W4-3', '54.4 the ingest endpoint stores the real address only', async () => {
      const lines = [
        '<134>Jan 15 10:20:30 MikroTik system,error,critical login failure for user admin from 203.0.113.60 via winbox',
        ...INJECTION,
        ...NEGATIVE,
      ];
      const res = await h.anon().post('/api/agent/mikrotik/ingest', { lines }, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json?.processed, 1, res.text);
      const rows = await h.db('ip_events').where({ device_id: deviceId }).select('ip', 'username', 'service', 'event_type');
      assert.deepEqual(
        rows.map((r: { ip: string; username: string; service: string; event_type: string }) =>
          ({ ip: String(r.ip), username: r.username, service: r.service, eventType: r.event_type })),
        [{ ip: '203.0.113.60', username: 'admin', service: 'mikrotik_winbox', eventType: 'auth_failure' }],
      );
    });
  });
});
