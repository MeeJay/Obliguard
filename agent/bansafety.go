package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── Ban safety ────────────────────────────────────────────────────────────────
//
// Last line of defence, applied to every add list before it reaches the
// firewall backend: the agent never enforces a ban that would cut itself off
// (its own addresses, its default gateway, its server) or black-hole a huge
// range, whatever the server sends.
//
// Mirrors server/src/utils/ipValidation.ts: RESERVED_BAN_RANGES (overlap test)
// and the prefix floors (DEFAULT_BAN_MIN_PREFIX_V4/V6 = 16/48, clamped to
// 8..32 / 16..128). The floors can be changed with OBLIGUARD_BAN_MIN_PREFIX_V4
// and OBLIGUARD_BAN_MIN_PREFIX_V6 (same meaning as the server's
// BAN_MIN_PREFIX_V4/V6). Refused entries are logged once each.

const (
	defaultBanMinPrefixV4 = 16
	defaultBanMinPrefixV6 = 48

	banSafetyEnvV4 = "OBLIGUARD_BAN_MIN_PREFIX_V4"
	banSafetyEnvV6 = "OBLIGUARD_BAN_MIN_PREFIX_V6"

	// banSafetyRefresh: how often the protected addresses (server DNS,
	// interfaces, gateway) are re-read.
	banSafetyRefresh = 5 * time.Minute
	// banSafetyDNSTimeout bounds the server host lookup.
	banSafetyDNSTimeout = 3 * time.Second
	// banSafetyMaxLogged bounds the "already logged" memory.
	banSafetyMaxLogged = 4096
)

// reservedBanRanges mirrors RESERVED_BAN_RANGES (server/src/utils/ipValidation.ts):
// this-network, loopback, link-local, multicast, class E, unspecified v6,
// loopback v6, link-local v6, multicast v6.
var reservedBanRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

// protectedAddr is an address the agent must keep reachable.
type protectedAddr struct {
	addr netip.Addr
	what string // "server", "agent", "gateway"
}

type banSafety struct {
	mu        sync.Mutex
	serverURL string
	minV4     int
	minV6     int

	server      []netip.Addr // last successful resolution of the server host
	protected   []protectedAddr
	refreshedAt time.Time
	logged      map[string]bool

	// Injection points (tests).
	resolve    func(ctx context.Context, host string) ([]netip.Addr, error)
	localAddrs func() []netip.Addr
	gateways   func() []netip.Addr
	now        func() time.Time
	logf       func(format string, args ...any)
}

var (
	agentBanSafetyMu sync.Mutex
	agentBanSafety   *banSafety
)

// banSafetyFor returns the process-wide guard for this server URL.
func banSafetyFor(serverURL string) *banSafety {
	agentBanSafetyMu.Lock()
	defer agentBanSafetyMu.Unlock()
	if agentBanSafety == nil || agentBanSafety.serverURL != serverURL {
		agentBanSafety = newBanSafety(serverURL)
	}
	return agentBanSafety
}

func newBanSafety(serverURL string) *banSafety {
	g := &banSafety{
		serverURL:  serverURL,
		logged:     make(map[string]bool),
		resolve:    resolveHost,
		localAddrs: interfaceAddrs,
		gateways:   defaultGateways,
		now:        time.Now,
		logf:       log.Printf,
	}
	g.minV4 = readBanFloor(banSafetyEnvV4, defaultBanMinPrefixV4, 8, 32, g.logf)
	g.minV6 = readBanFloor(banSafetyEnvV6, defaultBanMinPrefixV6, 16, 128, g.logf)
	return g
}

// readBanFloor parses a prefix floor from the environment with the server's
// rules: not a number → default, out of range → clamped.
func readBanFloor(name string, def, min, max int, logf func(string, ...any)) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || len(raw) > 3 || strings.Trim(raw, "0123456789") != "" {
		logf("Ban safety: %s=%q is not a number — using /%d", name, raw, def)
		return def
	}
	if n < min || n > max {
		clamped := n
		if clamped < min {
			clamped = min
		}
		if clamped > max {
			clamped = max
		}
		logf("Ban safety: %s=%d is out of range %d..%d — using /%d", name, n, min, max, clamped)
		return clamped
	}
	return n
}

