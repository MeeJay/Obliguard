package main

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"net/netip"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
)

// ── FirewallManager interface ─────────────────────────────────────────────────
//
// One file per backend: firewall_nftables.go, firewall_iptables.go (ipset),
// firewall_ufw.go, firewall_firewalld.go, firewall_netsh.go, firewall_pf.go
// (macOS + FreeBSD) and firewall_wfp_windows.go. This file holds the
// interface, the factory and the helpers they share.
//
// Ban entries are a single address ("1.2.3.4", "2001:db8::1") or a network
// ("1.2.3.0/24", "2001:db8::/48"). Every backend reports them back in the
// canonical text the server delivers (see canonicalBanEntry), so the server's
// string delta (desired − firewallBanned) converges.

// FirewallManager abstracts platform-specific firewall operations.
type FirewallManager interface {
	// BanIP adds DROP rules (inbound + outbound) for the given IP or CIDR.
	BanIP(ip string) error
	// UnbanIP removes all Obliguard rules for the given IP or CIDR.
	UnbanIP(ip string) error
	// GetBannedIPs returns the entries currently banned by Obliguard, in
	// canonical form (bare host for /32 and /128, "addr/len" otherwise).
	GetBannedIPs() ([]string, error)
	// Flush commits any buffered changes to the firewall. No-op on most backends.
	// Call after a batch of BanIP/UnbanIP to minimize system calls.
	Flush() error
	// IsAvailable returns true if this firewall backend is usable.
	IsAvailable() bool
	// Name returns the backend identifier string (sent in push body).
	Name() string

	// IsRateLimitSupported reports whether this backend can enforce per-IP
	// rate limiting. Backends that return false treat ApplyRateLimits as a no-op.
	IsRateLimitSupported() bool
	// ApplyRateLimits installs the given per-IP rate limit rules, replacing any
	// previously-applied set. An empty slice clears all rate limiting.
	ApplyRateLimits(rules []RateLimitRule) error
}

// cidrSupporter is implemented by backends that can lose CIDR support at
// runtime (an ipset that could not be migrated to hash:net). Backends that do
// not implement it always accept CIDR entries.
type cidrSupporter interface {
	SupportsCIDR() bool
}

// capCIDR tells the server it may deliver "a.b.c.d/nn" entries instead of the
// bare network address (older agents only understand single addresses).
const capCIDR = "cidr"

// capWFP tells the server that the WFP-native backend is the one enforcing the
// bans of this (Windows) agent. Absent on the netsh backend, including after a
// WFP init failure.
const capWFP = "wfp"

// firewallCapabilities lists the ban-enforcement features of the active
// backend, appended to the heartbeat capabilities.
func firewallCapabilities(fw FirewallManager) []string {
	var caps []string
	if c, ok := fw.(cidrSupporter); !ok || c.SupportsCIDR() {
		caps = append(caps, capCIDR)
	}
	if firewallBackendKind(fw) == fwBackendWFP {
		caps = append(caps, capWFP)
	}
	return caps
}

// ── Windows backend preference ────────────────────────────────────────────────
//
// The server config frame may carry "firewallBackend": "auto" | "wfp" |
// "netsh" (Windows agents only). auto and wfp both select the WFP-native
// backend with the netsh fallback when WFP cannot be opened; netsh keeps WFP
// off. An absent field leaves the current preference unchanged: older servers
// never send it, so those agents stay on auto (the behaviour before the
// setting existed). The preference is persisted in config.json
// (firewallBackend) and applied before the first connection at the next start.

const (
	fwBackendAuto  = "auto"
	fwBackendWFP   = "wfp"
	fwBackendNetsh = "netsh"
)

// normalizeFirewallBackend validates a preference ("" = auto). ok is false for
// an unknown value, which the agent ignores (a newer server may add values).
func normalizeFirewallBackend(s string) (pref string, ok bool) {
	switch v := strings.ToLower(strings.TrimSpace(s)); v {
	case "", fwBackendAuto:
		return fwBackendAuto, true
	case fwBackendWFP, fwBackendNetsh:
		return v, true
	}
	return fwBackendAuto, false
}

