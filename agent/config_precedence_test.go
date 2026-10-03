package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

// ── config.json vs --url / --key (decision 25) ───────────────────────────────

func TestConfigPrecedence(t *testing.T) {
	const fu, fk = "https://a.example.com", "key-file"
	cases := []struct {
		name               string
		fileURL, fileKey   string
		enrolled, force    bool
		flagURL, flagKey   string
		wantURL, wantKey   string
		urlSrc, keySrc     string
		urlIgnored, keyIgn bool
		forced             bool
	}{
		{name: "no flags", fileURL: fu, fileKey: fk, enrolled: true,
			wantURL: fu, wantKey: fk, urlSrc: "config.json", keySrc: "config.json"},
		{name: "enrolled: config.json wins", fileURL: fu, fileKey: fk, enrolled: true,
			flagURL: "https://b.example.com", flagKey: "key-flag",
			wantURL: fu, wantKey: fk, urlSrc: "config.json", keySrc: "config.json", urlIgnored: true, keyIgn: true},
		{name: "enrolled + --force-config: flags win", fileURL: fu, fileKey: fk, enrolled: true, force: true,
			flagURL: "https://b.example.com/", flagKey: "key-flag",
			wantURL: "https://b.example.com", wantKey: "key-flag", urlSrc: "flag", keySrc: "flag", forced: true},
		{name: "not enrolled yet: flags win (re-install with a corrected key)", fileURL: fu, fileKey: fk,
			flagURL: "https://b.example.com", flagKey: "key-flag",
			wantURL: "https://b.example.com", wantKey: "key-flag", urlSrc: "flag", keySrc: "flag"},
		{name: "enrolled, config.json lacks the key: flag fills it", fileURL: fu, enrolled: true,
			flagURL: "https://b.example.com", flagKey: "key-flag",
			wantURL: fu, wantKey: "key-flag", urlSrc: "config.json", keySrc: "flag", urlIgnored: true},
		{name: "same values (MSI update arguments): nothing ignored", fileURL: fu + "/", fileKey: fk, enrolled: true,
			flagURL: fu, flagKey: fk,
			wantURL: fu, wantKey: fk, urlSrc: "config.json", keySrc: "config.json"},
		{name: "--force-config without a differing flag changes nothing", fileURL: fu, fileKey: fk, enrolled: true, force: true,
			flagURL: fu,
			wantURL: fu, wantKey: fk, urlSrc: "config.json", keySrc: "config.json"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := resolveConfigPrecedence(c.fileURL, c.fileKey, c.enrolled, c.flagURL, c.flagKey, c.force)
			if d.URL != c.wantURL || d.Key != c.wantKey {
				t.Fatalf("values = %q / %q, want %q / %q", d.URL, d.Key, c.wantURL, c.wantKey)
			}
			if d.URLSource != c.urlSrc || d.KeySource != c.keySrc {
				t.Fatalf("sources = %s / %s, want %s / %s", d.URLSource, d.KeySource, c.urlSrc, c.keySrc)
			}
			if d.URLIgnored != c.urlIgnored || d.KeyIgnored != c.keyIgn || d.Forced != c.forced {
				t.Fatalf("ignored = %v / %v forced = %v, want %v / %v %v", d.URLIgnored, d.KeyIgnored, d.Forced, c.urlIgnored, c.keyIgn, c.forced)
			}
		})
	}
}

func TestConfigPrecedenceLog(t *testing.T) {
	ignored := resolveConfigPrecedence("https://a", "secret-file", true, "https://b", "secret-flag", false)
	lines := strings.Join(ignored.logLines(), "\n")
	if !strings.Contains(lines, "--url ignored") || !strings.Contains(lines, "--key ignored") || !strings.Contains(lines, "--force-config") {
		t.Fatalf("decision not logged: %q", lines)
	}
	forced := resolveConfigPrecedence("https://a", "secret-file", true, "https://b", "secret-flag", true)
	lines += "\n" + strings.Join(forced.logLines(), "\n")
	if !strings.Contains(lines, "serverUrl from --url (https://b) (--force-config)") {
		t.Fatalf("forced decision not logged: %q", lines)
	}
	if strings.Contains(lines, "secret") {
		t.Fatalf("the API key must never be logged: %q", lines)
	}
	if got := resolveConfigPrecedence("https://a", "k", true, "", "", false).logLines(); len(got) != 0 {
		t.Fatalf("no flag, no log line: %v", got)
	}
}

