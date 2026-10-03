package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// pfHost simulates pfctl for the pf backends: pf state, main ruleset, anchor
// rules and the anchor / legacy (main-ruleset) tables.
type pfHost struct {
	enabled    bool
	referenced bool
	anchorOK   bool
	anchor     []string // anchor table content (pfctl show output lines)
	legacy     []string // main-ruleset table, nil = table does not exist
	parseErr   error    // returned by pfctl -n -f
}

func (h *pfHost) handle(c fakeCall) (string, error) {
	switch c.line() {
	case "pfctl -s info":
		if h.enabled {
			return "Status: Enabled for 0 days 00:01:02           Debug: Urgent\n", nil
		}
		return "Status: Disabled\n", nil
	case "pfctl -s rules":
		out := `anchor "com.apple/*" all` + "\n"
		if h.referenced {
			out += `anchor "obliguard" all` + "\n"
		}
		return out, nil
	case "pfctl -a obliguard -s rules":
		if h.anchorOK {
			return "block drop in quick from <obliguard_blocklist> to any\n" +
				"block drop out quick from any to <obliguard_blocklist>\n", nil
		}
		return "", nil
	case "pfctl -a obliguard -f -":
		h.anchorOK = true
		return "", nil
	case "pfctl -a obliguard -t obliguard_blocklist -T show":
		return "   " + strings.Join(h.anchor, "\n   ") + "\n", nil
	case "pfctl -t obliguard_blocklist -T show":
		if h.legacy == nil {
			return "", errors.New("pfctl: Table does not exist")
		}
		return "   " + strings.Join(h.legacy, "\n   ") + "\n", nil
	case "pfctl -t obliguard_blocklist -T flush":
		h.legacy = []string{}
		return "", nil
	case "pfctl -E", "pfctl -e":
		h.enabled = true
		return "", nil
	}
	if len(c.args) >= 3 && c.args[0] == "-n" && c.args[1] == "-f" {
		return "", h.parseErr
	}
	if len(c.args) == 2 && c.args[0] == "-f" {
		// Reloading a pf.conf that holds the anchor lines references the
		// anchor and loads its rules from the anchor file.
		if data, err := os.ReadFile(c.args[1]); err == nil {
			if strings.Contains(string(data), "\n"+`anchor "obliguard"`) || strings.HasPrefix(string(data), `anchor "obliguard"`) {
				h.referenced = true
			}
			if strings.Contains(string(data), `load anchor "obliguard" from`) {
				h.anchorOK = true
			}
		}
	}
	if c.name == "configctl" {
		h.referenced = true
	}
	return "", nil
}

// usePFHost wires a pfHost into the fake runner and keeps the pf helpers
// away from the real system: platform paths under a temp dir, no automatic
// hook repair unless allowAuto.
func usePFHost(t *testing.T, h *pfHost, pl pfPlatform, allowAuto bool) *fakeRunner {
	t.Helper()
	r := &fakeRunner{handle: h.handle}
	useFakeRunner(t, r)
	oldDetect, oldAuto := pfDetectPlatform, pfAutoSetup
	pfDetectPlatform = func(string) pfPlatform { return pl }
	pfAutoSetup = func(pfPlatform) bool { return allowAuto }
	t.Cleanup(func() { pfDetectPlatform, pfAutoSetup = oldDetect, oldAuto })
	return r
}

func testPFPlatform(t *testing.T, kind string) pfPlatform {
	dir := t.TempDir()
	pl := pfPlatform{kind: kind, goos: "test"}
	switch kind {
	case pfKindOPNsense:
		pl.pluginFile = filepath.Join(dir, "plugins.inc.d", "obliguard.inc")
		pl.legacyFiles = []string{filepath.Join(dir, "actions_obliguard.conf")}
	default:
		pl.pfConf = filepath.Join(dir, "pf.conf")
		pl.anchorFile = filepath.Join(dir, "pf.anchors", "obliguard")
		if kind == pfKindMacOS {
			pl.bootPlist = filepath.Join(dir, "com.obliguard.pf.plist")
		} else {
			pl.legacyFiles = []string{filepath.Join(dir, "pf.obliguard.conf")}
		}
	}
	return pl
}

func mustNotHaveLine(t *testing.T, lines []string, bad string) {
	t.Helper()
	if indexOfLine(lines, bad) >= 0 {
		t.Fatalf("unexpected command %q in:\n%s", bad, strings.Join(lines, "\n"))
	}
}

// ── Table commands ───────────────────────────────────────────────────────────

