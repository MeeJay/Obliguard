package main

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type guardFixture struct {
	g       *banSafety
	logs    []string
	lookups int
	now     time.Time
	local   []netip.Addr
	gw      []netip.Addr
	dns     map[string][]netip.Addr
	dnsErr  error
}

func addrs(ss ...string) []netip.Addr {
	var out []netip.Addr
	for _, s := range ss {
		out = append(out, netip.MustParseAddr(s))
	}
	return out
}

func newGuardFixture(serverURL string) *guardFixture {
	fx := &guardFixture{
		now:   time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC),
		local: addrs("127.0.0.1", "192.168.1.20", "::1"),
		gw:    addrs("192.168.1.1"),
		dns:   map[string][]netip.Addr{"guard.example.com": addrs("203.0.113.10", "2001:db8:5::10")},
	}
	g := newBanSafety(serverURL)
	g.resolve = func(_ context.Context, host string) ([]netip.Addr, error) {
		fx.lookups++
		if fx.dnsErr != nil {
			return nil, fx.dnsErr
		}
		a, ok := fx.dns[host]
		if !ok {
			return nil, errors.New("no such host")
		}
		return a, nil
	}
	g.localAddrs = func() []netip.Addr { return fx.local }
	g.gateways = func() []netip.Addr { return fx.gw }
	g.now = func() time.Time { return fx.now }
	g.logf = func(format string, args ...any) { fx.logs = append(fx.logs, fmt.Sprintf(format, args...)) }
	fx.g = g
	return fx
}

func TestBanSafetyFloors(t *testing.T) {
	fx := newGuardFixture("https://guard.example.com")
	in := []string{"8.8.0.0/16", "8.0.0.0/15", "8.8.8.0/24", "2001:db8:aa::/48", "2001:db8::/47", "2001:db8:aa:1::/64"}
	got := fx.g.Filter(in)
	want := []string{"8.8.0.0/16", "8.8.8.0/24", "2001:db8:aa::/48", "2001:db8:aa:1::/64"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Filter = %v want %v", got, want)
	}
	if len(fx.logs) != 2 || !strings.Contains(fx.logs[0], "8.0.0.0/15 (wider than /16)") || !strings.Contains(fx.logs[1], "2001:db8::/47 (wider than /48)") {
		t.Fatalf("logs = %v", fx.logs)
	}
}

func TestBanSafetyFloorEnv(t *testing.T) {
	t.Setenv(banSafetyEnvV4, "24")
	t.Setenv(banSafetyEnvV6, "200")
	fx := newGuardFixture("https://guard.example.com")
	if fx.g.minV4 != 24 || fx.g.minV6 != 128 {
		t.Fatalf("floors = /%d /%d, want /24 /128 (clamped)", fx.g.minV4, fx.g.minV6)
	}
	if got := fx.g.Filter([]string{"8.8.0.0/16", "8.8.8.0/24", "2001:db8::/64", "2001:db8::1"}); !reflect.DeepEqual(got, []string{"8.8.8.0/24", "2001:db8::1"}) {
		t.Fatalf("Filter = %v", got)
	}

	for _, tc := range []struct {
		raw  string
		want int
	}{{"", 16}, {"abc", 16}, {"+20", 16}, {"-1", 16}, {"1000", 16}, {"4", 8}, {"20", 20}, {" 12 ", 12}} {
		t.Setenv(banSafetyEnvV4, tc.raw)
		if got := readBanFloor(banSafetyEnvV4, defaultBanMinPrefixV4, 8, 32, func(string, ...any) {}); got != tc.want {
			t.Errorf("%s=%q → /%d want /%d", banSafetyEnvV4, tc.raw, got, tc.want)
		}
	}
}

