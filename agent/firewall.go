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

// firewallCapabilities lists the ban-enforcement features of the active
// backend, appended to the heartbeat capabilities.
func firewallCapabilities(fw FirewallManager) []string {
	if c, ok := fw.(cidrSupporter); ok && !c.SupportsCIDR() {
		return nil
	}
	return []string{capCIDR}
}

// ── Auto-detection ────────────────────────────────────────────────────────────

// DetectFirewall probes available firewall backends and returns the best one.
// Priority on Linux: nftables → firewalld → ufw → iptables
// Windows: Windows Defender Firewall (netsh)
// macOS: pf
func DetectFirewall() FirewallManager {
	switch runtime.GOOS {
	case "windows":
		// Prefer the WFP-native backend (persistent kernel filters, scales to
		// 30K–100K bans with a flat working set). Fall back to the netsh
		// grouped-rule backend if WFP init fails (e.g. not enough privilege).
		if wfp, err := newWFPFirewall(); err == nil && wfp.IsAvailable() {
			log.Printf("Firewall: using %s (WFP-native)", wfp.Name())
			return wfp
		} else if err != nil {
			log.Printf("Firewall: WFP init failed (%v) — falling back to netsh", err)
		}
		fw := &WindowsFirewall{}
		if fw.IsAvailable() {
			log.Printf("Firewall: using %s (netsh)", fw.Name())
			return fw
		}
		return &NoOpFirewall{}

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
