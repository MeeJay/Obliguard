package main

import (
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

// ── Fake command runner ───────────────────────────────────────────────────────

type fakeCall struct {
	name  string
	args  []string
	stdin string
}

func (c fakeCall) line() string {
	return strings.TrimSpace(c.name + " " + strings.Join(c.args, " "))
}

type fakeRunner struct {
	mu      sync.Mutex
	calls   []fakeCall
	missing map[string]bool
	// handle returns stdout and error for a call; nil handler = success, no output.
	handle func(c fakeCall) (string, error)
}

func (r *fakeRunner) Run(stdin, name string, args ...string) ([]byte, error) {
	c := fakeCall{name: name, args: append([]string(nil), args...), stdin: stdin}
	r.mu.Lock()
	r.calls = append(r.calls, c)
	h := r.handle
	r.mu.Unlock()
	if h == nil {
		return nil, nil
	}
	out, err := h(c)
	return []byte(out), err
}

func (r *fakeRunner) LookPath(name string) error {
	if r.missing[name] {
		return errors.New("not found")
	}
	return nil
}

// lines returns every recorded command line.
func (r *fakeRunner) lines() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.calls))
	for i, c := range r.calls {
		out[i] = c.line()
	}
	return out
}

// stdins returns the stdin of every call whose line starts with prefix.
func (r *fakeRunner) stdins(prefix string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, c := range r.calls {
		if strings.HasPrefix(c.line(), prefix) {
			out = append(out, c.stdin)
		}
	}
	return out
}

func (r *fakeRunner) reset() {
	r.mu.Lock()
	r.calls = nil
	r.mu.Unlock()
}

func useFakeRunner(t *testing.T, r *fakeRunner) {
	t.Helper()
	old := fwExec
	fwExec = r
	t.Cleanup(func() { fwExec = old })
}

func indexOfLine(lines []string, want string) int {
	for i, l := range lines {
		if l == want {
			return i
		}
	}
	return -1
}

func mustHaveLine(t *testing.T, lines []string, want string) {
	t.Helper()
	if indexOfLine(lines, want) < 0 {
		t.Fatalf("missing command %q in:\n%s", want, strings.Join(lines, "\n"))
	}
}

func sorted(s []string) []string {
	out := append([]string(nil), s...)
	sort.Strings(out)
	return out
}

// ── Canonical entries ─────────────────────────────────────────────────────────