// firewallKindFor maps a preference to the backend it selects first.
func firewallKindFor(pref string) string {
	if pref == fwBackendNetsh {
		return fwBackendNetsh
	}
	return fwBackendWFP
}

// backendKinder is implemented by the Windows backends that report which of
// WFP and netsh actually enforces ("wfp", "netsh", "" otherwise).
type backendKinder interface {
	BackendKind() string
}

func firewallBackendKind(fw FirewallManager) string {
	if k, ok := fw.(backendKinder); ok {
		return k.BackendKind()
	}
	return ""
}

// fwBackendSwitcher is the platform half of the Windows backend switch, set by
// firewall_wfp_windows.go (nil on other platforms). It sits behind an
// interface so the switch sequencing below is testable on every OS.
type fwBackendSwitcher interface {
	// kindOf reports "wfp", "netsh" or "none" for a backend.
	kindOf(fw FirewallManager) string
	// migrate builds the backend of kind `to`, enforces on it the entries the
	// old backend enforces, verifies them, then removes the old backend's
	// rules (apply new, then clean old). On error the old backend is left
	// enforcing, untouched, and whatever the new one wrote is removed.
	migrate(old FirewallManager, to string) (FirewallManager, error)
	// activate starts the background work of a backend that became active.
	activate(fw FirewallManager)
	// armWFPPurge makes the first netsh Flush remove the WFP filters an
	// earlier run left behind (netsh cannot see them).
	armWFPPurge()
}

var fwSwitchOps fwBackendSwitcher

// switchableFirewall wraps the Windows backend so the server can switch it at
// runtime: every caller (ban worker, heartbeat, config worker) keeps the same
// FirewallManager while the backend underneath changes.
//
// Writes (BanIP, UnbanIP, Flush, ApplyRateLimits) and a switch are serialized
// by opMu, so no delta is applied to a backend that is being replaced. Reads
// (GetBannedIPs for the heartbeat) only take curMu and keep reporting the old
// backend, which still enforces, while a long migration runs.
type switchableFirewall struct {
	ops fwBackendSwitcher

	opMu  sync.Mutex
	curMu sync.RWMutex
	cur   FirewallManager

	// Requested preference, applied by one goroutine at a time (latest wins).
	reqMu   sync.Mutex
	want    string
	applied string
	running bool
	// idle is closed when no switch is pending (tests wait on it).
	idle chan struct{}
}

func newSwitchableFirewall(fw FirewallManager, pref string, ops fwBackendSwitcher) *switchableFirewall {
	idle := make(chan struct{})
	close(idle)
	return &switchableFirewall{ops: ops, cur: fw, want: pref, applied: pref, idle: idle}
}

func (s *switchableFirewall) current() FirewallManager {
	s.curMu.RLock()
	defer s.curMu.RUnlock()
	return s.cur
}

func (s *switchableFirewall) Name() string                    { return s.current().Name() }
func (s *switchableFirewall) IsAvailable() bool               { return s.current().IsAvailable() }
func (s *switchableFirewall) GetBannedIPs() ([]string, error) { return s.current().GetBannedIPs() }
func (s *switchableFirewall) IsRateLimitSupported() bool      { return s.current().IsRateLimitSupported() }
func (s *switchableFirewall) BackendKind() string             { return s.ops.kindOf(s.current()) }

func (s *switchableFirewall) SupportsCIDR() bool {
	if c, ok := s.current().(cidrSupporter); ok {
		return c.SupportsCIDR()
	}
	return true
}

func (s *switchableFirewall) BanIP(ip string) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return s.current().BanIP(ip)
}

func (s *switchableFirewall) UnbanIP(ip string) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return s.current().UnbanIP(ip)
}

func (s *switchableFirewall) Flush() error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return s.current().Flush()
}

func (s *switchableFirewall) ApplyRateLimits(rules []RateLimitRule) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return s.current().ApplyRateLimits(rules)
}

// requestPreference records the preference received from the server and
// starts the switch in the background when it changed: a migration of a large
// ban set can take minutes on netsh, and the config worker must keep going.
func (s *switchableFirewall) requestPreference(pref string) {
	s.reqMu.Lock()
	defer s.reqMu.Unlock()
	s.want = pref
	if s.running || s.want == s.applied {
		return
	}
	s.running = true
	s.idle = make(chan struct{})
	go s.switchLoop()
}