// useTempConfig points config.json to a temporary directory.
func useTempConfig(t *testing.T) {
	t.Helper()
	prevDir, prevFile := configDir, configFile
	configDir = t.TempDir()
	configFile = filepath.Join(configDir, "config.json")
	t.Cleanup(func() { configDir, configFile = prevDir, prevFile })
}

func readSavedConfig(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile(configFile)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestApplyAgentConfigFrameMarksEnrolled(t *testing.T) {
	useTempConfig(t)
	cfg := &Config{ServerURL: "https://a", APIKey: "k"}
	applyAgentConfigFrame(cfg, &NoOpFirewall{}, nil)
	if !cfg.Enrolled || readSavedConfig(t)["enrolled"] != true {
		t.Fatal("the first config frame must persist enrolled=true")
	}
}

// ── Windows firewall backend preference ──────────────────────────────────────

func TestFirewallBackendNormalize(t *testing.T) {
	for in, want := range map[string]string{"": "auto", "auto": "auto", " WFP ": "wfp", "netsh": "netsh"} {
		if got, ok := normalizeFirewallBackend(in); !ok || got != want {
			t.Fatalf("normalize(%q) = %q %v, want %q", in, got, ok, want)
		}
	}
	if _, ok := normalizeFirewallBackend("winDivert"); ok {
		t.Fatal("an unknown backend must be refused")
	}
	if firewallKindFor("auto") != "wfp" || firewallKindFor("wfp") != "wfp" || firewallKindFor("netsh") != "netsh" {
		t.Fatal("auto and wfp select WFP first, netsh selects netsh")
	}
}

// kindFirewall is an in-memory backend of a given kind.
type kindFirewall struct {
	NoOpFirewall
	kind    string
	mu      sync.Mutex
	set     map[string]bool
	cleaned bool
}

func newKindFirewall(kind string, entries ...string) *kindFirewall {
	f := &kindFirewall{kind: kind, set: map[string]bool{}}
	for _, e := range entries {
		f.set[e] = true
	}
	return f
}

func (f *kindFirewall) BanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.set[ip] = true
	return nil
}

func (f *kindFirewall) UnbanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.set, ip)
	return nil
}

func (f *kindFirewall) GetBannedIPs() ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.set))
	for k := range f.set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

func (f *kindFirewall) BackendKind() string { return f.kind }

// fakeSwitcher migrates between kindFirewalls (apply new, then clean old).
type fakeSwitcher struct {
	fail      error
	migrated  []string
	activated []string
}

func (s *fakeSwitcher) kindOf(fw FirewallManager) string {
	if k, ok := fw.(*kindFirewall); ok {
		return k.kind
	}
	return "none"
}

func (s *fakeSwitcher) migrate(old FirewallManager, to string) (FirewallManager, error) {
	s.migrated = append(s.migrated, to)
	if s.fail != nil {
		return nil, s.fail
	}
	cur, _ := old.GetBannedIPs()
	nw := newKindFirewall(to, cur...)
	old.(*kindFirewall).cleaned = true
	return nw, nil
}

func (s *fakeSwitcher) activate(fw FirewallManager) { s.activated = append(s.activated, s.kindOf(fw)) }
func (s *fakeSwitcher) armWFPPurge()                {}