func TestPFAnchorQualifiedTable(t *testing.T) {
	h := &pfHost{enabled: true, referenced: true, anchorOK: true, anchor: []string{"1.2.3.0/24", "5.6.7.8"}}
	r := usePFHost(t, h, testPFPlatform(t, pfKindMacOS), false)

	mac := &PFFirewall{}
	if err := mac.BanIP("1.2.3.77/24"); err != nil {
		t.Fatal(err)
	}
	if err := mac.UnbanIP("1.2.3.0/24"); err != nil {
		t.Fatal(err)
	}
	bsd := &FreeBSDPFFirewall{}
	if err := bsd.BanIP("2001:db8::/48"); err != nil {
		t.Fatal(err)
	}
	if err := bsd.BanIP("not-an-ip"); err == nil {
		t.Fatal("invalid entry accepted")
	}
	lines := r.lines()
	mustHaveLine(t, lines, "pfctl -a obliguard -t obliguard_blocklist -T add 1.2.3.0/24")
	mustHaveLine(t, lines, "pfctl -a obliguard -t obliguard_blocklist -T delete 1.2.3.0/24")
	mustHaveLine(t, lines, "pfctl -a obliguard -t obliguard_blocklist -T add 2001:db8::/48")
	for _, l := range lines {
		if strings.Contains(l, "-T add") || strings.Contains(l, "-T delete") {
			if !strings.HasPrefix(l, "pfctl -a obliguard -t obliguard_blocklist -T ") {
				t.Fatalf("table command without the anchor: %q", l)
			}
		}
		if strings.Contains(l, "-F all") {
			t.Fatalf("state-flushing command %q", l)
		}
	}
	for _, fw := range []FirewallManager{mac, bsd} {
		got, err := fw.GetBannedIPs()
		if err != nil {
			t.Fatal(err)
		}
		if want := []string{"1.2.3.0/24", "5.6.7.8"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("%s GetBannedIPs = %v want %v", fw.Name(), got, want)
		}
	}
	if caps := firewallCapabilities(mac); !reflect.DeepEqual(caps, []string{"cidr"}) {
		t.Fatalf("pf capabilities = %v", caps)
	}
}

// The enforcement check runs once at start, then at most every
// pfRecheckInterval, not on every ban.
func TestPFEnsureIsThrottled(t *testing.T) {
	h := &pfHost{enabled: true, referenced: true, anchorOK: true}
	r := usePFHost(t, h, testPFPlatform(t, pfKindFreeBSD), false)
	fw := &FreeBSDPFFirewall{}
	for i := 0; i < 5; i++ {
		_ = fw.BanIP("9.9.9.9")
		_, _ = fw.GetBannedIPs()
	}
	n := 0
	for _, l := range r.lines() {
		if l == "pfctl -s info" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("pfctl -s info ran %d times, want 1", n)
	}
}

// ── Anchor rules ─────────────────────────────────────────────────────────────

func TestPFLoadsAnchorRules(t *testing.T) {
	h := &pfHost{enabled: true, referenced: true, anchorOK: false}
	r := usePFHost(t, h, testPFPlatform(t, pfKindMacOS), false)
	fw := &PFFirewall{}
	if _, err := fw.GetBannedIPs(); err != nil {
		t.Fatal(err)
	}
	stdins := r.stdins("pfctl -a obliguard -f -")
	if len(stdins) != 1 {
		t.Fatalf("anchor loaded %d times, want 1", len(stdins))
	}
	want := "table <obliguard_blocklist> persist\n" +
		"block drop in quick from <obliguard_blocklist> to any\n" +
		"block drop out quick from any to <obliguard_blocklist>\n"
	if stdins[0] != want {
		t.Fatalf("anchor rules =\n%s\nwant\n%s", stdins[0], want)
	}
	if !fw.Enforcing() {
		t.Fatal("Enforcing() = false after the anchor rules were loaded")
	}

	// Already loaded: not reloaded.
	r.reset()
	fw2 := &PFFirewall{}
	_, _ = fw2.GetBannedIPs()
	if got := r.stdins("pfctl -a obliguard -f -"); len(got) != 0 {
		t.Fatal("anchor rules reloaded although present")
	}
}