func (s *switchableFirewall) switchLoop() {
	for {
		s.reqMu.Lock()
		if s.want == s.applied {
			s.running = false
			close(s.idle)
			s.reqMu.Unlock()
			return
		}
		pref := s.want
		s.reqMu.Unlock()

		s.applyPreference(pref)

		s.reqMu.Lock()
		s.applied = pref
		s.reqMu.Unlock()
	}
}

// waitIdle blocks until no switch is pending.
func (s *switchableFirewall) waitIdle() {
	s.reqMu.Lock()
	idle := s.idle
	s.reqMu.Unlock()
	<-idle
}

// applyPreference switches to the backend the preference selects, when it is
// not the one enforcing. A failed switch keeps the current backend: it is
// retried at the next start, or when the preference changes again.
func (s *switchableFirewall) applyPreference(pref string) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	old := s.current()
	from, to := s.ops.kindOf(old), firewallKindFor(pref)
	if from == to {
		log.Printf("Firewall: backend preference %s — %s already enforces", pref, from)
		return
	}
	log.Printf("Firewall: backend preference %s — switching %s → %s", pref, from, to)
	nw, err := s.ops.migrate(old, to)
	if err != nil {
		log.Printf("Firewall: switch to %s failed (%v) — %s keeps enforcing", to, err, from)
		return
	}
	s.curMu.Lock()
	s.cur = nw
	s.curMu.Unlock()
	s.ops.activate(nw)
	log.Printf("Firewall: now enforcing with %s", s.ops.kindOf(nw))
}

// applyFirewallBackendFrame applies the firewallBackend field of a config
// frame: nil (absent) changes nothing, an unknown value is ignored, a new
// preference is persisted to config.json and applied in the background.
// Called from the config worker (the only writer of cfg after start-up).
// Agents on other platforms ignore the field.
func applyFirewallBackendFrame(cfg *Config, fw FirewallManager, raw *string) {
	if raw == nil {
		return
	}
	sw, ok := fw.(*switchableFirewall)
	if !ok {
		return
	}
	pref, valid := normalizeFirewallBackend(*raw)
	if !valid {
		log.Printf("Firewall: ignoring unknown firewallBackend %q from the server", *raw)
		return
	}
	if stored, _ := normalizeFirewallBackend(cfg.FirewallBackend); stored != pref || cfg.FirewallBackend == "" {
		cfg.FirewallBackend = pref
		if err := saveConfig(cfg); err != nil {
			log.Printf("Warning: could not save firewallBackend in config: %v", err)
		}
	}
	sw.requestPreference(pref)
}

// ── Auto-detection ────────────────────────────────────────────────────────────

// flushAtStartup runs the first Flush of a Windows backend right away: the
// netsh rebuild from obliguard-banlist.txt, the stale group/filter cleanup and
// the WFP purge after a netsh fallback all happen on the first Flush, and the
// server sends no delta while the reported ban set already matches the
// banlist. A failure is retried by the next Flush (the state stays dirty).
func flushAtStartup(fw FirewallManager) {
	if err := fw.Flush(); err != nil {
		log.Printf("Firewall: initial %s flush failed (retried on the next ban change): %v", fw.Name(), err)
	}
}

// DetectFirewall probes available firewall backends and returns the best one,
// with the default Windows backend preference (auto).
// Priority on Linux: nftables → firewalld → ufw → iptables
// Windows: WFP-native, netsh fallback (see DetectFirewallFor)
// macOS / FreeBSD: pf
func DetectFirewall() FirewallManager {
	return DetectFirewallFor(fwBackendAuto)
}

