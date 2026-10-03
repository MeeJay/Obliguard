/**
 * 70 — W7-5 Windows agent enforcement (D11 items 1, 2, 4):
 *   - netsh fallback (agent/firewall_netsh.go): grouped Obliguard-Block-in/out(-N)
 *     rules of at most 500 entries, rebuilt from obliguard-banlist.txt at the
 *     first Flush, the file written atomically (temp + rename), existing groups
 *     updated in place (`set rule … new remoteip=`), adds retried on transient
 *     netsh errors, stale groups removed, rule names parsed whatever the
 *     display language; an entry whose group failed is not reported enforced;
 *   - WFP (agent/firewall_wfp_windows.go): networks as range conditions, stale
 *     filters (not in the banlist, duplicate, older CIDR form) deleted at
 *     start, desired set capped, netsh fallback purges earlier WFP filters;
 *   - Security Event Log (agent/eventlog_windows.go): wevtapi pull
 *     subscription, 4625 / 4624 type 10 read from the EventData fields of the
 *     event XML (IpAddress, TargetUserName, LogonType), '-' / loopback skipped,
 *     RecordId bookmark persisted across restarts;
 *   - rate limiting stays unsupported on Windows (no WinDivert, decision 23).
 * Behaviour is covered by Go tests (agent/firewall_netsh_test.go on every OS,
 * agent/eventlog_windows_test.go and agent/firewall_wfp_windows_test.go on
 * Windows), run here when a Go toolchain is available.
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

describe('70 Windows agent enforcement: netsh fallback, WFP, Security Event Log (W7-5)', () => {
  lotIt('W7-5', '70.1 netsh fallback: atomic banlist, in-place group update, retries, stale cleanup', () => {
    const ns = code('agent/firewall_netsh.go');
    assert.match(ns, /const maxIPsPerRule = 500/);
    assert.match(ns, /func writeFileAtomic\(path string, data \[\]byte, mode os\.FileMode\) error/);
    assert.match(ns, /os\.CreateTemp\(filepath\.Dir\(path\)/, 'temp file in the same directory (same volume for the rename)');
    assert.match(ns, /tmp\.Sync\(\)/);
    assert.match(ns, /os\.Rename\(name, path\)/);
    assert.match(ns, /writeFileAtomic\(f\.banlistPath\(\)/, 'the banlist goes through the atomic writer');
    assert.doesNotMatch(ns, /os\.WriteFile\(/, 'no truncate-and-write of the banlist');
    // Existing group updated in place, delete + add only to (re)create one.
    assert.match(ns, /"set", "rule",\s*\n\s*"name="\+r\.name, "dir="\+r\.dir, "new", "remoteip="\+r\.ipList/);
    assert.match(ns, /out, err := netshRetry\("netsh", "advfirewall", "firewall", "add", "rule"/);
    assert.match(ns, /netshRetryDelays = \[\]time\.Duration\{/);
    // A failed group is retried and not reported as enforced.
    assert.match(ns, /f\.dirty = true \/\/ retried at the next Flush/);
    assert.match(ns, /if !f\.unapplied\[ip\] \{/);
    // Rebuilt from the file at the first Flush of a process.
    assert.match(ns, /func \(f \*WindowsFirewall\) Flush\(\) error \{[\s\S]*?f\.loadCache\(\)/);
    assert.match(ns, /f\.cleanupStaleRules\(/);
    assert.match(ns, /i < start\+netshStaleWalkMax/, 'bounded delete-by-name walk');
    // Locale independent rule-name parsing (labels never read).
    assert.match(ns, /func parseNetshRuleNames\(out string\) \[\]string/);
    assert.match(ns, /"："/, 'full-width colon (CJK locales)');
    assert.doesNotMatch(ns, /Rule Name|Nom de la/, 'no localized label in code');
  });

  lotIt('W7-5', '70.2 WFP: CIDR as range, stale filters removed at start, cap, netsh fallback purge', () => {
    const wfp = code('agent/firewall_wfp_windows.go');
    assert.match(wfp, /Op: wf\.MatchTypeRange, Value: netipx\.RangeOfPrefix\(p\)/);
    assert.match(wfp, /Conditions:\s+\[\]\*wf\.Match\{wfpRemoteMatch\(p\)\}/);
    assert.match(wfp, /func classifyWFPRules\(rules \[\]\*wf\.Rule\) \(map\[string\]wf\.RuleID, \[\]wf\.RuleID\)/);
    assert.match(wfp, /r\.Provider != obliProviderID && r\.Sublayer != obliSublayerID/);
    assert.match(wfp, /if r\.ID != ruleID\(key\) \{/);
    assert.match(wfp, /banlist, hasBanlist := readWFPBanlist\(wfpBanlistPath\(\)\)/, 'banlist = persisted filter set');
    assert.match(wfp, /ops = append\(ops, wfpOp\{staleID: &stale\[i\]\}\)/);
    assert.match(wfp, /const wfpMaxFilters = 100000/);
    assert.match(wfp, /filter limit reached/);
    assert.match(wfp, /netshFallbackPurge = purgeWFPAfterNetshFallback/);
    assert.match(wfp, /writeFileAtomic\(wfpBanlistPath\(\)/);
    assert.match(wfp, /func \(f \*WFPFirewall\) IsRateLimitSupported\(\) bool \{ return false \}/);
    const ns = code('agent/firewall_netsh.go');
    assert.match(ns, /netshFallbackPurge\(\)/);
    // Rate limiting stays unsupported on Windows (decision 23).
    const rl = code('agent/firewall_ratelimit_windows.go');
    assert.match(rl, /func \(f \*WindowsFirewall\) IsRateLimitSupported\(\) bool\s+\{ return false \}/);
  });

  lotIt('W7-5', '70.3 Security Event Log: event XML fields, skips, bookmark persistence', () => {
    const ev = code('agent/eventlog_windows.go');
    assert.doesNotMatch(ev, /powershell|Get-WinEvent/i, 'no PowerShell process per poll');
    assert.match(ev, /NewLazySystemDLL\("wevtapi\.dll"\)/);
    assert.match(ev, /NewProc\("EvtSubscribe"\)/);
    assert.match(ev, /evtSubscribeStartAfterBookmark \| evtSubscribeStrict/);
    assert.match(ev, /ev\.Data\["IpAddress"\]/);
    assert.match(ev, /ev\.Data\["TargetUserName"\]/);
    assert.match(ev, /ev\.Data\["LogonType"\]/);
    assert.match(ev, /a\.IsLoopback\(\) \|\| a\.IsUnspecified\(\)/);
    assert.match(ev, /if user == "-" \{/);
    assert.match(ev, /eventLogBookmarkName\s+= "obliguard-eventlog\.bookmark"/);
    assert.match(ev, /saveEventLogBookmark\(p\.bookmarkFile, p\.lastRecord\)/);
    assert.match(ev, /if !p\.lw\.IsServiceEnabled\("rdp"\) \{/, 'opt-in gate kept');
    assert.match(read('agent/eventlog_stub.go'), /func startPlatformEventLogWatcher\(_ \*LogWatcher\) \{\}/);
  });

  lotIt('W7-5', '70.4 go test of the netsh fallback, WFP helpers and Event Log parser; windows vet', (t) => {
    if (!goAvailable()) {
      t.skip('Go toolchain not available');
      return;
    }
    const res = spawnSync('go', [
      'test', '-count=1',
      '-run', '^Test(ParseNetshRuleNames|Netsh|WriteFileAtomic|WFP|ClassifyWFPRules|ReadWFPBanlist|ParseSecurityEventXML|SecEvent|EventLog|WevtSubscription)',
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
