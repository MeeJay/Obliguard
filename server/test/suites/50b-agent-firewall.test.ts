/**
 * 50b — W3-2 Go agent firewall (agent side of BROKEN-4 / D9 / D10):
 *   - one file per backend (nftables, iptables/ipset, ufw, firewalld, netsh,
 *     pf); backends run commands through the shared runner (discrete argv);
 *   - native CIDR: nft interval sets (no auto-merge), ipset hash:net,
 *     firewalld hash:net set, netsh remoteip / pf tables; firewallBanned in
 *     the server's textual form (bare host for /32-/128, a.b.c.d/nn else);
 *   - agent/bansafety.go filters every add list (floors /16 and /48, reserved
 *     ranges, server / own / gateway addresses) and mirrors
 *     server/src/utils/ipValidation.ts;
 *   - the heartbeat advertises the 'cidr' capability.
 * The behaviour is covered by agent/firewall_test.go and
 * agent/bansafety_test.go, run here when a Go toolchain is available.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { lotIt } from '../lots';
import { DEFAULT_BAN_MIN_PREFIX_V4, DEFAULT_BAN_MIN_PREFIX_V6, RESERVED_BAN_RANGES } from '../../src/utils/ipValidation';

const REPO = path.resolve(__dirname, '..', '..', '..');
const AGENT = path.join(REPO, 'agent');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const BACKENDS: Record<string, string[]> = {
  'firewall_nftables.go': ['NftablesFirewall'],
  'firewall_iptables.go': ['IptablesFirewall'],
  'firewall_ufw.go': ['UFWFirewall'],
  'firewall_firewalld.go': ['FirewalldFirewall'],
  'firewall_netsh.go': ['WindowsFirewall'],
  'firewall_pf.go': ['PFFirewall', 'FreeBSDPFFirewall'],
};

function goAvailable(): boolean {
  return spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;
}

describe('50b agent firewall backends, CIDR and ban safety (W3-2)', () => {
  lotIt('W3-2', '50b.1 one file per backend, commands through the shared runner', () => {
    const shared = read('agent/firewall.go');
    assert.match(shared, /type FirewallManager interface/);
    assert.match(shared, /func DetectFirewall\(\)/);
    assert.match(shared, /var fwExec fwRunner = execRunner\{\}/);
    for (const [file, types] of Object.entries(BACKENDS)) {
      const src = read(`agent/${file}`);
      assert.doesNotMatch(src, /^\/\/go:build/m, `${file}: build constraints must stay as before (none)`);
      for (const typ of types) {
        assert.match(src, new RegExp(`type ${typ} struct`), `${typ} must live in ${file}`);
        assert.doesNotMatch(shared, new RegExp(`type ${typ} struct`), `${typ} still in firewall.go`);
      }
      assert.doesNotMatch(src, /exec\.Command\(/, `${file}: run commands through fwRun/fwOutput (testable argv)`);
    }
  });

  lotIt('W3-2', '50b.2 native CIDR in every backend, canonical firewallBanned', () => {
    const nft = read('agent/firewall_nftables.go');
    assert.match(nft, /type ipv4_addr; flags interval;/);
    assert.match(nft, /type ipv6_addr; flags interval;/);
    assert.doesNotMatch(nft, /auto-merge;/, 'auto-merge rewrites elements into ranges the server never sent');
    assert.match(nft, /planIntervalSet\(/, 'overlapping elements must be resolved before nft refuses them');

    const ipt = read('agent/firewall_iptables.go');
    assert.match(ipt, /"hash:net"/);
    assert.doesNotMatch(ipt, /"create", iptSetName, "hash:ip"/, 'the ban set must not be hash:ip any more');
    assert.match(ipt, /func migrateIpsetToNet\(/, 'existing hash:ip sets are migrated');

    const fwd = read('agent/firewall_firewalld.go');
    assert.match(fwd, /fwdNetSetName = "obliguard_net"/);
    assert.match(fwd, /"hash:net"/);

    assert.match(read('agent/firewall_netsh.go'), /canonicalBanEntry\(/);
    assert.match(read('agent/firewall_pf.go'), /canonicalBanEntry\(/);

    const shared = read('agent/firewall.go');
    assert.match(shared, /func canonicalBanEntry\(/);
    assert.match(shared, /func banEntryKey\(/);
  });

  lotIt('W3-2', '50b.3 bansafety mirrors the server floors and reserved ranges; applied before the backend', () => {
    const safety = read('agent/bansafety.go');
    const floor = (name: string) => Number(new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(safety)?.[1]);
    assert.equal(floor('defaultBanMinPrefixV4'), DEFAULT_BAN_MIN_PREFIX_V4);
    assert.equal(floor('defaultBanMinPrefixV6'), DEFAULT_BAN_MIN_PREFIX_V6);
    assert.match(safety, /"OBLIGUARD_BAN_MIN_PREFIX_V4"/);
    assert.match(safety, /"OBLIGUARD_BAN_MIN_PREFIX_V6"/);

    const block = /var reservedBanRanges = \[\]netip\.Prefix\{([\s\S]*?)\n\}/.exec(safety)?.[1] ?? '';
    const goRanges = [...block.matchAll(/MustParsePrefix\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual([...goRanges].sort(), [...RESERVED_BAN_RANGES].sort(), 'agent reserved ranges drifted from RESERVED_BAN_RANGES');

    for (const what of ['"server"', '"agent"', '"gateway"']) {
      assert.ok(safety.includes(what), `protected class ${what} missing`);
    }

    const cmd = read('agent/cmd_ws.go');
    const filterAt = cmd.indexOf('guard.Filter(');
    const banAt = cmd.indexOf('fw.BanIP(');
    assert.ok(filterAt > 0 && banAt > filterAt, 'the add list must go through the ban-safety guard before BanIP');
    assert.match(cmd, /go purgeUnsafeBans\(cfg, fw\)/);
  });

  lotIt('W3-2', '50b.4 heartbeat advertises the cidr capability', () => {
    assert.match(read('agent/firewall.go'), /capCIDR = "cidr"/);
    assert.match(read('agent/cmd_ws.go'), /Capabilities:\s*append\(agentCapabilities\(\), firewallCapabilities\(fw\)\.\.\.\)/);
  });

  lotIt('W3-2', '50b.5 go test of the firewall backends and ban safety', (t) => {
    if (!goAvailable()) {
      t.skip('Go toolchain not available');
      return;
    }
    const res = spawnSync('go', [
      'test', '-count=1',
      '-run', 'Canonical|ParseBan|PlanInterval|Nftables|Iptables|UFW|Firewalld|Netsh|PFCIDR|FirewallCapabilities|BanSafety|PurgeUnsafe|ServerHost|GatewayParsers',
      './',
    ], { cwd: AGENT, encoding: 'utf8', timeout: 200_000 });
    assert.equal(res.status, 0, `go test failed:\n${res.stdout}\n${res.stderr}`);
  }, { timeout: 220_000 });

  lotIt('W3-2', '50b.6 go vet for the Linux, FreeBSD and macOS builds', (t) => {
    if (!goAvailable()) {
      t.skip('Go toolchain not available');
      return;
    }
    for (const goos of ['linux', 'freebsd', 'darwin']) {
      const res = spawnSync('go', ['vet', './'], {
        cwd: AGENT,
        encoding: 'utf8',
        timeout: 200_000,
        env: { ...process.env, GOOS: goos, GOARCH: 'amd64', CGO_ENABLED: '0' },
      });
      assert.equal(res.status, 0, `GOOS=${goos} go vet failed:\n${res.stdout}\n${res.stderr}`);
    }
  }, { timeout: 620_000 });
});