// DetectFirewallFor is DetectFirewall with the persisted Windows backend
// preference (config.json firewallBackend; ignored on other platforms). On
// Windows the backend is wrapped so the server can switch it at runtime.
func DetectFirewallFor(pref string) FirewallManager {
	switch runtime.GOOS {
	case "windows":
		pref, _ = normalizeFirewallBackend(pref)
		fw := detectWindowsBackend(pref)
		if fwSwitchOps == nil {
			return fw
		}
		return newSwitchableFirewall(fw, pref, fwSwitchOps)

	case "darwin":
		fw := &PFFirewall{}
		if fw.IsAvailable() {
			return fw
		}
		return &NoOpFirewall{}

	case "freebsd":
		fw := &FreeBSDPFFirewall{}
		if fw.IsAvailable() {
			log.Printf("Firewall: using %s", fw.Name())
			return fw
		}
		log.Printf("Firewall: pf not available — bans will not be enforced locally")
		return &NoOpFirewall{}

	default: // Linux + others
		candidates := []FirewallManager{
			&NftablesFirewall{},
			&FirewalldFirewall{},
			&UFWFirewall{},
			&IptablesFirewall{},
		}
		for _, fw := range candidates {
			if fw.IsAvailable() {
				log.Printf("Firewall: using %s", fw.Name())
				return fw
			}
		}
		log.Printf("Firewall: no supported backend found — bans will not be enforced locally")
		return &NoOpFirewall{}
	}
}

// detectWindowsBackend opens the backend the preference selects at start-up.
// auto / wfp: the WFP-native backend (persistent kernel filters, scales to
// 30K–100K bans with a flat working set), with the netsh grouped-rule backend
// as fallback when WFP init fails (e.g. not enough privilege). netsh: WFP is
// not opened, and the filters of an earlier WFP run are purged once netsh
// enforces the banlist.
func detectWindowsBackend(pref string) FirewallManager {
	if firewallKindFor(pref) == fwBackendWFP {
		if wfp, err := newWFPFirewall(); err == nil && wfp.IsAvailable() {
			log.Printf("Firewall: using %s (WFP-native, preference %s)", wfp.Name(), pref)
			flushAtStartup(wfp)
			return wfp
		} else if err != nil {
			log.Printf("Firewall: WFP init failed (%v) — falling back to netsh", err)
		}
	} else {
		log.Printf("Firewall: WFP disabled by the backend preference (%s)", pref)
		if fwSwitchOps != nil {
			fwSwitchOps.armWFPPurge()
		}
	}
	fw := &WindowsFirewall{}
	if fw.IsAvailable() {
		log.Printf("Firewall: using %s (netsh)", fw.Name())
		flushAtStartup(fw)
		return fw
	}
	return &NoOpFirewall{}
}

// ── No-op (fallback when no firewall is available) ────────────────────────────

type NoOpFirewall struct{}

func (f *NoOpFirewall) Name() string                    { return "none" }
func (f *NoOpFirewall) IsAvailable() bool               { return true }
func (f *NoOpFirewall) BanIP(ip string) error           { return nil }
func (f *NoOpFirewall) UnbanIP(ip string) error         { return nil }
func (f *NoOpFirewall) Flush() error                    { return nil }
func (f *NoOpFirewall) GetBannedIPs() ([]string, error) { return nil, nil }

func (f *NoOpFirewall) IsRateLimitSupported() bool              { return false }
func (f *NoOpFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }

// ── Command runner ────────────────────────────────────────────────────────────
//
// Backends never call os/exec directly: they go through fwExec so tests can
// record the exact argv (and stdin scripts) they build. Arguments are always
// discrete argv elements — no shell, no string splitting.

type fwRunner interface {
	// Run executes name with args, feeding stdin when it is non-empty. It
	// returns stdout; on failure the error carries the trimmed stderr.
	Run(stdin, name string, args ...string) ([]byte, error)
	// LookPath reports whether name is an executable on PATH.
	LookPath(name string) error
}

type execRunner struct{}

func (execRunner) Run(stdin, name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			err = fmt.Errorf("%w: %s", err, msg)
		}
	}
	return stdout.Bytes(), err
}

func (execRunner) LookPath(name string) error {
	_, err := exec.LookPath(name)
	return err
}

// fwExec is the runner used by every backend (replaced in tests).
var fwExec fwRunner = execRunner{}

// fwRun runs a command and only reports success.
func fwRun(name string, args ...string) error {
	_, err := fwExec.Run("", name, args...)
	return err
}