func TestCanonicalBanEntry(t *testing.T) {
	ok := map[string]string{
		"1.2.3.4":              "1.2.3.4",
		" 1.2.3.4 ":            "1.2.3.4",
		"1.2.3.4/32":           "1.2.3.4",
		"1.2.3.0/24":           "1.2.3.0/24",
		"1.2.3.77/24":          "1.2.3.0/24",
		"2001:db8::1":          "2001:db8::1",
		"2001:db8::1/128":      "2001:db8::1",
		"2001:DB8:0:0:0::/48":  "2001:db8::/48",
		"::ffff:1.2.3.4":       "1.2.3.4",
		"::ffff:1.2.3.0/120":   "1.2.3.0/24",
		"10.0.0.0/8":           "10.0.0.0/8",
		"2001:db8:aa:bb::7/64": "2001:db8:aa:bb::/64",
		"203.0.113.255/31":     "203.0.113.254/31",
	}
	for in, want := range ok {
		got, _, err := canonicalBanEntry(in)
		if err != nil || got != want {
			t.Errorf("canonicalBanEntry(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "abc", "1.2.3.4/33", "1.2.3", "1.2.3.4 accept", "fe80::1%eth0", "::ffff:1.2.3.4/64", "1.2.3.4-1.2.3.9"} {
		if got, _, err := canonicalBanEntry(in); err == nil {
			t.Errorf("canonicalBanEntry(%q) = %q, want an error", in, got)
		}
	}
}

func TestCanonicalBanListKeepsUnparseable(t *testing.T) {
	got := canonicalBanList([]string{"1.2.3.4/32", "1.2.3.4", "weird", "", "1.2.3.9/24"})
	want := []string{"1.2.3.4", "weird", "1.2.3.0/24"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestParseBanEntries(t *testing.T) {
	nft := "table inet obliguard {\n\tset obliguard_nets {\n\t\ttype ipv4_addr\n\t\tflags interval\n\t\telements = { 1.2.3.0/24, 5.6.7.8,\n\t\t\t     9.9.9.9 }\n\t}\n}\n"
	if got, want := parseNftElements(nft), []string{"1.2.3.0/24", "5.6.7.8", "9.9.9.9"}; !reflect.DeepEqual(got, want) {
		t.Errorf("nft: got %v want %v", got, want)
	}
	if got := parseNftElements("table inet obliguard {\n\tset obliguard_nets {\n\t\ttype ipv4_addr\n\t}\n}\n"); len(got) != 0 {
		t.Errorf("empty nft set: got %v", got)
	}
	ipset := "Name: obliguard\nType: hash:net\nRevision: 7\nHeader: family inet hashsize 1024 maxelem 1048576\nSize in memory: 1\nReferences: 2\nNumber of entries: 3\nMembers:\n1.2.3.0/24\n5.6.7.8\n10.0.0.0/16 timeout 0\n"
	if got, want := parseIpsetMembers(ipset), []string{"1.2.3.0/24", "5.6.7.8", "10.0.0.0/16"}; !reflect.DeepEqual(got, want) {
		t.Errorf("ipset: got %v want %v", got, want)
	}
	pf := "   1.2.3.0/24\n   5.6.7.8\n !  9.9.9.9\n   2001:db8::/48\n"
	if got, want := pfTableEntries(pf), []string{"1.2.3.0/24", "5.6.7.8", "2001:db8::/48"}; !reflect.DeepEqual(got, want) {
		t.Errorf("pf: got %v want %v", got, want)
	}
	ipt := "Chain OBLIGUARD (1 references)\ntarget     prot opt source               destination\nDROP       all  --  1.2.3.0/24           0.0.0.0/0\nDROP       all  --  5.6.7.8              0.0.0.0/0\n"
	if got, want := parseIptablesSources(ipt), []string{"1.2.3.0/24", "5.6.7.8"}; !reflect.DeepEqual(got, want) {
		t.Errorf("iptables: got %v want %v", got, want)
	}
	ufw := "Status: active\n\n     To                         Action      From\n     --                         ------      ----\n[ 1] Anywhere                   DENY IN     1.2.3.0/24\n[ 2] 1.2.3.0/24                 DENY OUT    Anywhere                   (out)\n[ 3] 22/tcp                     ALLOW IN    Anywhere\n[ 4] Anywhere                   DENY IN     5.6.7.8\n"
	if got, want := parseUfwDenyEntries(ufw, false), []string{"1.2.3.0/24", "5.6.7.8"}; !reflect.DeepEqual(got, want) {
		t.Errorf("ufw: got %v want %v", got, want)
	}
	if got, want := parseUfwDenyEntries(ufw, true), []string{"5.6.7.8"}; !reflect.DeepEqual(got, want) {
		t.Errorf("ufw hosts only: got %v want %v", got, want)
	}
}

// ── Overlap planner ───────────────────────────────────────────────────────────

func prefixMap(keys ...string) map[string]netip.Prefix {
	m := make(map[string]netip.Prefix)
	for _, k := range keys {
		ck, p, err := canonicalBanEntry(k)
		if err != nil {
			panic(err)
		}
		m[ck] = p
	}
	return m
}

func keysOf(m map[string]netip.Prefix) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestPlanIntervalSetHostInsideNetwork(t *testing.T) {
	present := prefixMap("1.2.3.0/24")
	covered := map[string]netip.Prefix{}
	toDel, toAdd := planIntervalSet(present, covered, []string{"1.2.3.77", "5.6.7.8"}, nil)
	if len(toDel) != 0 || !reflect.DeepEqual(toAdd, []string{"5.6.7.8"}) {
		t.Fatalf("toDel=%v toAdd=%v", toDel, toAdd)
	}
	if !reflect.DeepEqual(keysOf(covered), []string{"1.2.3.77"}) {
		t.Fatalf("covered=%v", keysOf(covered))
	}
	present["5.6.7.8"] = netip.MustParsePrefix("5.6.7.8/32")
	if got, want := reportWithCovered(present, covered), []string{"1.2.3.0/24", "1.2.3.77", "5.6.7.8"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("report=%v want %v", got, want)
	}
}

func TestPlanIntervalSetNetworkOverHosts(t *testing.T) {
	present := prefixMap("1.2.3.4", "1.2.3.5", "9.9.9.9")
	covered := map[string]netip.Prefix{}
	toDel, toAdd := planIntervalSet(present, covered, []string{"1.2.3.0/24"}, nil)
	if !reflect.DeepEqual(sorted(toDel), []string{"1.2.3.4", "1.2.3.5"}) || !reflect.DeepEqual(toAdd, []string{"1.2.3.0/24"}) {
		t.Fatalf("toDel=%v toAdd=%v", toDel, toAdd)
	}
	if !reflect.DeepEqual(keysOf(covered), []string{"1.2.3.4", "1.2.3.5"}) {
		t.Fatalf("covered=%v", keysOf(covered))
	}
}

func TestPlanIntervalSetRemovingNetworkRestoresHosts(t *testing.T) {
	present := prefixMap("1.2.3.0/24")
	covered := prefixMap("1.2.3.4", "1.2.3.77")
	toDel, toAdd := planIntervalSet(present, covered, nil, []string{"1.2.3.0/24", "1.2.3.4"})
	if !reflect.DeepEqual(toDel, []string{"1.2.3.0/24"}) || !reflect.DeepEqual(toAdd, []string{"1.2.3.77"}) {
		t.Fatalf("toDel=%v toAdd=%v", toDel, toAdd)
	}
	if len(covered) != 0 {
		t.Fatalf("covered=%v", keysOf(covered))
	}
}

func TestPlanIntervalSetAdjacentAndExisting(t *testing.T) {
	present := prefixMap("1.2.3.0/25")
	covered := map[string]netip.Prefix{}
	// Adjacent networks stay separate elements; an exact duplicate is skipped;
	// a wider network replaces both halves.
	toDel, toAdd := planIntervalSet(present, covered, []string{"1.2.3.128/25", "1.2.3.0/25"}, nil)
	if len(toDel) != 0 || !reflect.DeepEqual(toAdd, []string{"1.2.3.128/25"}) {
		t.Fatalf("toDel=%v toAdd=%v", toDel, toAdd)
	}
	present = prefixMap("1.2.3.0/25", "1.2.3.128/25")
	toDel, toAdd = planIntervalSet(present, covered, []string{"1.2.0.0/16"}, nil)
	if !reflect.DeepEqual(sorted(toDel), []string{"1.2.3.0/25", "1.2.3.128/25"}) || !reflect.DeepEqual(toAdd, []string{"1.2.0.0/16"}) {
		t.Fatalf("toDel=%v toAdd=%v", toDel, toAdd)
	}
	// IPv4 and IPv6 never cover each other.
	covered = map[string]netip.Prefix{}
	_, toAdd = planIntervalSet(prefixMap("::/0"), covered, []string{"1.2.3.4"}, nil)
	if !reflect.DeepEqual(toAdd, []string{"1.2.3.4"}) {
		t.Fatalf("cross-family cover: toAdd=%v", toAdd)
	}
}

// ── nftables (simulated kernel) ───────────────────────────────────────────────

// nftSim mimics the parts of nft the backend uses. Interval sets refuse
// overlapping elements (no auto-merge), like the kernel does.
type nftSim struct {
	sets     map[string]map[string]netip.Prefix
	interval map[string]bool
}

func newNftSim() *nftSim {
	return &nftSim{sets: map[string]map[string]netip.Prefix{}, interval: map[string]bool{}}
}

func (s *nftSim) listing(name string) string {
	var b strings.Builder
	b.WriteString("table inet obliguard {\n\tset " + name + " {\n\t\ttype ipv4_addr\n")
	if s.interval[name] {
		b.WriteString("\t\tflags interval\n")
	}
	if keys := keysOf(s.sets[name]); len(keys) > 0 {
		b.WriteString("\t\telements = { " + strings.Join(keys, ", ") + " }\n")
	}
	b.WriteString("\t}\n}\n")
	return b.String()
}

// stmt applies one nft statement to sets.
func (s *nftSim) stmt(sets map[string]map[string]netip.Prefix, interval map[string]bool, line string) error {
	f := strings.Fields(line)
	if len(f) < 3 {
		return nil
	}
	switch {
	case f[0] == "add" && f[1] == "set":
		name := f[4]
		if _, ok := sets[name]; !ok {
			sets[name] = map[string]netip.Prefix{}
			interval[name] = strings.Contains(line, "flags interval")
		}
		if strings.Contains(line, "auto-merge") {
			return errors.New("test: auto-merge must not be used")
		}
	case f[0] == "delete" && f[1] == "set":
		if _, ok := sets[f[4]]; !ok {
			return errors.New("No such file or directory")
		}
		delete(sets, f[4])
	case f[1] == "element":
		name := f[4]
		set, ok := sets[name]
		if !ok {
			return errors.New("No such file or directory")
		}
		body := line[strings.Index(line, "{")+1 : strings.LastIndex(line, "}")]
		for _, tok := range strings.Split(body, ",") {
			k, p, err := canonicalBanEntry(tok)
			if err != nil {
				return err
			}
			if f[0] == "delete" {
				if _, ok := set[k]; !ok {
					return errors.New("Could not process rule: No such file or directory")
				}
				delete(set, k)
				continue
			}
			if _, ok := set[k]; ok {
				continue
			}
			if !interval[name] && !isHostEntry(p) {
				return errors.New("test: prefix in a non-interval set")
			}
			for ek, ep := range set {
				if ep.Overlaps(p) {
					return errors.New("interval overlaps with an existing one: " + ek)
				}
			}
			set[k] = p
		}
	}
	return nil
}

func (s *nftSim) handle(c fakeCall) (string, error) {
	if c.name != "nft" {
		return "", nil
	}
	if len(c.args) == 5 && c.args[0] == "list" && c.args[1] == "set" {
		if _, ok := s.sets[c.args[4]]; !ok {
			return "", errors.New("No such file or directory")
		}
		return s.listing(c.args[4]), nil
	}
	// Transaction: apply to a copy, commit only when every statement succeeds.
	cp := map[string]map[string]netip.Prefix{}
	for n, set := range s.sets {
		cp[n] = map[string]netip.Prefix{}
		for k, p := range set {
			cp[n][k] = p
		}
	}
	iv := map[string]bool{}
	for n, v := range s.interval {
		iv[n] = v
	}
	var stmts []string
	if len(c.args) == 2 && c.args[0] == "-f" && c.args[1] == "-" {
		stmts = strings.Split(c.stdin, "\n")
	} else {
		stmts = []string{strings.Join(c.args, " ")}
	}
	for _, st := range stmts {
		if err := s.stmt(cp, iv, strings.TrimSpace(st)); err != nil {
			return "", err
		}
	}
	s.sets, s.interval = cp, iv
	return "", nil
}

// blocks reports whether addr matches any element of the ban sets.
func (s *nftSim) blocks(addr string) bool {
	a := netip.MustParseAddr(addr)
	for _, name := range []string{nftSet4, nftSet6, nftLegacySet} {
		for _, p := range s.sets[name] {
			if p.Contains(a) {
				return true
			}
		}
	}
	return false
}

func TestNftablesCIDR(t *testing.T) {
	sim := newNftSim()
	r := &fakeRunner{handle: sim.handle}
	useFakeRunner(t, r)
	fw := &NftablesFirewall{}

	for _, e := range []string{"1.2.3.0/24", "1.2.3.77", "2001:db8::/48", "5.6.7.8"} {
		if err := fw.BanIP(e); err != nil {
			t.Fatalf("BanIP(%s): %v", e, err)
		}
	}
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}

	init := r.stdins("nft -f -")[0]
	for _, want := range []string{
		"add set inet obliguard obliguard_nets { type ipv4_addr; flags interval; }",
		"add set inet obliguard obliguard_nets6 { type ipv6_addr; flags interval; }",
		"add rule inet obliguard blocklist ip saddr @obliguard_nets drop",
		"add rule inet obliguard blocklist ip6 saddr @obliguard_nets6 drop",
		"add rule inet obliguard blocklist_out ip daddr @obliguard_nets drop",
		"add rule inet obliguard blocklist_out ip6 daddr @obliguard_nets6 drop",
	} {
		if !strings.Contains(init, want) {
			t.Errorf("init script lacks %q:\n%s", want, init)
		}
	}
	scripts := r.stdins("nft -f -")
	last := scripts[len(scripts)-1]
	for _, want := range []string{
		"add element inet obliguard obliguard_nets { 1.2.3.0/24, 5.6.7.8 }",
		"add element inet obliguard obliguard_nets6 { 2001:db8::/48 }",
	} {
		if !strings.Contains(last, want) {
			t.Errorf("element script lacks %q:\n%s", want, last)
		}
	}
	if strings.Contains(last, "1.2.3.77") {
		t.Errorf("1.2.3.77 is covered by 1.2.3.0/24 and must not be inserted:\n%s", last)
	}

	// The /24 ban blocks 1.2.3.77; the report is the server's textual form.
	if !sim.blocks("1.2.3.77") || sim.blocks("1.2.4.1") {
		t.Fatal("1.2.3.0/24 must block 1.2.3.77 and only the /24")
	}
	got, _ := fw.GetBannedIPs()
	if want := []string{"1.2.3.0/24", "1.2.3.77", "2001:db8::/48", "5.6.7.8"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("GetBannedIPs = %v want %v", got, want)
	}

	// Lifting the /24 keeps the still-requested host banned.
	if err := fw.UnbanIP("1.2.3.0/24"); err != nil {
		t.Fatal(err)
	}
	if err := fw.Flush(); err != nil {
		t.Fatal(err)
	}
	if !sim.blocks("1.2.3.77") || sim.blocks("1.2.3.78") {
		t.Fatal("after lifting the /24 only 1.2.3.77 stays blocked")
	}
	got, _ = fw.GetBannedIPs()
	if want := []string{"1.2.3.77", "2001:db8::/48", "5.6.7.8"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("GetBannedIPs = %v want %v", got, want)
	}
}

func TestNftablesNetworkOverExistingHosts(t *testing.T) {
	sim := newNftSim()
	r := &fakeRunner{handle: sim.handle}
	useFakeRunner(t, r)
	fw := &NftablesFirewall{}
	fw.BanIP("1.2.3.4")
	fw.BanIP("1.2.3.5")
	fw.Flush()
	// Without the planner this add would be refused (overlap).
	fw.BanIP("1.2.3.0/24")
	fw.Flush()
	if got := keysOf(sim.sets[nftSet4]); !reflect.DeepEqual(got, []string{"1.2.3.0/24"}) {
		t.Fatalf("set = %v", got)
	}
	got, _ := fw.GetBannedIPs()
	if want := []string{"1.2.3.0/24", "1.2.3.4", "1.2.3.5"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("GetBannedIPs = %v want %v", got, want)
	}
}

func TestNftablesPerElementFallback(t *testing.T) {
	sim := newNftSim()
	r := &fakeRunner{handle: sim.handle}
	useFakeRunner(t, r)
	fw := &NftablesFirewall{}
	fw.GetBannedIPs() // init
	// An element added behind our back makes the batch overlap.
	sim.sets[nftSet4]["9.9.0.0/16"] = netip.MustParsePrefix("9.9.0.0/16")
	sim.sets[nftSet4]["7.7.7.0/24"] = netip.MustParsePrefix("7.7.7.0/24")
	fw.mu.Lock()
	failed := fw.apply(nil, []string{"9.9.9.9", "5.6.7.8"})
	fw.mu.Unlock()
	if failed != 1 || !sim.blocks("5.6.7.8") {
		t.Fatalf("failed=%d, 5.6.7.8 blocked=%v", failed, sim.blocks("5.6.7.8"))
	}
	mustHaveLine(t, r.lines(), "nft add element inet obliguard obliguard_nets { 5.6.7.8 }")
}

func TestNftablesWithoutStdinScripts(t *testing.T) {
	sim := newNftSim()
	r := &fakeRunner{handle: func(c fakeCall) (string, error) {
		if len(c.args) == 2 && c.args[0] == "-f" {
			return "", errors.New("unknown option -f -")
		}
		return sim.handle(c)
	}}
	useFakeRunner(t, r)
	fw := &NftablesFirewall{}
	if err := fw.BanIP("1.2.3.0/24"); err != nil {
		t.Fatalf("init must fall back to single statements: %v", err)
	}
	fw.Flush()
	if !sim.interval[nftSet4] || !sim.blocks("1.2.3.77") {
		t.Fatal("interval set not created / element not added")
	}
	mustHaveLine(t, r.lines(), "nft add element inet obliguard obliguard_nets { 1.2.3.0/24 }")
}

func TestNftablesLegacyMigration(t *testing.T) {
	sim := newNftSim()
	sim.sets[nftLegacySet] = prefixMap("5.6.7.8", "1.2.3.4")
	sim.interval[nftLegacySet] = false
	r := &fakeRunner{handle: sim.handle}
	useFakeRunner(t, r)
	fw := &NftablesFirewall{}

	got, _ := fw.GetBannedIPs()
	if want := []string{"1.2.3.4", "5.6.7.8"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("GetBannedIPs = %v want %v", got, want)
	}
	if _, ok := sim.sets[nftLegacySet]; ok {
		t.Fatal("legacy set must be deleted after migration")
	}
	if !sim.blocks("5.6.7.8") || fw.legacy {
		t.Fatal("legacy entries must be enforced by the interval set")
	}
	scripts := r.stdins("nft -f -")
	if !strings.Contains(scripts[0], "ip saddr @obliguard_ips drop") {
		t.Fatalf("init must keep the legacy rules until the copy is done:\n%s", scripts[0])
	}
	if s := scripts[len(scripts)-1]; strings.Contains(s, "obliguard_ips") || !strings.Contains(s, "flush chain inet obliguard blocklist") {
		t.Fatalf("final chain switch must drop the legacy rules:\n%s", s)
	}
	mustHaveLine(t, r.lines(), "nft delete set inet obliguard obliguard_ips")
}

// ── iptables / ipset ──────────────────────────────────────────────────────────

func ipsetHandler(types map[string]string, members map[string]string, destroyFails map[string]bool) func(c fakeCall) (string, error) {
	return func(c fakeCall) (string, error) {
		l := c.line()
		switch {
		case strings.HasPrefix(l, "ipset list -t "):
			name := c.args[2]
			if typ, ok := types[name]; ok {
				return "Name: " + name + "\nType: " + typ + "\n", nil
			}
			return "", errors.New("The set with the given name does not exist")
		case strings.HasPrefix(l, "ipset list "):
			return "Name: x\nMembers:\n" + members[c.args[1]], nil
		case strings.HasPrefix(l, "ipset destroy "):
			if destroyFails[c.args[1]] {
				return "", errors.New("Set cannot be destroyed: it is in use by a kernel component")
			}
			delete(types, c.args[1])
		case strings.HasPrefix(l, "ipset create "):
			types[c.args[1]] = c.args[2]
		}
		return "", nil
	}
}

func TestIptablesIpsetCIDR(t *testing.T) {
	r := &fakeRunner{handle: ipsetHandler(map[string]string{"obliguard": "hash:net"}, map[string]string{"obliguard": "1.2.3.0/24\n5.6.7.8\n"}, nil)}
	useFakeRunner(t, r)
	fw := &IptablesFirewall{}
	if err := fw.BanIP("1.2.3.0/24"); err != nil {
		t.Fatal(err)
	}
	if err := fw.BanIP("2001:db8::/48"); err == nil {
		t.Fatal("IPv6 must be refused by the iptables backend")
	}
	fw.UnbanIP("9.9.9.9")
	fw.Flush()
	restore := r.stdins("ipset restore")
	if len(restore) != 1 || restore[0] != "del obliguard 9.9.9.9 -exist\nadd obliguard 1.2.3.0/24 -exist\n" {
		t.Fatalf("ipset restore stdin = %q", restore)
	}
	mustHaveLine(t, r.lines(), "iptables -A OBLIGUARD -m set --match-set obliguard src -j DROP")
	mustHaveLine(t, r.lines(), "iptables -A OBLIGUARD_OUT -m set --match-set obliguard dst -j DROP")
	got, _ := fw.GetBannedIPs()
	if want := []string{"1.2.3.0/24", "5.6.7.8"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("GetBannedIPs = %v want %v", got, want)
	}
	if caps := firewallCapabilities(fw); !reflect.DeepEqual(caps, []string{"cidr"}) {
		t.Fatalf("capabilities = %v", caps)
	}
}

func TestIptablesIpsetMigration(t *testing.T) {
	types := map[string]string{"obliguard": "hash:ip"}
	r := &fakeRunner{handle: ipsetHandler(types, map[string]string{"obliguard": "5.6.7.8\n1.2.3.4\n"}, nil)}
	useFakeRunner(t, r)
	fw := &IptablesFirewall{}
	if !fw.SupportsCIDR() {
		t.Fatal("migration should enable CIDR")
	}
	lines := r.lines()
	order := []string{
		"ipset create obliguard_mig hash:net maxelem 1048576",
		"iptables -A OBLIGUARD -m set --match-set obliguard_mig src -j DROP",
		"iptables -D OBLIGUARD -m set --match-set obliguard src -j DROP",
		"ipset destroy obliguard",
		"ipset create obliguard hash:net maxelem 1048576",
		"iptables -A OBLIGUARD -m set --match-set obliguard src -j DROP",
		"iptables -D OBLIGUARD -m set --match-set obliguard_mig src -j DROP",
		"ipset destroy obliguard_mig",
	}
	prev := -1
	for _, want := range order {
		i := indexOfLine(lines[prev+1:], want)
		if i < 0 {
			t.Fatalf("missing %q (in order) in:\n%s", want, strings.Join(lines, "\n"))
		}
		prev += i + 1
	}
	restore := r.stdins("ipset restore")
	if len(restore) < 2 || restore[0] != "add obliguard_mig 5.6.7.8 -exist\nadd obliguard_mig 1.2.3.4 -exist\n" || restore[1] != "add obliguard 5.6.7.8 -exist\nadd obliguard 1.2.3.4 -exist\n" {
		t.Fatalf("members not copied: %q", restore)
	}
	if types["obliguard"] != "hash:net" {
		t.Fatalf("obliguard type = %q", types["obliguard"])
	}
}

func TestIptablesIpsetMigrationRollback(t *testing.T) {
	types := map[string]string{"obliguard": "hash:ip"}
	r := &fakeRunner{handle: ipsetHandler(types, map[string]string{"obliguard": "5.6.7.8\n"}, map[string]bool{"obliguard": true})}
	useFakeRunner(t, r)
	fw := &IptablesFirewall{}
	if fw.SupportsCIDR() {
		t.Fatal("a failed migration must disable CIDR")
	}
	if caps := firewallCapabilities(fw); caps != nil {
		t.Fatalf("capabilities must not advertise cidr: %v", caps)
	}
	if err := fw.BanIP("1.2.3.0/24"); err == nil {
		t.Fatal("CIDR must be refused by a hash:ip set (it would expand to every address)")
	}
	if err := fw.BanIP("1.2.3.4"); err != nil {
		t.Fatalf("hosts still work: %v", err)
	}
	lines := r.lines()
	mustHaveLine(t, lines, "iptables -A OBLIGUARD -m set --match-set obliguard src -j DROP")
	mustHaveLine(t, lines, "ipset destroy obliguard_mig")
}

func TestIptablesIpsetMigrationRenameFallback(t *testing.T) {
	types := map[string]string{"obliguard": "hash:ip"}
	base := ipsetHandler(types, map[string]string{"obliguard": "5.6.7.8\n"}, nil)
	r := &fakeRunner{handle: func(c fakeCall) (string, error) {
		if c.line() == "ipset create obliguard hash:net maxelem 1048576" {
			return "", errors.New("Kernel error received: Cannot allocate memory")
		}
		if c.line() == "ipset rename obliguard_mig obliguard" {
			types["obliguard"] = types["obliguard_mig"]
			delete(types, "obliguard_mig")
			return "", nil
		}
		return base(c)
	}}
	useFakeRunner(t, r)
	fw := &IptablesFirewall{}
	if !fw.SupportsCIDR() {
		t.Fatal("the renamed hash:net set should enable CIDR")
	}
	lines := r.lines()
	mustHaveLine(t, lines, "ipset rename obliguard_mig obliguard")
	if indexOfLine(lines, "ipset destroy obliguard_mig") > indexOfLine(lines, "ipset rename obliguard_mig obliguard") {
		t.Fatal("the renamed set must not be destroyed")
	}
	if types["obliguard"] != "hash:net" {
		t.Fatalf("obliguard type = %q", types["obliguard"])
	}
}

func TestIptablesNoIpsetCIDR(t *testing.T) {
	r := &fakeRunner{missing: map[string]bool{"ipset": true}, handle: func(c fakeCall) (string, error) {
		if c.line() == "iptables -L OBLIGUARD -n" {
			return "Chain OBLIGUARD (1 references)\ntarget     prot opt source               destination\nDROP       all  --  1.2.3.0/24           0.0.0.0/0\n", nil
		}
		return "", nil
	}}
	useFakeRunner(t, r)
	fw := &IptablesFirewall{}
	fw.BanIP("1.2.3.0/24")
	fw.UnbanIP("1.2.3.0/24")
	lines := r.lines()
	mustHaveLine(t, lines, "iptables -A OBLIGUARD -s 1.2.3.0/24 -j DROP")
	mustHaveLine(t, lines, "iptables -A OBLIGUARD_OUT -d 1.2.3.0/24 -j DROP")
	mustHaveLine(t, lines, "iptables -D OBLIGUARD -s 1.2.3.0/24 -j DROP")
	got, _ := fw.GetBannedIPs()
	if !reflect.DeepEqual(got, []string{"1.2.3.0/24"}) {
		t.Fatalf("GetBannedIPs = %v", got)
	}
}

// ── ufw ───────────────────────────────────────────────────────────────────────

func TestUFWCIDR(t *testing.T) {
	r := &fakeRunner{missing: map[string]bool{"ipset": true}}
	useFakeRunner(t, r)
	fw := &UFWFirewall{}
	fw.BanIP("1.2.3.0/24")
	fw.UnbanIP("1.2.3.0/24")
	lines := r.lines()
	mustHaveLine(t, lines, "ufw insert 1 deny from 1.2.3.0/24 to any")
	mustHaveLine(t, lines, "ufw insert 1 deny out from any to 1.2.3.0/24")
	mustHaveLine(t, lines, "ufw delete deny from 1.2.3.0/24 to any")

	r2 := &fakeRunner{handle: ipsetHandler(map[string]string{"obliguard": "hash:net"}, nil, nil)}
	useFakeRunner(t, r2)
	fw2 := &UFWFirewall{}
	fw2.BanIP("1.2.3.0/24")
	fw2.Flush()
	if restore := r2.stdins("ipset restore"); len(restore) != 1 || restore[0] != "add obliguard 1.2.3.0/24 -exist\n" {
		t.Fatalf("ipset restore stdin = %q", restore)
	}
	mustHaveLine(t, r2.lines(), "iptables -C INPUT -m set --match-set obliguard src -j DROP")
}

// ── firewalld ─────────────────────────────────────────────────────────────────

// fwdSim emulates firewall-cmd with obliguard (hash:ip) and obliguard_net
// (hash:net) ipsets, runtime and permanent. Like firewalld >= 1.2 it refuses a
// hash:net entry that overlaps an existing one (INVALID_ENTRY), which also
// fails a whole --add-entries-from-file batch.
type fwdSim struct {
	mu      sync.Mutex
	runtime map[string]map[string]netip.Prefix
	perm    map[string]map[string]netip.Prefix
	files   map[string]string // ipset → entries passed through --add-entries-from-file
	refused int
}

func newFwdSim(hosts, nets []string) *fwdSim {
	s := &fwdSim{
		runtime: map[string]map[string]netip.Prefix{"obliguard": {}, "obliguard_net": {}},
		perm:    map[string]map[string]netip.Prefix{"obliguard": {}, "obliguard_net": {}},
		files:   map[string]string{},
	}
	for _, h := range hosts {
		k, p, _ := canonicalBanEntry(h)
		s.runtime["obliguard"][k], s.perm["obliguard"][k] = p, p
	}
	for _, n := range nets {
		k, p, _ := canonicalBanEntry(n)
		s.runtime["obliguard_net"][k], s.perm["obliguard_net"][k] = p, p
	}
	return s
}

// add inserts entries into one set, all or nothing (as a batch).
func (s *fwdSim) add(set map[string]netip.Prefix, isNet bool, entries []string) error {
	staged := make(map[string]netip.Prefix)
	for _, e := range entries {
		k, p, err := canonicalBanEntry(e)
		if err != nil {
			return err
		}
		if _, dup := set[k]; dup {
			continue
		}
		if isNet {
			for ek, ep := range set {
				if ep.Overlaps(p) {
					s.refused++
					return fmt.Errorf("INVALID_ENTRY: Entry '%s' overlaps with existing entry '%s'", k, ek)
				}
			}
			for ek, ep := range staged {
				if ep.Overlaps(p) {
					s.refused++
					return fmt.Errorf("INVALID_ENTRY: Entry '%s' overlaps with existing entry '%s'", k, ek)
				}
			}
		}
		staged[k] = p
	}
	for k, p := range staged {
		set[k] = p
	}
	return nil
}

func (s *fwdSim) handle(c fakeCall) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := c.line()
	switch {
	case strings.HasSuffix(l, "--get-ipsets"):
		return "obliguard obliguard_net\n", nil
	case strings.HasSuffix(l, "--list-rich-rules"):
		return "rule family=\"ipv4\" source ipset=\"obliguard\" drop\nrule family=\"ipv4\" destination ipset=\"obliguard\" drop\nrule family=\"ipv4\" source ipset=\"obliguard_net\" drop\nrule family=\"ipv4\" destination ipset=\"obliguard_net\" drop\n", nil
	case l == "firewall-cmd --help":
		return "  --add-entries-from-file=<filename>\n", nil
	}
	sets, setName := s.runtime, ""
	for _, a := range c.args {
		if a == "--permanent" {
			sets = s.perm
		}
		if strings.HasPrefix(a, "--ipset=") {
			setName = strings.TrimPrefix(a, "--ipset=")
		}
	}
	set := sets[setName]
	if set == nil {
		return "", nil
	}
	isNet := setName == "obliguard_net"
	for _, a := range c.args {
		switch {
		case a == "--get-entries":
			keys := make([]string, 0, len(set))
			for k := range set {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			return strings.Join(keys, "\n") + "\n", nil
		case strings.HasPrefix(a, "--add-entries-from-file="):
			data, _ := os.ReadFile(strings.TrimPrefix(a, "--add-entries-from-file="))
			s.files[setName] += string(data)
			return "", s.add(set, isNet, strings.Fields(string(data)))
		case strings.HasPrefix(a, "--add-entry="):
			return "", s.add(set, isNet, []string{strings.TrimPrefix(a, "--add-entry=")})
		case strings.HasPrefix(a, "--remove-entry="):
			k, _, _ := canonicalBanEntry(strings.TrimPrefix(a, "--remove-entry="))
			if _, ok := set[k]; !ok {
				return "", errors.New("NOT_ENABLED")
			}
			delete(set, k)
			return "", nil
		}
	}
	return "", nil
}

func (s *fwdSim) keys(sets map[string]map[string]netip.Prefix, name string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return sorted(keysOf(sets[name]))
}

func TestFirewalldCIDR(t *testing.T) {
	sim := newFwdSim(nil, []string{"9.9.0.0/16"})
	r := &fakeRunner{handle: sim.handle}
	useFakeRunner(t, r)
	fw := &FirewalldFirewall{}
	if err := fw.BanIP("1.2.3.0/24"); err != nil {
		t.Fatal(err)
	}
	fw.BanIP("5.6.7.8")
	fw.UnbanIP("9.9.0.0/16")
	fw.Flush()
	lines := r.lines()
	if indexOfLine(lines, "firewall-cmd --reload") >= 0 {
		t.Fatal("a complete runtime state must not trigger --reload")
	}
	mustHaveLine(t, lines, "firewall-cmd --ipset=obliguard_net --remove-entry=9.9.0.0/16")
	mustHaveLine(t, lines, "firewall-cmd --permanent --ipset=obliguard_net --remove-entry=9.9.0.0/16")
	// runtime + permanent, each set gets its own entries
	if sim.files["obliguard_net"] != "1.2.3.0/24\n1.2.3.0/24\n" || sim.files["obliguard"] != "5.6.7.8\n5.6.7.8\n" {
		t.Fatalf("entries files = %q", sim.files)
	}
	got, _ := fw.GetBannedIPs()
	if want := []string{"5.6.7.8", "1.2.3.0/24"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("GetBannedIPs = %v want %v", got, want)
	}
}

func TestFirewalldOverlappingNetworks(t *testing.T) {
	sim := newFwdSim(nil, []string{"1.2.0.0/16"})
	r := &fakeRunner{handle: sim.handle}
	useFakeRunner(t, r)
	fw := &FirewalldFirewall{}

	// A network inside a banned network is not inserted, but reported.
	fw.BanIP("1.2.3.0/24")
	// Two overlapping networks in one delta: only the wider one is inserted.
	fw.BanIP("5.0.1.0/24")
	fw.BanIP("5.0.0.0/16")
	fw.Flush()
	if sim.refused != 0 {
		t.Fatalf("firewalld refused %d overlapping batch(es)", sim.refused)
	}
	want := []string{"1.2.0.0/16", "5.0.0.0/16"}
	if got := sim.keys(sim.runtime, "obliguard_net"); !reflect.DeepEqual(got, want) {
		t.Fatalf("runtime net set = %v want %v", got, want)
	}
	if got := sim.keys(sim.perm, "obliguard_net"); !reflect.DeepEqual(got, want) {
		t.Fatalf("permanent net set = %v want %v", got, want)
	}
	got, _ := fw.GetBannedIPs()
	if want := []string{"1.2.0.0/16", "1.2.3.0/24", "5.0.0.0/16", "5.0.1.0/24"}; !reflect.DeepEqual(sorted(got), want) {
		t.Fatalf("GetBannedIPs = %v want %v", got, want)
	}

	// A wider network retires the narrower one it contains.
	fw.BanIP("7.7.7.0/24")
	fw.Flush()
	fw.BanIP("7.7.0.0/16")
	fw.Flush()
	if sim.refused != 0 {
		t.Fatalf("firewalld refused %d overlapping batch(es)", sim.refused)
	}
	want = []string{"1.2.0.0/16", "5.0.0.0/16", "7.7.0.0/16"}
	if got := sim.keys(sim.runtime, "obliguard_net"); !reflect.DeepEqual(got, want) {
		t.Fatalf("runtime net set = %v want %v", got, want)
	}

	// Lifting the covering network re-inserts what it was hiding.
	fw.UnbanIP("1.2.0.0/16")
	fw.Flush()
	want = []string{"1.2.3.0/24", "5.0.0.0/16", "7.7.0.0/16"}
	if got := sim.keys(sim.runtime, "obliguard_net"); !reflect.DeepEqual(got, want) {
		t.Fatalf("runtime net set = %v want %v", got, want)
	}
	if got := sim.keys(sim.perm, "obliguard_net"); !reflect.DeepEqual(got, want) {
		t.Fatalf("permanent net set = %v want %v", got, want)
	}
	got, _ = fw.GetBannedIPs()
	if want := []string{"1.2.3.0/24", "5.0.0.0/16", "5.0.1.0/24", "7.7.0.0/16", "7.7.7.0/24"}; !reflect.DeepEqual(sorted(got), want) {
		t.Fatalf("GetBannedIPs = %v want %v", got, want)
	}
}

func TestFirewalldCreatesNetSet(t *testing.T) {
	r := &fakeRunner{handle: func(c fakeCall) (string, error) {
		if strings.HasSuffix(c.line(), "--get-ipsets") {
			return "obliguard\n", nil // obliguard_net is a different set
		}
		if strings.HasSuffix(c.line(), "--list-rich-rules") {
			return "rule family=\"ipv4\" source ipset=\"obliguard\" drop\nrule family=\"ipv4\" destination ipset=\"obliguard\" drop\n", nil
		}
		return "", nil
	}}
	useFakeRunner(t, r)
	fw := &FirewalldFirewall{}
	if !fw.SupportsCIDR() {
		t.Fatal("net set creation should enable CIDR")
	}
	lines := r.lines()
	mustHaveLine(t, lines, "firewall-cmd --permanent --new-ipset=obliguard_net --type=hash:net --option=maxelem=1048576")
	mustHaveLine(t, lines, "firewall-cmd --permanent --add-rich-rule=rule family=ipv4 source ipset=obliguard_net drop")
	mustHaveLine(t, lines, "firewall-cmd --permanent --add-rich-rule=rule family=ipv4 destination ipset=obliguard_net drop")
	mustHaveLine(t, lines, "firewall-cmd --reload")
	if indexOfLine(lines, "firewall-cmd --permanent --new-ipset=obliguard --type=hash:ip --option=maxelem=1048576") >= 0 {
		t.Fatal("the host set already exists")
	}
	if fwdHasSetRule("rule source ipset=\"obliguard_net\" drop", "source", "obliguard") {
		t.Fatal("obliguard_net rule must not count as the obliguard rule")
	}
}

func TestFirewalldRichRuleFallback(t *testing.T) {
	r := &fakeRunner{handle: func(c fakeCall) (string, error) {
		switch c.line() {
		case "firewall-cmd --permanent --get-ipsets":
			return "", nil
		case "firewall-cmd --list-rich-rules":
			return "rule family=\"ipv4\" source address=\"1.2.3.0/24\" drop\nrule family=\"ipv4\" destination address=\"1.2.3.0/24\" drop\n", nil
		}
		if strings.Contains(c.line(), "--new-ipset") {
			return "", errors.New("no ipset support")
		}
		return "", nil
	}}
	useFakeRunner(t, r)
	fw := &FirewalldFirewall{}
	fw.BanIP("1.2.3.0/24")
	mustHaveLine(t, r.lines(), "firewall-cmd --permanent --add-rich-rule=rule family=ipv4 source address=1.2.3.0/24 drop")
	got, _ := fw.GetBannedIPs()
	if !reflect.DeepEqual(got, []string{"1.2.3.0/24"}) {
		t.Fatalf("GetBannedIPs = %v", got)
	}
}

// ── netsh ─────────────────────────────────────────────────────────────────────

func TestNetshCIDR(t *testing.T) {
	r := &fakeRunner{}
	useFakeRunner(t, r)
	file := filepath.Join(t.TempDir(), "obliguard-banlist.txt")
	fw := &WindowsFirewall{banlistFile: file}
	fw.BanIP("1.2.3.0/24")
	fw.BanIP("5.6.7.8/32")
	fw.BanIP("2001:db8::/48")
	if err := fw.BanIP("1.2.3.4 action=allow"); err == nil {
		t.Fatal("garbage must be refused")
	}
	fw.Flush()
	mustHaveLine(t, r.lines(), "netsh advfirewall firewall add rule name=Obliguard-Block-in dir=in action=block remoteip=1.2.3.0/24,2001:db8::/48,5.6.7.8 enable=yes description=Obliguard blocked IPs")
	mustHaveLine(t, r.lines(), "netsh advfirewall firewall add rule name=Obliguard-Block-out dir=out action=block remoteip=1.2.3.0/24,2001:db8::/48,5.6.7.8 enable=yes description=Obliguard blocked IPs")
	got, _ := fw.GetBannedIPs()
	if want := []string{"1.2.3.0/24", "2001:db8::/48", "5.6.7.8"}; !reflect.DeepEqual(sorted(got), want) {
		t.Fatalf("GetBannedIPs = %v want %v", got, want)
	}
	// The banlist file round-trips CIDR entries.
	again := &WindowsFirewall{banlistFile: file}
	got, _ = again.GetBannedIPs()
	if want := []string{"1.2.3.0/24", "2001:db8::/48", "5.6.7.8"}; !reflect.DeepEqual(sorted(got), want) {
		t.Fatalf("reloaded GetBannedIPs = %v want %v", got, want)
	}
	again.UnbanIP("1.2.3.0/24")
	got, _ = again.GetBannedIPs()
	if want := []string{"2001:db8::/48", "5.6.7.8"}; !reflect.DeepEqual(sorted(got), want) {
		t.Fatalf("after unban GetBannedIPs = %v want %v", got, want)
	}
}

func TestNetshLegacyCleanupKeepsGroupedRules(t *testing.T) {
	r := &fakeRunner{handle: func(c fakeCall) (string, error) {
		if strings.HasPrefix(c.line(), "netsh advfirewall firewall show rule") {
			return "Rule Name:   Obliguard-Block-in-1\nRule Name:   Obliguard-Block-in-2\nRule Name:   Obliguard-Block-1-2-3-4-in\n", nil
		}
		return "", nil
	}}
	useFakeRunner(t, r)
	fw := &WindowsFirewall{banlistFile: filepath.Join(t.TempDir(), "obliguard-banlist.txt")}
	for i := 0; i < maxIPsPerRule+1; i++ {
		fw.BanIP(fmt.Sprintf("10.%d.%d.1", i/250, i%250))
	}
	fw.Flush()
	lines := r.lines()
	mustHaveLine(t, lines, "netsh advfirewall firewall delete rule name=Obliguard-Block-1-2-3-4-in")
	// The chunk rule is (re)created after its last delete, never deleted after.
	lastDel, lastAdd := -1, -1
	for i, l := range lines {
		if l == "netsh advfirewall firewall delete rule name=Obliguard-Block-in-1" {
			lastDel = i
		}
		if strings.HasPrefix(l, "netsh advfirewall firewall add rule name=Obliguard-Block-in-1 ") {
			lastAdd = i
		}
	}
	if lastAdd < 0 || lastDel > lastAdd {
		t.Fatal("the legacy cleanup deleted a grouped chunk rule it had just created")
	}
	for _, name := range []string{"Obliguard-Block-in", "Obliguard-Block-out-12"} {
		if !isGroupedRuleName(name) {
			t.Fatalf("%s is a grouped rule", name)
		}
	}
	for _, name := range []string{"Obliguard-Block-1-2-3-4-in", "Obliguard-Block-in-", "Obliguard-Block-in-x"} {
		if isGroupedRuleName(name) {
			t.Fatalf("%s is not a grouped rule", name)
		}
	}
}

// ── pf ────────────────────────────────────────────────────────────────────────

func TestPFCIDR(t *testing.T) {
	r := &fakeRunner{handle: func(c fakeCall) (string, error) {
		if c.line() == "pfctl -a obliguard -t obliguard_blocklist -T show" {
			return "   1.2.3.0/24\n   5.6.7.8\n", nil
		}
		return "", nil
	}}
	useFakeRunner(t, r)
	mac := &PFFirewall{}
	mac.BanIP("1.2.3.77/24")
	mac.UnbanIP("1.2.3.0/24")
	bsd := &FreeBSDPFFirewall{}
	bsd.BanIP("2001:db8::/48")
	lines := r.lines()
	mustHaveLine(t, lines, "pfctl -a obliguard -t obliguard_blocklist -T add 1.2.3.0/24")
	mustHaveLine(t, lines, "pfctl -a obliguard -t obliguard_blocklist -T delete 1.2.3.0/24")
	mustHaveLine(t, lines, "pfctl -a obliguard -t obliguard_blocklist -T add 2001:db8::/48")
	for _, fw := range []FirewallManager{mac, bsd} {
		got, _ := fw.GetBannedIPs()
		if want := []string{"1.2.3.0/24", "5.6.7.8"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("%s GetBannedIPs = %v want %v", fw.Name(), got, want)
		}
	}
}

func TestFirewallCapabilities(t *testing.T) {
	if caps := firewallCapabilities(&NoOpFirewall{}); !reflect.DeepEqual(caps, []string{"cidr"}) {
		t.Fatalf("NoOp capabilities = %v", caps)
	}
	if caps := firewallCapabilities(&PFFirewall{}); !reflect.DeepEqual(caps, []string{"cidr"}) {
		t.Fatalf("pf capabilities = %v", caps)
	}
}