// Filter returns the canonical entries of adds that are safe to enforce, in
// order and de-duplicated. Every refused entry is logged once.
func (g *banSafety) Filter(adds []string) []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.refreshLocked()
	out := make([]string, 0, len(adds))
	seen := make(map[string]bool, len(adds))
	for _, raw := range adds {
		k, p, err := canonicalBanEntry(raw)
		if err != nil {
			g.refuseLocked(strings.TrimSpace(raw), "not an IP address or CIDR")
			continue
		}
		if reason := g.checkLocked(p); reason != "" {
			g.refuseLocked(k, reason)
			continue
		}
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}

// Unsafe returns the entries of current that the guard would refuse (used to
// lift a self-ban left in the firewall by an older agent, or one that became
// unsafe when an address changed). Unparseable entries are not returned.
func (g *banSafety) Unsafe(current []string) []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.refreshLocked()
	var out []string
	for _, raw := range current {
		k, p, err := canonicalBanEntry(raw)
		if err != nil {
			continue
		}
		if reason := g.checkLocked(p); reason != "" {
			g.refuseLocked(k, reason)
			out = append(out, k)
		}
	}
	return out
}

// checkLocked returns "" when p is safe, otherwise the refusal reason.
func (g *banSafety) checkLocked(p netip.Prefix) string {
	if p.Addr().Is4() {
		if p.Bits() < g.minV4 {
			return fmt.Sprintf("wider than /%d", g.minV4)
		}
	} else if p.Bits() < g.minV6 {
		return fmt.Sprintf("wider than /%d", g.minV6)
	}
	for _, r := range reservedBanRanges {
		if r.Overlaps(p) {
			return "reserved range " + r.String()
		}
	}
	for _, pa := range g.protected {
		if p.Contains(pa.addr) {
			return fmt.Sprintf("covers the %s address %s", pa.what, pa.addr)
		}
	}
	return ""
}

func (g *banSafety) refuseLocked(entry, reason string) {
	key := entry + "|" + reason
	if g.logged[key] {
		return
	}
	if len(g.logged) >= banSafetyMaxLogged {
		g.logged = make(map[string]bool)
	}
	g.logged[key] = true
	g.logf("Ban safety: refused %s (%s)", entry, reason)
}

// refreshLocked re-reads the protected addresses when they are stale.
func (g *banSafety) refreshLocked() {
	now := g.now()
	if !g.refreshedAt.IsZero() && now.Sub(g.refreshedAt) < banSafetyRefresh {
		return
	}
	g.refreshedAt = now

	if addrs := g.resolveServer(); len(addrs) > 0 {
		g.server = addrs // keep the previous answer when DNS fails
	}
	var prot []protectedAddr
	add := func(a netip.Addr, what string) {
		if a.IsValid() {
			prot = append(prot, protectedAddr{addr: a.Unmap().WithZone(""), what: what})
		}
	}
	for _, a := range g.server {
		add(a, "server")
	}
	for _, a := range g.localAddrs() {
		add(a, "agent")
	}
	for _, a := range g.gateways() {
		add(a, "gateway")
	}
	g.protected = prot
}

// resolveServer returns the server host addresses (a literal host is used as is).
func (g *banSafety) resolveServer() []netip.Addr {
	host := serverHost(g.serverURL)
	if host == "" {
		return nil
	}
	if a, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{a}
	}
	ctx, cancel := context.WithTimeout(context.Background(), banSafetyDNSTimeout)
	defer cancel()
	addrs, err := g.resolve(ctx, host)
	if err != nil {
		g.logf("Ban safety: cannot resolve server host %s: %v", host, err)
		return nil
	}
	return addrs
}