func TestBanSafetyReserved(t *testing.T) {
	fx := newGuardFixture("https://guard.example.com")
	refused := []string{"127.0.0.5", "0.0.0.0", "0.1.0.0/16", "169.254.10.1", "224.0.0.1", "239.1.0.0/16", "240.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "ff02::1"}
	if got := fx.g.Filter(refused); len(got) != 0 {
		t.Fatalf("reserved entries passed: %v", got)
	}
	for _, l := range fx.logs {
		if !strings.Contains(l, "reserved range") {
			t.Fatalf("unexpected reason: %s", l)
		}
	}
	// Private and CGNAT ranges are not reserved here (the server decides for
	// auto-bans); only the agent's own subnet addresses are protected.
	if got := fx.g.Filter([]string{"10.1.2.3", "100.64.1.1", "172.16.5.0/24"}); len(got) != 3 {
		t.Fatalf("Filter = %v", got)
	}
}

func TestBanSafetyProtectedAddresses(t *testing.T) {
	fx := newGuardFixture("https://guard.example.com:3001/")
	in := []string{
		"203.0.113.10",    // server (DNS)
		"203.0.113.0/24",  // contains the server
		"2001:db8:5::/48", // contains the server (v6)
		"192.168.1.20",    // agent interface
		"192.168.0.0/16",  // contains agent + gateway
		"192.168.1.1",     // gateway
		"203.0.113.11",    // ok
		"192.168.2.0/24",  // ok
	}
	got := fx.g.Filter(in)
	if want := []string{"203.0.113.11", "192.168.2.0/24"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Filter = %v want %v", got, want)
	}
	joined := strings.Join(fx.logs, "\n")
	for _, want := range []string{
		"refused 203.0.113.10 (covers the server address 203.0.113.10)",
		"refused 203.0.113.0/24 (covers the server address 203.0.113.10)",
		"refused 2001:db8:5::/48 (covers the server address 2001:db8:5::10)",
		"refused 192.168.1.20 (covers the agent address 192.168.1.20)",
		"refused 192.168.1.1 (covers the gateway address 192.168.1.1)",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("log lacks %q:\n%s", want, joined)
		}
	}
}

func TestBanSafetyLiteralServerURL(t *testing.T) {
	fx := newGuardFixture("http://198.51.100.7:3001")
	if got := fx.g.Filter([]string{"198.51.100.7", "198.51.100.8"}); !reflect.DeepEqual(got, []string{"198.51.100.8"}) {
		t.Fatalf("Filter = %v", got)
	}
	if fx.lookups != 0 {
		t.Fatalf("a literal server address must not be resolved (%d lookups)", fx.lookups)
	}
	fx6 := newGuardFixture("https://[2001:db8:9::1]:8443")
	if got := fx6.g.Filter([]string{"2001:db8:9::/48"}); len(got) != 0 {
		t.Fatalf("Filter = %v", got)
	}
}

func TestBanSafetyLogsOnceAndCanonicalizes(t *testing.T) {
	fx := newGuardFixture("https://guard.example.com")
	in := []string{"1.2.3.4/32", " 1.2.3.4", "1.2.3.77/24", "1.2.3.4 accept", "127.0.0.1"}
	for i := 0; i < 3; i++ {
		if got := fx.g.Filter(in); !reflect.DeepEqual(got, []string{"1.2.3.4", "1.2.3.0/24"}) {
			t.Fatalf("Filter = %v", got)
		}
	}
	if len(fx.logs) != 2 {
		t.Fatalf("each refused entry must be logged once, got %d logs: %v", len(fx.logs), fx.logs)
	}
	if !strings.Contains(fx.logs[0], "not an IP address or CIDR") {
		t.Fatalf("logs = %v", fx.logs)
	}
}

func TestBanSafetyRefresh(t *testing.T) {
	fx := newGuardFixture("https://guard.example.com")
	fx.g.Filter([]string{"8.8.8.8"})
	if fx.lookups != 1 {
		t.Fatalf("lookups = %d", fx.lookups)
	}
	// A new interface address is picked up only after the refresh interval.
	fx.local = append(fx.local, netip.MustParseAddr("8.8.4.4"))
	if got := fx.g.Filter([]string{"8.8.4.4"}); len(got) != 1 {
		t.Fatalf("cached set must still be in use: %v", got)
	}
	fx.now = fx.now.Add(banSafetyRefresh + time.Second)
	if got := fx.g.Filter([]string{"8.8.4.4"}); len(got) != 0 {
		t.Fatalf("refreshed set must protect 8.8.4.4: %v", got)
	}
	if fx.lookups != 2 {
		t.Fatalf("lookups = %d", fx.lookups)
	}
	// A DNS failure keeps the previous server addresses.
	fx.dnsErr = errors.New("timeout")
	fx.now = fx.now.Add(banSafetyRefresh + time.Second)
	if got := fx.g.Filter([]string{"203.0.113.10"}); len(got) != 0 {
		t.Fatalf("server must stay protected after a DNS failure: %v", got)
	}
}