func TestPFEnforcing(t *testing.T) {
	cases := []struct {
		name string
		host pfHost
		want bool
	}{
		{"all good", pfHost{enabled: true, referenced: true, anchorOK: true}, true},
		{"pf disabled", pfHost{enabled: false, referenced: true, anchorOK: true}, false},
		{"anchor not referenced", pfHost{enabled: true, referenced: false, anchorOK: true}, false},
		{"anchor empty", pfHost{enabled: true, referenced: true, anchorOK: false}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := tc.host
			r := usePFHost(t, &h, testPFPlatform(t, pfKindFreeBSD), false)
			if got := (&FreeBSDPFFirewall{}).Enforcing(); got != tc.want {
				t.Fatalf("Enforcing() = %v want %v", got, tc.want)
			}
			if got := (&PFFirewall{}).Enforcing(); got != tc.want {
				t.Fatalf("macOS Enforcing() = %v want %v", got, tc.want)
			}
			if tc.want {
				mustHaveLine(t, r.lines(), "pfctl -s info")
				mustHaveLine(t, r.lines(), "pfctl -s rules")
			}
		})
	}
	if !pfAnchorReferenced(`anchor "obliguard" all label "x"`) || pfAnchorReferenced(`anchor "obliguard_other" all`) {
		t.Fatal("pfAnchorReferenced")
	}
}

// ── Legacy main-ruleset table ────────────────────────────────────────────────

// usePFGuard installs a ban-safety guard (gateway 192.168.1.1, see
// newGuardFixture) as the process-wide guard, or none.
func usePFGuard(t *testing.T, withGuard bool) {
	t.Helper()
	agentBanSafetyMu.Lock()
	old := agentBanSafety
	agentBanSafety = nil
	if withGuard {
		agentBanSafety = newGuardFixture("https://guard.example.com").g
	}
	agentBanSafetyMu.Unlock()
	t.Cleanup(func() {
		agentBanSafetyMu.Lock()
		agentBanSafety = old
		agentBanSafetyMu.Unlock()
	})
}

func TestPFLegacyTableMigration(t *testing.T) {
	usePFGuard(t, true)

	// Enforced anchor: safe legacy entries are moved (the gateway is refused
	// by the ban-safety guard), the legacy table flushed.
	h := &pfHost{enabled: true, referenced: true, anchorOK: true, legacy: []string{"7.7.7.7", "10.20.0.0/16", "192.168.1.1"}}
	r := usePFHost(t, h, testPFPlatform(t, pfKindFreeBSD), false)
	_, _ = (&FreeBSDPFFirewall{}).GetBannedIPs()
	lines := r.lines()
	mustHaveLine(t, lines, "pfctl -a obliguard -t obliguard_blocklist -T add 7.7.7.7 10.20.0.0/16")
	mustHaveLine(t, lines, "pfctl -t obliguard_blocklist -T flush")

	// Anchor not enforced: entries copied, legacy table (still used by the
	// old pf.conf rules) kept and unbans mirrored to it; flushed once the
	// anchor is enforced.
	h2 := &pfHost{enabled: true, referenced: false, anchorOK: true, legacy: []string{"7.7.7.7"}}
	r2 := usePFHost(t, h2, testPFPlatform(t, pfKindFreeBSD), false)
	fw := &FreeBSDPFFirewall{}
	_, _ = fw.GetBannedIPs()
	lines = r2.lines()
	mustHaveLine(t, lines, "pfctl -a obliguard -t obliguard_blocklist -T add 7.7.7.7")
	mustNotHaveLine(t, lines, "pfctl -t obliguard_blocklist -T flush")
	if err := fw.UnbanIP("7.7.7.7"); err != nil {
		t.Fatal(err)
	}
	lines = r2.lines()
	mustHaveLine(t, lines, "pfctl -t obliguard_blocklist -T delete 7.7.7.7")
	mustHaveLine(t, lines, "pfctl -a obliguard -t obliguard_blocklist -T delete 7.7.7.7")
	h2.referenced = true
	fw.core.lastCheck = time.Time{}
	_, _ = fw.GetBannedIPs()
	mustHaveLine(t, r2.lines(), "pfctl -t obliguard_blocklist -T flush")
	if fw.core.legacyKept {
		t.Fatal("legacy table still kept once the anchor is enforced")
	}

	// No guard yet (no ban list received): nothing copied, retried later.
	usePFGuard(t, false)
	h3 := &pfHost{enabled: true, referenced: true, anchorOK: true, legacy: []string{"7.7.7.7"}}
	r3 := usePFHost(t, h3, testPFPlatform(t, pfKindFreeBSD), false)
	fw3 := &FreeBSDPFFirewall{}
	_, _ = fw3.GetBannedIPs()
	mustNotHaveLine(t, r3.lines(), "pfctl -a obliguard -t obliguard_blocklist -T add 7.7.7.7")
	mustNotHaveLine(t, r3.lines(), "pfctl -t obliguard_blocklist -T flush")
	usePFGuard(t, true)
	fw3.core.lastCheck = time.Time{}
	_, _ = fw3.GetBannedIPs()
	mustHaveLine(t, r3.lines(), "pfctl -a obliguard -t obliguard_blocklist -T add 7.7.7.7")
	mustHaveLine(t, r3.lines(), "pfctl -t obliguard_blocklist -T flush")
}