// serverHost extracts the host of the configured server URL.
func serverHost(serverURL string) string {
	s := strings.TrimSpace(serverURL)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

func resolveHost(ctx context.Context, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

// interfaceAddrs returns every address configured on this machine.
func interfaceAddrs() []netip.Addr {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var out []netip.Addr
	for _, a := range addrs {
		var ip net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if na, ok := netip.AddrFromSlice(ip); ok {
			out = append(out, na.Unmap())
		}
	}
	return out
}

// ── Default gateway ───────────────────────────────────────────────────────────

// defaultGateways returns the default-route gateways of this machine
// (best effort; empty when they cannot be read).
func defaultGateways() []netip.Addr {
	switch runtime.GOOS {
	case "linux":
		var out []netip.Addr
		if data, err := os.ReadFile("/proc/net/route"); err == nil {
			out = append(out, parseProcNetRoute(string(data))...)
		}
		if data, err := os.ReadFile("/proc/net/ipv6_route"); err == nil {
			out = append(out, parseProcNetIPv6Route(string(data))...)
		}
		return out
	case "windows":
		out, err := exec.Command("route", "print", "-4", "0.0.0.0").Output()
		if err != nil {
			return nil
		}
		return parseWindowsRoutePrint(string(out))
	case "darwin", "freebsd":
		var res []netip.Addr
		if out, err := exec.Command("route", "-n", "get", "default").Output(); err == nil {
			res = append(res, parseBSDRouteGet(string(out))...)
		}
		if out, err := exec.Command("route", "-n", "get", "-inet6", "default").Output(); err == nil {
			res = append(res, parseBSDRouteGet(string(out))...)
		}
		return res
	}
	return nil
}

// parseProcNetRoute reads the default-route gateways of /proc/net/route
// (hex, host byte order — little-endian on every supported Linux arch).
func parseProcNetRoute(text string) []netip.Addr {
	var out []netip.Addr
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || f[1] != "00000000" || f[2] == "00000000" {
			continue
		}
		b, err := hex.DecodeString(f[2])
		if err != nil || len(b) != 4 {
			continue
		}
		out = append(out, netip.AddrFrom4([4]byte{b[3], b[2], b[1], b[0]}))
	}
	return out
}

// parseProcNetIPv6Route reads the default-route next hops of /proc/net/ipv6_route
// (dest, dest len, src, src len, next hop, ...; addresses in network order).
func parseProcNetIPv6Route(text string) []netip.Addr {
	const zero = "00000000000000000000000000000000"
	var out []netip.Addr
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 || f[0] != zero || f[1] != "00" || f[4] == zero {
			continue
		}
		b, err := hex.DecodeString(f[4])
		if err != nil || len(b) != 16 {
			continue
		}
		out = append(out, netip.AddrFrom16([16]byte(b)))
	}
	return out
}

// parseWindowsRoutePrint reads `route print -4 0.0.0.0`: rows
// "0.0.0.0  0.0.0.0  <gateway>  <interface>  <metric>". An on-link gateway
// (localized text) is skipped.
func parseWindowsRoutePrint(text string) []netip.Addr {
	var out []netip.Addr
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 || f[0] != "0.0.0.0" || f[1] != "0.0.0.0" {
			continue
		}
		if a, err := netip.ParseAddr(f[2]); err == nil && !a.IsUnspecified() {
			out = append(out, a)
		}
	}
	return out
}

// parseBSDRouteGet reads the "gateway:" line of `route -n get default`.
func parseBSDRouteGet(text string) []netip.Addr {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "gateway:") {
			continue
		}
		v := strings.TrimSpace(strings.TrimPrefix(line, "gateway:"))
		if i := strings.IndexByte(v, '%'); i >= 0 {
			v = v[:i]
		}
		if a, err := netip.ParseAddr(v); err == nil {
			return []netip.Addr{a}
		}
	}
	return nil
}