func TestBanSafetyUnsafe(t *testing.T) {
	fx := newGuardFixture("https://guard.example.com")
	got := fx.g.Unsafe([]string{"5.6.7.8", "192.168.1.0/24", "203.0.113.10", "garbage", "10.0.0.0/8"})
	if want := []string{"192.168.1.0/24", "203.0.113.10", "10.0.0.0/8"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Unsafe = %v want %v", got, want)
	}
}

// memFirewall records ban operations (purge test).
type memFirewall struct {
	NoOpFirewall
	mu      sync.Mutex
	banned  []string
	unbans  []string
	flushes int
}

func (m *memFirewall) GetBannedIPs() ([]string, error) { return m.banned, nil }
func (m *memFirewall) UnbanIP(ip string) error {
	m.mu.Lock()
	m.unbans = append(m.unbans, ip)
	m.mu.Unlock()
	return nil
}
func (m *memFirewall) Flush() error { m.flushes++; return nil }

func TestPurgeUnsafeBans(t *testing.T) {
	fx := newGuardFixture("https://guard.example.com")
	agentBanSafetyMu.Lock()
	old := agentBanSafety
	agentBanSafety = fx.g
	agentBanSafetyMu.Unlock()
	t.Cleanup(func() {
		agentBanSafetyMu.Lock()
		agentBanSafety = old
		agentBanSafetyMu.Unlock()
	})

	fw := &memFirewall{banned: []string{"5.6.7.8", "192.168.1.1", "203.0.113.0/24"}}
	purgeUnsafeBans(&Config{ServerURL: "https://guard.example.com"}, fw)
	if !reflect.DeepEqual(fw.unbans, []string{"192.168.1.1", "203.0.113.0/24"}) || fw.flushes != 1 {
		t.Fatalf("unbans = %v flushes = %d", fw.unbans, fw.flushes)
	}

	clean := &memFirewall{banned: []string{"5.6.7.8"}}
	purgeUnsafeBans(&Config{ServerURL: "https://guard.example.com"}, clean)
	if len(clean.unbans) != 0 || clean.flushes != 0 {
		t.Fatal("nothing to purge must not touch the firewall")
	}
}

func TestServerHost(t *testing.T) {
	for in, want := range map[string]string{
		"https://guard.example.com":       "guard.example.com",
		"https://guard.example.com:3001/": "guard.example.com",
		"http://198.51.100.7:3001":        "198.51.100.7",
		"https://[2001:db8::1]:443":       "2001:db8::1",
		"guard.example.com":               "guard.example.com",
		"":                                "",
	} {
		if got := serverHost(in); got != want {
			t.Errorf("serverHost(%q) = %q want %q", in, got, want)
		}
	}
}

func TestGatewayParsers(t *testing.T) {
	route := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
		"eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n" +
		"eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n"
	if got := parseProcNetRoute(route); !reflect.DeepEqual(got, addrs("192.168.1.1")) {
		t.Errorf("parseProcNetRoute = %v", got)
	}
	v6 := "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003 eth0\n" +
		"20010db8000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001 eth0\n"
	if got := parseProcNetIPv6Route(v6); !reflect.DeepEqual(got, addrs("fe80::1")) {
		t.Errorf("parseProcNetIPv6Route = %v", got)
	}
	win := "===========================================================================\n" +
		"IPv4 Route Table\n===========================================================================\nActive Routes:\n" +
		"Network Destination        Netmask          Gateway       Interface  Metric\n" +
		"          0.0.0.0          0.0.0.0      10.0.0.254       10.0.0.12     25\n" +
		"          0.0.0.0          0.0.0.0         On-link       10.8.0.2     35\n"
	if got := parseWindowsRoutePrint(win); !reflect.DeepEqual(got, addrs("10.0.0.254")) {
		t.Errorf("parseWindowsRoutePrint = %v", got)
	}
	bsd := "   route to: default\ndestination: default\n       mask: default\n    gateway: 172.16.0.1\n  interface: em0\n"
	if got := parseBSDRouteGet(bsd); !reflect.DeepEqual(got, addrs("172.16.0.1")) {
		t.Errorf("parseBSDRouteGet = %v", got)
	}
	if got := parseBSDRouteGet("    gateway: fe80::1%em0\n"); !reflect.DeepEqual(got, addrs("fe80::1")) {
		t.Errorf("parseBSDRouteGet v6 = %v", got)
	}
}
