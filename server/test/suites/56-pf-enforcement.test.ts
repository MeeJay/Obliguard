/**
 * 56 — W4-4 pf enforcement on macOS, FreeBSD and OPNsense (BROKEN-14, D12/C6):
 *   - one anchor-qualified table everywhere:
 *     pfctl -a obliguard -t obliguard_blocklist -T add|delete|show, the anchor
 *     holding `table <obliguard_blocklist> persist` and the two block rules;
 *   - Enforcing() (pf enabled, anchor referenced by the main ruleset, anchor
 *     rules loaded), logged loudly when false;
 *   - install-time hook: /etc/pf.anchors/obliguard + anchor / load anchor
 *     lines in pf.conf (backup, pfctl -n validation) and pfctl -E with a
 *     launchd boot job on macOS; OPNsense plugin hook registering the anchor;
 *   - uninstall removes it all (pf-cleanup), never `pfctl -F all`; uninstall
 *     scripts are staged in the root-only update directory, not /tmp.
 * Behaviour is covered by agent/firewall_pf_test.go (fake command runner),
 * run here when a Go toolchain is available.
 */
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { lotIt } from '../lots';

const REPO = path.resolve(__dirname, '..', '..', '..');
const AGENT = path.join(REPO, 'agent');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
/** Go source without its line comments (checks target code, not prose). */
const code = (rel: string) => read(rel).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

function goAvailable(): boolean {
  return spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;
}