// ── pf.conf patching ─────────────────────────────────────────────────────────

func TestPFConfWithAnchor(t *testing.T) {
	legacy := "set skip on lo0\npass in all\n\n# Obliguard IPS — managed automatically, do not edit\n" +
		"table <obliguard_blocklist> persist\nblock in quick from <obliguard_blocklist>\nblock out quick to <obliguard_blocklist>\n"
	got, changed := pfConfWithAnchor(legacy, "/etc/pf.anchors/obliguard")
	want := "set skip on lo0\npass in all\n\n" + pfConfMarker + "\nanchor \"obliguard\"\n" +
		"load anchor \"obliguard\" from \"/etc/pf.anchors/obliguard\"\n"
	if !changed || got != want {
		t.Fatalf("patched =\n%q\nwant\n%q", got, want)
	}
	// Idempotent.
	if again, changed := pfConfWithAnchor(got, "/etc/pf.anchors/obliguard"); changed || again != got {
		t.Fatalf("second pass changed the file:\n%q", again)
	}
	// Empty / missing pf.conf.
	if got, _ := pfConfWithAnchor("", "/a"); got != pfConfMarker+"\nanchor \"obliguard\"\nload anchor \"obliguard\" from \"/a\"\n" {
		t.Fatalf("empty pf.conf => %q", got)
	}
	// An anchor line the operator placed above their pass rules stays there.
	user := "anchor \"obliguard\"\npass in quick all\n"
	got, changed = pfConfWithAnchor(user, "/a")
	if !changed || !strings.HasPrefix(got, user) || strings.Count(got, "anchor \"obliguard\"\n") != 1 ||
		!strings.Contains(got, "load anchor \"obliguard\" from \"/a\"") {
		t.Fatalf("user anchor => %q", got)
	}
	// CRLF content: legacy lines are still recognised.
	if got, _ := pfConfWithAnchor(strings.ReplaceAll(legacy, "\n", "\r\n"), "/etc/pf.anchors/obliguard"); got != want {
		t.Fatalf("CRLF pf.conf => %q", got)
	}
}

func TestPFConfWithoutAnchor(t *testing.T) {
	conf := "set skip on lo0\n\n" + pfConfMarker + "\nanchor \"obliguard\"\nload anchor \"obliguard\" from \"/x\"\n" +
		"table <obliguard_blocklist> persist\nblock in quick from <obliguard_blocklist>\npass out all\n"
	got, changed := pfConfWithoutAnchor(conf)
	if want := "set skip on lo0\n\npass out all\n"; !changed || got != want {
		t.Fatalf("cleaned =\n%q\nwant\n%q", got, want)
	}
	if same, changed := pfConfWithoutAnchor("pass all\n"); changed || same != "pass all\n" {
		t.Fatal("untouched pf.conf rewritten")
	}
}

// ── Install / uninstall ──────────────────────────────────────────────────────

