/**
 * 96b — W13-3 agent side of C17-2 / C17-3:
 *   - Windows backend switch (agent/firewall.go, agent/firewall_wfp_windows.go):
 *     the config frame may carry "firewallBackend": auto | wfp | netsh (absent =
 *     unchanged, so agents of older servers stay on auto); the backend is
 *     wrapped so it can be switched at runtime (apply new, verify, then clean
 *     old); the preference is persisted in config.json and used at start; the
 *     'wfp' capability is advertised only while WFP enforces;
 *   - config.json precedence (agent/main.go, decision 25): after the first
 *     accepted config frame, serverUrl / apiKey of config.json win over
 *     --url / --key unless --force-config; the decision is logged.
 * Behaviour is covered by agent/config_precedence_test.go (every OS), run here
 * when a Go toolchain is available.
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

describe('96b agent: Windows backend switch and config.json precedence (W13-3)', () => {
  lotIt('W13-3', '96b.1 firewallBackend preference: values, absent = unchanged, runtime switch wrapper', () => {
    const fw = code('agent/firewall.go');
    for (const v of ['auto', 'wfp', 'netsh']) assert.ok(fw.includes(`"${v}"`), `backend value ${v} missing`);
    assert.match(fw, /func normalizeFirewallBackend\(s string\) \(pref string, ok bool\)/);
    assert.match(fw, /func applyFirewallBackendFrame\(cfg \*Config, fw FirewallManager, raw \*string\) \{\s*if raw == nil \{\s*return\s*\}/,
      'an absent field (older servers) must leave the preference unchanged');
    assert.match(fw, /type switchableFirewall struct/);
    assert.match(fw, /func DetectFirewall\(\) FirewallManager \{\s*return DetectFirewallFor\(fwBackendAuto\)/, 'default stays auto');
    assert.match(fw, /return newSwitchableFirewall\(fw, pref, fwSwitchOps\)/);
    // Migration and swap under the write lock; the old backend kept on failure.
    assert.match(fw, /nw, err := s\.ops\.migrate\(old, to\)\s*if err != nil \{[\s\S]*?return\s*\}\s*s\.curMu\.Lock\(\)\s*s\.cur = nw/);
    // The preference is persisted and applied at start.
    assert.match(fw, /cfg\.FirewallBackend = pref\s*if err := saveConfig\(cfg\)/);
    assert.match(read('agent/main.go'), /json:"firewallBackend,omitempty"/);
    assert.match(code('agent/main.go'), /fw := DetectFirewallFor\(cfg\.FirewallBackend\)/);
    // Capability 'wfp' only when the WFP-native backend enforces.
    assert.match(fw, /const capWFP = "wfp"/);
    assert.match(fw, /if firewallBackendKind\(fw\) == fwBackendWFP \{\s*caps = append\(caps, capWFP\)/);
  });

  lotIt('W13-3', '96b.2 WFP side: apply new + verify, then clean old; netsh fallback kept; retire stops the loop', () => {
    const wfp = code('agent/firewall_wfp_windows.go');
    assert.match(wfp, /func init\(\) \{ fwSwitchOps = winBackendSwitcher\{\} \}/);
    // To WFP: filters committed and re-read before the netsh rules are removed.
    assert.match(wfp, /func migrateToWFP\([\s\S]*?nw\.resync\(\)[\s\S]*?switchMissing\(want, nw\)[\s\S]*?nf\.deleteGroupedRules\(\)/);
    // To netsh: verified before the WFP filters are purged; the reconcile of
    // the old WFP backend does not delete the new netsh rules meanwhile.
    assert.match(wfp, /func migrateToNetsh\([\s\S]*?oldWFP\.setHandover\(true\)[\s\S]*?nf\.wfpPurged = true[\s\S]*?switchMissing\(want, nf\)[\s\S]*?oldWFP\.retire\(true\)/);
    assert.match(wfp, /if !f\.handover && !f\.isClosed\(\) \{\s*legacy\.deleteGroupedRules\(\)/);
    assert.match(wfp, /case <-f\.stop:\s*return/, 'a retired WFP backend stops its resync loop');
    assert.match(wfp, /if f\.closed \{\s*return errWFPClosed/);
    // Start-up fallback unchanged (70.2).
    assert.match(wfp, /netshFallbackPurge = purgeWFPAfterNetshFallback/);
    assert.match(wfp, /func \(f \*WFPFirewall\) BackendKind\(\) string \{ return fwBackendWFP \}/);
  });

  lotIt('W13-3', '96b.3 config.json wins over --url/--key after enrolment (decision 25), --force-config, logged', () => {
    const main = code('agent/main.go');
    assert.match(main, /func resolveConfigPrecedence\(fileURL, fileKey string, enrolled bool, flagURL, flagKey string, force bool\) configDecision/);
    assert.match(main, /flag\.BoolVar\(&forceConfigFlag, "force-config", false,/);
    assert.match(read('agent/main.go'), /json:"enrolled,omitempty"/);
    assert.match(main, /d := resolveConfigPrecedence\(cfg\.ServerURL, cfg\.APIKey, cfg\.Enrolled, urlArg, keyArg, forceConfigFlag\)/);
    assert.match(main, /log\.Printf\("Config: %s", line\)/, 'the decision is logged');
    assert.doesNotMatch(main, /if urlArg != "" \{\s*cfg\.ServerURL = /, 'flags must no longer override config.json unconditionally');
    assert.match(main, /func applyAgentConfigFrame\(cfg \*Config, fw FirewallManager, firewallBackend \*string\)/);
    // W13-5 wiring: the WS config frame decodes the field (pointer: absent =
    // unchanged) and the config worker calls the entry point after the
    // one-shot command block, before the ban delta.
    const ws = code('agent/cmd_ws.go');
    assert.match(ws, /FirewallBackend \*string\s+`json:"firewallBackend,omitempty"`/);
    assert.match(ws, /handleUninstallCommand\(cfg\)\s*return\s*\}\s*\}\s*applyAgentConfigFrame\(cfg, fw, msg\.FirewallBackend\)[\s\S]*?queueBanDelta\(/,
      'applyOGConfig must call applyAgentConfigFrame (backend switch + enrolment marker)');
    const notes = read('docs/release-notes-agent.md');
    assert.match(notes, /### Windows backend switch and config\.json precedence \(W13-3\)/);
    assert.match(notes, /--force-config/);
  });

  lotIt('W13-3', '96b.4 go test of the precedence and switch logic; windows vet', (t) => {
    if (!goAvailable()) {
      t.skip('Go toolchain not available');
      return;
    }
    const res = spawnSync('go', [
      'test', '-count=1',
      '-run', '^Test(ConfigPrecedence|ApplyAgentConfigFrame|FirewallBackend|SwitchableFirewall|ApplyFirewallBackendFrame)',
      './',
    ], { cwd: AGENT, encoding: 'utf8', timeout: 200_000 });
    assert.equal(res.status, 0, `go test failed:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /^ok\s/m);

    const vet = spawnSync('go', ['vet', './...'], {
      cwd: AGENT, encoding: 'utf8', timeout: 200_000,
      env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64' },
    });
    assert.equal(vet.status, 0, `GOOS=windows go vet failed:\n${vet.stdout}\n${vet.stderr}`);
  }, { timeout: 420_000 });
});