// fwOutput runs a command and returns its stdout.
func fwOutput(name string, args ...string) ([]byte, error) {
	return fwExec.Run("", name, args...)
}

// fwRunStdin runs a command with stdin (nft -f -, ipset restore, pfctl -f -).
func fwRunStdin(stdin, name string, args ...string) error {
	_, err := fwExec.Run(stdin, name, args...)
	return err
}

// fwHave reports whether a command exists on PATH.
func fwHave(name string) bool {
	return fwExec.LookPath(name) == nil
}

// ── Ban entries ───────────────────────────────────────────────────────────────

var errEmptyBanEntry = errors.New("empty ban entry")

// canonicalBanEntry parses an IP or CIDR and returns its canonical text plus
// the masked prefix:
//
//   - host (no length, /32 or /128) → bare address ("1.2.3.4", "2001:db8::1")
//   - network                       → masked "addr/len" ("1.2.3.0/24")
//
// IPv4-mapped IPv6 is unmapped and zones are refused. This is the form the
// server delivers (host(ip) for /32-/128, host(ip)||'/'||prefix otherwise) and
// the form GetBannedIPs must report.
func canonicalBanEntry(s string) (string, netip.Prefix, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", netip.Prefix{}, errEmptyBanEntry
	}
	var p netip.Prefix
	if strings.Contains(s, "/") {
		pp, err := netip.ParsePrefix(s)
		if err != nil {
			return "", netip.Prefix{}, err
		}
		a := pp.Addr()
		bits := pp.Bits()
		if a.Is4In6() {
			if bits < 96 {
				return "", netip.Prefix{}, fmt.Errorf("invalid IPv4-mapped prefix %q", s)
			}
			a, bits = a.Unmap(), bits-96
		}
		p = netip.PrefixFrom(a, bits).Masked()
	} else {
		a, err := netip.ParseAddr(s)
		if err != nil {
			return "", netip.Prefix{}, err
		}
		if a.Zone() != "" {
			return "", netip.Prefix{}, fmt.Errorf("zoned address %q", s)
		}
		a = a.Unmap()
		p = netip.PrefixFrom(a, a.BitLen())
	}
	return banEntryKey(p), p, nil
}

// banEntryKey renders a masked prefix in canonical ban-entry text.
func banEntryKey(p netip.Prefix) string {
	if p.Bits() == p.Addr().BitLen() {
		return p.Addr().String()
	}
	return p.String()
}

// isHostEntry reports whether p is a single address (/32 or /128).
func isHostEntry(p netip.Prefix) bool {
	return p.Bits() == p.Addr().BitLen()
}

// canonicalBanList canonicalizes a delta list. Entries that do not parse are
// passed through unchanged so a stale, odd-looking entry can still be removed.
func canonicalBanList(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, s := range in {
		k, _, err := canonicalBanEntry(s)
		if err != nil {
			k = strings.TrimSpace(s)
			if k == "" {
				continue
			}
		}
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}

// parseBanEntries extracts every IP / CIDR token from backend output and
// returns them canonical and de-duplicated, in order of appearance. Tokens are
// split on whitespace, commas and braces; anything that is not an address or
// a prefix (keywords, ranges, port specs) is ignored.
func parseBanEntries(text string) []string {
	fields := strings.FieldsFunc(text, func(r rune) bool {
		switch r {
		case ' ', '\t', '\r', '\n', ',', '{', '}', ';':
			return true
		}
		return false
	})
	var out []string
	seen := make(map[string]bool)
	for _, tok := range fields {
		k, _, err := canonicalBanEntry(tok)
		if err != nil || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, k)
	}
	return out
}

// prefixCoveredBy returns the key of a network in nets (other than p itself)
// that contains p, or "" when none does. Only networks can cover an entry, so
// callers pass the non-host elements of a set.
func prefixCoveredBy(p netip.Prefix, nets map[string]netip.Prefix) string {
	for k, n := range nets {
		if n == p || n.Bits() > p.Bits() || n.Addr().Is4() != p.Addr().Is4() {
			continue
		}
		if n.Contains(p.Addr()) {
			return k
		}
	}
	return ""
}