func TestPFInstallFreeBSD(t *testing.T) {
	pl := testPFPlatform(t, pfKindFreeBSD)
	orig := "pass in all\n# Obliguard IPS — managed automatically, do not edit\ntable <obliguard_blocklist> persist\n"
	if err := os.WriteFile(pl.pfConf, []byte(orig), 0640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pl.legacyFiles[0], []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	h := &pfHost{enabled: true}
	r := usePFHost(t, h, pl, false)
	if err := pfInstall(pl, t.Logf); err != nil {
		t.Fatal(err)
	}
	anchor, err := os.ReadFile(pl.anchorFile)
	if err != nil || !strings.HasSuffix(string(anchor), pfAnchorRules) {
		t.Fatalf("anchor file = %q (%v)", anchor, err)
	}
	conf, _ := os.ReadFile(pl.pfConf)
	if strings.Contains(string(conf), "table <obliguard_blocklist>") ||
		!strings.Contains(string(conf), "anchor \"obliguard\"\nload anchor \"obliguard\" from \""+pl.anchorFile+"\"") {
		t.Fatalf("pf.conf =\n%s", conf)
	}
	if bak, err := os.ReadFile(pl.pfConf + pfConfBackupSuffix); err != nil || string(bak) != orig {
		t.Fatalf("backup = %q (%v)", bak, err)
	}
	if _, err := os.Stat(pl.legacyFiles[0]); !os.IsNotExist(err) {
		t.Fatal("legacy hook file kept")
	}
	lines := r.lines()
	check := indexOfLine(lines, "pfctl -n -f "+pl.pfConf+".obliguard-new")
	load := indexOfLine(lines, "pfctl -f "+pl.pfConf)
	if check < 0 || load < 0 || check > load {
		t.Fatalf("pf.conf must be validated then loaded:\n%s", strings.Join(lines, "\n"))
	}
	mustNotHaveLine(t, lines, "pfctl -E")
	if !h.referenced {
		t.Fatal("anchor not referenced after install")
	}

	// Second run: pf.conf already right, backup untouched.
	if err := pfInstall(pl, t.Logf); err != nil {
		t.Fatal(err)
	}
	conf2, _ := os.ReadFile(pl.pfConf)
	if string(conf2) != string(conf) {
		t.Fatal("second install changed pf.conf")
	}
}

func TestPFInstallRefusesInvalidRuleset(t *testing.T) {
	pl := testPFPlatform(t, pfKindFreeBSD)
	orig := "pass in all\n"
	if err := os.WriteFile(pl.pfConf, []byte(orig), 0644); err != nil {
		t.Fatal(err)
	}
	h := &pfHost{enabled: true, parseErr: errors.New("syntax error")}
	r := usePFHost(t, h, pl, false)
	if err := pfInstall(pl, t.Logf); err == nil {
		t.Fatal("invalid ruleset installed")
	}
	if conf, _ := os.ReadFile(pl.pfConf); string(conf) != orig {
		t.Fatalf("pf.conf changed: %q", conf)
	}
	if _, err := os.Stat(pl.pfConf + ".obliguard-new"); !os.IsNotExist(err) {
		t.Fatal("candidate file left behind")
	}
	mustNotHaveLine(t, r.lines(), "pfctl -f "+pl.pfConf)
}

func TestPFInstallMacOS(t *testing.T) {
	pl := testPFPlatform(t, pfKindMacOS)
	apple := "scrub-anchor \"com.apple/*\"\nanchor \"com.apple/*\"\nload anchor \"com.apple\" from \"/etc/pf.anchors/com.apple\"\n"
	if err := os.WriteFile(pl.pfConf, []byte(apple), 0644); err != nil {
		t.Fatal(err)
	}
	h := &pfHost{}
	r := usePFHost(t, h, pl, false)
	if err := pfInstall(pl, t.Logf); err != nil {
		t.Fatal(err)
	}
	conf, _ := os.ReadFile(pl.pfConf)
	if !strings.HasPrefix(string(conf), apple) || !strings.Contains(string(conf), "anchor \"obliguard\"\n") {
		t.Fatalf("pf.conf =\n%s", conf)
	}
	plist, err := os.ReadFile(pl.bootPlist)
	if err != nil || !strings.Contains(string(plist), "<string>-E</string>") || !strings.Contains(string(plist), "<key>RunAtLoad</key>") {
		t.Fatalf("boot plist = %q (%v)", plist, err)
	}
	lines := r.lines()
	mustHaveLine(t, lines, "pfctl -E")
	mustHaveLine(t, lines, "launchctl load -w "+pl.bootPlist)
	if p := pfEnforcementProblem(); p != "" {
		t.Fatalf("not enforcing after install: %s", p)
	}
}

func TestPFInstallOPNsense(t *testing.T) {
	pl := testPFPlatform(t, pfKindOPNsense)
	if err := os.WriteFile(pl.legacyFiles[0], []byte("[reload]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	h := &pfHost{enabled: true}
	r := usePFHost(t, h, pl, false)
	if err := pfInstall(pl, t.Logf); err != nil {
		t.Fatal(err)
	}
	plugin, err := os.ReadFile(pl.pluginFile)
	if err != nil || !strings.Contains(string(plugin), "function obliguard_firewall($fw)") ||
		!strings.Contains(string(plugin), "registerAnchor('obliguard', 'fw', 0, 'head')") {
		t.Fatalf("plugin = %q (%v)", plugin, err)
	}
	if _, err := os.Stat(pl.legacyFiles[0]); !os.IsNotExist(err) {
		t.Fatal("legacy configd action kept")
	}
	lines := r.lines()
	mustHaveLine(t, lines, "configctl filter reload")
	if len(r.stdins("pfctl -a obliguard -f -")) != 1 {
		t.Fatal("anchor rules not loaded")
	}
	for _, l := range lines {
		if strings.HasPrefix(l, "pfctl -f ") || strings.HasPrefix(l, "pfctl -n ") {
			t.Fatalf("OPNsense pf.conf touched: %q", l)
		}
	}
}

// At start, a missing hook is repaired once (agent upgraded from a version
// without it, pf.conf rewritten by an OS upgrade).
func TestPFAutoSetupAtStart(t *testing.T) {
	pl := testPFPlatform(t, pfKindMacOS)
	h := &pfHost{}
	r := usePFHost(t, h, pl, true)
	fw := &PFFirewall{}
	_, _ = fw.GetBannedIPs()
	mustHaveLine(t, r.lines(), "pfctl -E")
	if _, err := os.Stat(pl.anchorFile); err != nil {
		t.Fatal("anchor file not written by the start-up repair")
	}
	if !fw.Enforcing() {
		t.Fatal("not enforcing after the start-up repair")
	}

	// Not allowed (not root / other OS): nothing written, nothing enabled.
	pl2 := testPFPlatform(t, pfKindMacOS)
	h2 := &pfHost{}
	r2 := usePFHost(t, h2, pl2, false)
	_, _ = (&PFFirewall{}).GetBannedIPs()
	mustNotHaveLine(t, r2.lines(), "pfctl -E")
	if _, err := os.Stat(pl2.anchorFile); !os.IsNotExist(err) {
		t.Fatal("anchor file written without auto setup")
	}
}

func TestPFUninstall(t *testing.T) {
	pl := testPFPlatform(t, pfKindMacOS)
	if err := os.WriteFile(pl.pfConf, []byte("pass all\n"), 0644); err != nil {
		t.Fatal(err)
	}
	h := &pfHost{}
	r := usePFHost(t, h, pl, false)
	if err := pfInstall(pl, t.Logf); err != nil {
		t.Fatal(err)
	}
	r.reset()
	pfUninstall(pl, t.Logf)
	if conf, _ := os.ReadFile(pl.pfConf); string(conf) != "pass all\n" {
		t.Fatalf("pf.conf after uninstall = %q", conf)
	}
	for _, f := range []string{pl.anchorFile, pl.bootPlist} {
		if _, err := os.Stat(f); !os.IsNotExist(err) {
			t.Fatalf("%s kept", f)
		}
	}
	lines := r.lines()
	mustHaveLine(t, lines, "pfctl -f "+pl.pfConf)
	mustHaveLine(t, lines, "pfctl -a obliguard -F rules")
	mustHaveLine(t, lines, "pfctl -a obliguard -t obliguard_blocklist -T kill")
	mustHaveLine(t, lines, "launchctl unload "+pl.bootPlist)
	for _, l := range lines {
		if strings.Contains(l, "-F all") || l == "pfctl -d" {
			t.Fatalf("uninstall must not flush states or disable pf: %q", l)
		}
	}

	// OPNsense: plugin removed, filter reloaded.
	opn := testPFPlatform(t, pfKindOPNsense)
	if err := os.MkdirAll(filepath.Dir(opn.pluginFile), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(opn.pluginFile, []byte(pfOPNsensePluginSource), 0644); err != nil {
		t.Fatal(err)
	}
	r.reset()
	pfUninstall(opn, t.Logf)
	if _, err := os.Stat(opn.pluginFile); !os.IsNotExist(err) {
		t.Fatal("OPNsense plugin kept")
	}
	mustHaveLine(t, r.lines(), "configctl filter reload")
}

func TestPFUninstallScript(t *testing.T) {
	s := pfUninstallScript("/usr/local/bin/obliguard-agent")
	if !strings.HasPrefix(s, "/usr/local/bin/obliguard-agent pf-cleanup ") {
		t.Fatalf("script does not run pf-cleanup: %q", s)
	}
	for _, want := range []string{"pfctl -a obliguard -F rules", "pfctl -a obliguard -t obliguard_blocklist -T kill"} {
		if !strings.Contains(s, want) {
			t.Fatalf("fallback misses %q: %q", want, s)
		}
	}
	if strings.Contains(s, "-F all") {
		t.Fatal("fallback flushes every state of the host")
	}
}