describe('56 pf enforcement: anchor-qualified table, install-time hook (W4-4)', () => {
  lotIt('W4-4', '56.1 every table command is anchor-qualified; anchor rules block both directions', () => {
    const pf = read('agent/firewall_pf.go');
    assert.match(pf, /return append\(\[\]string\{"-a", pfAnchor, "-t", pfTable, "-T", cmd\}, entries\.\.\.\)/);
    assert.doesNotMatch(pf, /"pfctl", "-t", (pfTable|freebsdPFTable), "-T", "(add|delete)"/,
      'bans must not go to the main-ruleset table (no rule evaluates it on macOS / OPNsense)');
    assert.match(pf, /"table <" \+ pfTable \+ "> persist\\n"/);
    assert.match(pf, /"block drop in quick from <" \+ pfTable \+ "> to any\\n"/);
    assert.match(pf, /"block drop out quick from any to <" \+ pfTable \+ ">\\n"/);
    assert.match(pf, /fwRunStdin\(pfAnchorRules, "pfctl", "-a", pfAnchor, "-f", "-"\)/);
    assert.doesNotMatch(pf, /exec\.Command\(/, 'pf commands go through fwRun/fwOutput (testable argv)');
  });

  lotIt('W4-4', '56.2 Enforcing(): pf enabled, anchor referenced, anchor rules loaded; logged when false', () => {
    const pf = read('agent/firewall_pf.go');
    assert.match(pf, /func \(f \*PFFirewall\) Enforcing\(\) bool/);
    assert.match(pf, /func \(f \*FreeBSDPFFirewall\) Enforcing\(\) bool/);
    assert.match(pf, /fwOutput\("pfctl", "-s", "info"\)/);
    assert.match(pf, /"Status: Enabled"/);
    assert.match(pf, /fwOutput\("pfctl", "-s", "rules"\)/);
    assert.match(pf, /bans are NOT enforced/);
  });

  lotIt('W4-4', '56.3 install-time hook on macOS, FreeBSD and OPNsense', () => {
    const pf = read('agent/firewall_pf.go');
    assert.match(pf, /pfAnchorFilePath\s+= "\/etc\/pf\.anchors\/obliguard"/);
    assert.match(pf, /`load anchor "`\+pfAnchor\+`" from "`\+anchorFile\+`"`/);
    assert.match(pf, /fwRun\("pfctl", "-n", "-f", cand\)/, 'the patched pf.conf is validated before it replaces the live one');
    assert.match(pf, /pfConfBackupSuffix/);
    assert.match(pf, /fwRun\("pfctl", "-E"\)/, 'macOS: pf is disabled by default');
    assert.match(pf, /<string>\/sbin\/pfctl<\/string>\s*<string>-E<\/string>/, 'macOS: launchd job re-enables pf at boot');
    assert.match(pf, /\$fw->registerAnchor\('obliguard', 'fw', 0, 'head'\)/, 'OPNsense: plugin hook registers the anchor');
    assert.match(pf, /"configctl", "filter", "reload"/);

    const darwin = read('agent/service_darwin.go');
    assert.match(darwin, /case "pf-setup":/);
    assert.match(darwin, /case "pf-cleanup":/);
    const install = darwin.slice(darwin.indexOf('func installLaunchdService'), darwin.indexOf('func uninstallLaunchdService'));
    assert.match(install, /pfSetupCLI\(\)/, 'macOS install configures pf');
    const bsd = read('agent/service_freebsd.go');
    assert.match(bsd, /case "pf-setup":/);
    assert.match(bsd, /pfSetupCLI\(\)/);
    assert.doesNotMatch(bsd, /block in quick from <obliguard_blocklist>/, 'no main-ruleset table rules any more');

    const mac = read('agent/installer/install-macos.sh');
    assert.match(mac, /pf/);
    const fbsd = read('agent/installer/install-freebsd.sh');
    assert.match(fbsd, /pf-setup/);
    assert.doesNotMatch(fbsd, /echo "block in quick from/, 'pf.conf is patched by the agent (anchor), not with main-ruleset rules');
  });

  lotIt('W4-4', '56.4 uninstall removes the pf hook, never flushes every state, no /tmp staging', () => {
    const un = code('agent/uninstall.go');
    assert.match(un, /pf-cleanup/);
    assert.doesNotMatch(un, /-F all/, '`pfctl -F all` also flushes the state of every connection of the host');
    assert.doesNotMatch(un, /\/tmp\/obliguard-uninstall/, 'fixed /tmp paths can be symlinks planted by a local user');
    assert.doesNotMatch(un, /os\.TempDir\(\)/, 'stage in prepareUpdateDir() (W2-2 followup)');
    assert.match(un, /prepareUpdateDir\(\)/);
    assert.doesNotMatch(code('agent/firewall_pf.go'), /"-F", "all"/);
    for (const svc of ['agent/service_darwin.go', 'agent/service_freebsd.go']) {
      const src = read(svc);
      const uninstall = src.slice(src.indexOf('func uninstall'));
      assert.match(uninstall, /pfCleanupCLI\(\)/, `${svc}: local uninstall removes the pf hook`);
    }
  });

  lotIt('W4-4', '56.5 go test of the pf backend (fake runner: commands, pf.conf patching, install/uninstall)', (t) => {
    if (!goAvailable()) {
      t.skip('Go toolchain not available');
      return;
    }
    const res = spawnSync('go', [
      'test', '-count=1',
      '-run', '^TestPF(AnchorQualifiedTable|EnsureIsThrottled|LoadsAnchorRules|Enforcing|LegacyTableMigration|ConfWithAnchor|ConfWithoutAnchor|Install|AutoSetupAtStart|Uninstall)',
      './',
    ], { cwd: AGENT, encoding: 'utf8', timeout: 200_000 });
    assert.equal(res.status, 0, `go test failed:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /^ok\s/m);
  }, { timeout: 220_000 });

  lotIt('W4-4', '56.6 go vet and cross-build for macOS and FreeBSD', (t) => {
    if (!goAvailable()) {
      t.skip('Go toolchain not available');
      return;
    }
    const out = process.platform === 'win32' ? 'NUL' : '/dev/null';
    for (const [goos, goarch] of [['darwin', 'amd64'], ['darwin', 'arm64'], ['freebsd', 'amd64']]) {
      const env = { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' };
      const vet = spawnSync('go', ['vet', './'], { cwd: AGENT, encoding: 'utf8', timeout: 200_000, env });
      assert.equal(vet.status, 0, `GOOS=${goos} GOARCH=${goarch} go vet failed:\n${vet.stdout}\n${vet.stderr}`);
      const build = spawnSync('go', ['build', '-o', out, './'], { cwd: AGENT, encoding: 'utf8', timeout: 200_000, env });
      assert.equal(build.status, 0, `GOOS=${goos} GOARCH=${goarch} go build failed:\n${build.stdout}\n${build.stderr}`);
    }
  }, { timeout: 1_220_000 });
});