// planIntervalSet computes the element changes for a set that refuses
// overlapping elements (nftables interval sets without auto-merge: adding
// 1.2.3.4 next to 1.2.3.0/24 fails, and auto-merge would rewrite the elements
// into ranges the server never sent, so the reported state would never
// converge). Overlaps are resolved here instead:
//
//   - a requested entry already contained in a present network is not
//     inserted; it is kept in covered and reported as banned;
//   - a requested network that contains present narrower elements retires
//     them (deleted from the set, moved to covered) before it is inserted;
//   - removing a network re-inserts the covered entries it was hiding.
//
// present is the live set content (key → prefix); covered is updated in
// place. dels and adds may be non-canonical. Returns the elements to delete
// (applied first) and to add.
func planIntervalSet(present, covered map[string]netip.Prefix, adds, dels []string) (toDel, toAdd []string) {
	pres := make(map[string]netip.Prefix, len(present))
	nets := make(map[string]netip.Prefix)
	for k, p := range present {
		pres[k] = p
		if !isHostEntry(p) {
			nets[k] = p
		}
	}

	// 1. Removals.
	for _, d := range dels {
		k, _, err := canonicalBanEntry(d)
		if err != nil {
			continue
		}
		if _, ok := covered[k]; ok {
			delete(covered, k)
			continue
		}
		if _, ok := pres[k]; ok {
			toDel = append(toDel, k)
			delete(pres, k)
			delete(nets, k)
		}
	}

	// 2. Wanted additions: the requested ones plus covered entries whose
	//    covering network was just removed.
	want := make(map[string]netip.Prefix)
	for _, a := range adds {
		k, p, err := canonicalBanEntry(a)
		if err != nil {
			continue
		}
		want[k] = p
	}
	for k, p := range covered {
		if prefixCoveredBy(p, nets) == "" {
			want[k] = p
			delete(covered, k)
		}
	}

	// Broadest first, so a network lands before the entries it contains.
	keys := make([]string, 0, len(want))
	for k := range want {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		pi, pj := want[keys[i]], want[keys[j]]
		if pi.Bits() != pj.Bits() {
			return pi.Bits() < pj.Bits()
		}
		return keys[i] < keys[j]
	})

	for _, k := range keys {
		p := want[k]
		if _, ok := pres[k]; ok {
			delete(covered, k)
			continue
		}
		if prefixCoveredBy(p, nets) != "" {
			covered[k] = p
			continue
		}
		delete(covered, k)
		if !isHostEntry(p) {
			// Retire the narrower present elements this network contains.
			for ek, ep := range pres {
				if ep.Bits() > p.Bits() && ep.Addr().Is4() == p.Addr().Is4() && p.Contains(ep.Addr()) {
					toDel = append(toDel, ek)
					delete(pres, ek)
					delete(nets, ek)
					covered[ek] = ep
				}
			}
			nets[k] = p
		}
		pres[k] = p
		toAdd = append(toAdd, k)
	}
	return toDel, toAdd
}

// reportWithCovered returns the present keys plus the covered entries that a
// present network still contains, sorted.
func reportWithCovered(present, covered map[string]netip.Prefix) []string {
	nets := make(map[string]netip.Prefix)
	out := make([]string, 0, len(present)+len(covered))
	for k, p := range present {
		out = append(out, k)
		if !isHostEntry(p) {
			nets[k] = p
		}
	}
	for k, p := range covered {
		if _, dup := present[k]; dup {
			continue
		}
		if prefixCoveredBy(p, nets) != "" {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// ── Shared helpers ────────────────────────────────────────────────────────────

func chunkStrings(s []string, size int) [][]string {
	var chunks [][]string
	for i := 0; i < len(s); i += size {
		end := i + size
		if end > len(s) {
			end = len(s)
		}
		chunks = append(chunks, s[i:end])
	}
	return chunks
}

// ipPattern matches a dotted IPv4 address. Only used to recognise legacy
// per-IP rules (netsh names, ufw/firewalld rules) — ban state is parsed with
// parseBanEntries.
func ipPattern() *regexp.Regexp {
	return regexp.MustCompile(`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`)
}
