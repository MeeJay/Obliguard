//go:build windows

package main

import (
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/tailscale/wf"
	"go4.org/netipx"
)

// Pure helpers of the WFP backend (no engine session needed).

func TestWFPRemoteMatchForms(t *testing.T) {
	host := netip.MustParsePrefix("203.0.113.7/32")
	m := wfpRemoteMatch(host)
	if m.Op != wf.MatchTypeEqual || m.Value != host {
		t.Fatalf("host match = %+v", m)
	}

	nets := map[string][2]string{
		"203.0.113.0/24": {"203.0.113.0", "203.0.113.255"},
		"10.0.0.0/8":     {"10.0.0.0", "10.255.255.255"},
		"2001:db8::/48":  {"2001:db8::", "2001:db8:0:ffff:ffff:ffff:ffff:ffff"},
	}
	for pfx, bounds := range nets {
		m := wfpRemoteMatch(netip.MustParsePrefix(pfx))
		r, ok := m.Value.(netipx.IPRange)
		if m.Op != wf.MatchTypeRange || !ok {
			t.Fatalf("%s: match = %+v (want a range)", pfx, m)
		}
		if r.From().String() != bounds[0] || r.To().String() != bounds[1] {
			t.Fatalf("%s: range %s-%s", pfx, r.From(), r.To())
		}
		// Round trip back to the entry.
		p, current, ok := wfpMatchPrefix(m)
		if !ok || !current || p.String() != pfx {
			t.Fatalf("%s: read back %v current=%v ok=%v", pfx, p, current, ok)
		}
	}
}

func TestWFPMatchPrefixOlderForms(t *testing.T) {
	// Host as address/mask (all agents so far) and as a bare address: current.
	for _, v := range []any{netip.MustParsePrefix("198.51.100.1/32"), netip.MustParseAddr("198.51.100.1")} {
		p, current, ok := wfpMatchPrefix(&wf.Match{Field: wf.FieldIPRemoteAddress, Op: wf.MatchTypeEqual, Value: v})
		if !ok || !current || p.String() != "198.51.100.1/32" {
			t.Fatalf("%v: %v %v %v", v, p, current, ok)
		}
	}
	// Network as address/mask (older agents): valid but replaced.
	p, current, ok := wfpMatchPrefix(&wf.Match{Field: wf.FieldIPRemoteAddress, Op: wf.MatchTypeEqual, Value: netip.MustParsePrefix("198.51.100.0/24")})
	if !ok || current || p.String() != "198.51.100.0/24" {
		t.Fatalf("old cidr form: %v %v %v", p, current, ok)
	}
	// A range that is not a prefix, another field: not ours to interpret.
	odd := netipx.IPRangeFrom(netip.MustParseAddr("10.0.0.1"), netip.MustParseAddr("10.0.0.5"))
	if _, _, ok := wfpMatchPrefix(&wf.Match{Field: wf.FieldIPRemoteAddress, Op: wf.MatchTypeRange, Value: odd}); ok {
		t.Fatal("a non-prefix range must not be recognized")
	}
	if _, _, ok := wfpMatchPrefix(&wf.Match{Field: wf.FieldIPLocalAddress, Op: wf.MatchTypeEqual, Value: netip.MustParseAddr("10.0.0.1")}); ok {
		t.Fatal("another field must not be recognized")
	}
}

func TestClassifyWFPRules(t *testing.T) {
	ours := func(key string, id wf.RuleID, m *wf.Match) *wf.Rule {
		return &wf.Rule{ID: id, Provider: obliProviderID, Sublayer: obliSublayerID, Conditions: []*wf.Match{m}}
	}
	hostKey, netKey := "192.0.2.1", "192.0.2.128/25"
	hostP := netip.MustParsePrefix("192.0.2.1/32")
	netP := netip.MustParsePrefix("192.0.2.128/25")
	other := wf.RuleID(guidFromUUID([16]byte{1, 2, 3}))
	foreignProvider := wf.ProviderID(guidFromUUID([16]byte{9, 9, 9}))

	rules := []*wf.Rule{
		ours(hostKey, ruleID(hostKey), wfpRemoteMatch(hostP)), // valid host
		ours(netKey, ruleID(netKey), wfpRemoteMatch(netP)),    // valid network (range)
		ours(hostKey, other, wfpRemoteMatch(hostP)),           // duplicate under another id
		ours("x", ruleID("203.0.113.0/24"), &wf.Match{Field: wf.FieldIPRemoteAddress, Op: wf.MatchTypeEqual, Value: netip.MustParsePrefix("203.0.113.0/24")}), // old cidr form
		{ID: ruleID("junk"), Provider: obliProviderID, Conditions: nil},                                                                                       // no condition
		{ID: ruleID("foreign"), Provider: foreignProvider, Conditions: []*wf.Match{wfpRemoteMatch(hostP)}},                                                    // not ours
	}
	cur, stale := classifyWFPRules(rules)
	if want := map[string]wf.RuleID{hostKey: ruleID(hostKey), netKey: ruleID(netKey)}; !reflect.DeepEqual(cur, want) {
		t.Fatalf("current = %v", cur)
	}
	if want := []wf.RuleID{other, ruleID("203.0.113.0/24"), ruleID("junk")}; !reflect.DeepEqual(stale, want) {
		t.Fatalf("stale = %v want %v", stale, want)
	}
}

func TestReadWFPBanlist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "obliguard-banlist.txt")
	if _, ok := readWFPBanlist(path); ok {
		t.Fatal("a missing file must report no banlist")
	}
	os.WriteFile(path, []byte("1.2.3.4\r\n\r\n10.0.0.77/24\r\ngarbage\r\n::ffff:5.6.7.8\r\n"), 0644)
	got, ok := readWFPBanlist(path)
	if !ok || len(got) != 3 {
		t.Fatalf("banlist = %v %v", got, ok)
	}
	for _, k := range []string{"1.2.3.4", "10.0.0.0/24", "5.6.7.8"} {
		if _, ok := got[k]; !ok {
			t.Fatalf("missing %s in %v", k, got)
		}
	}
}

func TestWFPDesiredCap(t *testing.T) {
	f := &WFPFirewall{desired: make(map[string]netip.Prefix), applied: make(map[string]wf.RuleID)}
	for i := 0; i < wfpMaxFilters; i++ {
		f.desired[netip.AddrFrom4([4]byte{10, byte(i >> 16), byte(i >> 8), byte(i)}).String()] = netip.Prefix{}
	}
	if err := f.BanIP("192.0.2.1"); err == nil {
		t.Fatal("a ban beyond wfpMaxFilters must be refused")
	}
	if err := f.BanIP("10.0.0.0"); err != nil {
		t.Fatalf("an entry already desired is accepted at the cap: %v", err)
	}
	if err := f.UnbanIP("10.0.0.0"); err != nil {
		t.Fatal(err)
	}
	if err := f.BanIP("192.0.2.1"); err != nil {
		t.Fatalf("room freed: %v", err)
	}
}