func TestSwitchableFirewallMigratesBanSet(t *testing.T) {
	useTempConfig(t)
	ops := &fakeSwitcher{}
	wfp := newKindFirewall("wfp", "1.2.3.4", "10.0.0.0/24")
	sw := newSwitchableFirewall(wfp, "auto", ops)
	cfg := &Config{}

	if caps := firewallCapabilities(sw); !reflect.DeepEqual(caps, []string{"cidr", "wfp"}) {
		t.Fatalf("WFP active: caps = %v", caps)
	}

	// Absent field: nothing changes, nothing is persisted.
	applyFirewallBackendFrame(cfg, sw, nil)
	sw.waitIdle()
	if len(ops.migrated) != 0 || cfg.FirewallBackend != "" {
		t.Fatal("an absent firewallBackend must change nothing")
	}

	// auto → wfp: WFP already enforces, no migration, preference persisted.
	pref := "wfp"
	applyFirewallBackendFrame(cfg, sw, &pref)
	sw.waitIdle()
	if len(ops.migrated) != 0 || readSavedConfig(t)["firewallBackend"] != "wfp" {
		t.Fatalf("wfp while WFP enforces: migrated %v, config %v", ops.migrated, readSavedConfig(t))
	}

	// wfp → netsh: ban set moved, old backend cleaned, capability 'wfp' dropped.
	pref = "netsh"
	applyFirewallBackendFrame(cfg, sw, &pref)
	sw.waitIdle()
	if !reflect.DeepEqual(ops.migrated, []string{"netsh"}) || !wfp.cleaned {
		t.Fatalf("migrated %v cleaned %v", ops.migrated, wfp.cleaned)
	}
	if got, _ := sw.GetBannedIPs(); !reflect.DeepEqual(got, []string{"1.2.3.4", "10.0.0.0/24"}) {
		t.Fatalf("ban set after the switch = %v", got)
	}
	if caps := firewallCapabilities(sw); !reflect.DeepEqual(caps, []string{"cidr"}) {
		t.Fatalf("netsh active: caps = %v", caps)
	}
	if readSavedConfig(t)["firewallBackend"] != "netsh" || !reflect.DeepEqual(ops.activated, []string{"netsh"}) {
		t.Fatalf("persisted %v activated %v", readSavedConfig(t)["firewallBackend"], ops.activated)
	}

	// Writes now reach the new backend.
	if err := sw.BanIP("5.6.7.8"); err != nil {
		t.Fatal(err)
	}
	if got, _ := sw.GetBannedIPs(); len(got) != 3 {
		t.Fatalf("ban after the switch = %v", got)
	}

	// Same preference again: no second migration. Unknown value: ignored.
	applyFirewallBackendFrame(cfg, sw, &pref)
	bogus := "windivert"
	applyFirewallBackendFrame(cfg, sw, &bogus)
	sw.waitIdle()
	if len(ops.migrated) != 1 || cfg.FirewallBackend != "netsh" {
		t.Fatalf("repeat/unknown preference: migrated %v, stored %q", ops.migrated, cfg.FirewallBackend)
	}
}

func TestSwitchableFirewallFailedSwitchKeepsBackend(t *testing.T) {
	useTempConfig(t)
	ops := &fakeSwitcher{fail: errors.New("WFP init: access denied")}
	netsh := newKindFirewall("netsh", "1.2.3.4")
	sw := newSwitchableFirewall(netsh, "netsh", ops)
	cfg := &Config{FirewallBackend: "netsh"}

	pref := "auto"
	applyFirewallBackendFrame(cfg, sw, &pref)
	sw.waitIdle()
	if !reflect.DeepEqual(ops.migrated, []string{"wfp"}) {
		t.Fatalf("migrated %v", ops.migrated)
	}
	if sw.current() != netsh || netsh.cleaned || sw.BackendKind() != "netsh" {
		t.Fatal("a failed switch must leave the old backend enforcing, untouched")
	}
	if caps := firewallCapabilities(sw); !reflect.DeepEqual(caps, []string{"cidr"}) {
		t.Fatalf("'wfp' is reported only when WFP enforces: %v", caps)
	}
	// The preference is kept (retried at the next start).
	if cfg.FirewallBackend != "auto" {
		t.Fatalf("stored preference = %q", cfg.FirewallBackend)
	}
}

func TestApplyFirewallBackendFrameIgnoredOffWindows(t *testing.T) {
	useTempConfig(t)
	cfg := &Config{}
	pref := "netsh"
	applyFirewallBackendFrame(cfg, &NoOpFirewall{}, &pref)
	if cfg.FirewallBackend != "" {
		t.Fatal("a backend that cannot switch must ignore the preference")
	}
	if _, err := os.Stat(configFile); err == nil {
		t.Fatal("nothing must be saved")
	}
}
