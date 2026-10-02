package main

import (
	"fmt"
	"log"
	"strings"
)

// pf tables are radix trees: hosts and CIDR networks ("1.2.3.0/24") coexist,
// overlaps included, and `pfctl -T show` prints them back in the same form.
// Entries are canonicalized on the way in and out so the server delta
// converges. (Anchor-qualified table handling is a separate pass.)

// pfTableEntries parses `pfctl -T show` output into canonical entries
// (negated "!a.b.c.d" entries and blank lines are skipped).
func pfTableEntries(out string) []string {
	var res []string
	seen := make(map[string]bool)
	for _, line := range strings.Split(out, "\n") {
		k, _, err := canonicalBanEntry(line)
		if err != nil || seen[k] {
			continue
		}
		seen[k] = true
		res = append(res, k)
	}
	return res
}

// ── macOS pf ──────────────────────────────────────────────────────────────────

const pfAnchor = "obliguard"
const pfTable = "obliguard_blocklist"

type PFFirewall struct{ anchorFile string }

func (f *PFFirewall) Name() string { return "macos_pf" }

func (f *PFFirewall) IsAvailable() bool {
	return fwHave("pfctl")
}

func (f *PFFirewall) BanIP(ip string) error {
	k, _, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	return fwRun("pfctl", "-t", pfTable, "-T", "add", k)
}

func (f *PFFirewall) UnbanIP(ip string) error {
	k, _, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	return fwRun("pfctl", "-t", pfTable, "-T", "delete", k)
}

func (f *PFFirewall) Flush() error { return nil }

func (f *PFFirewall) GetBannedIPs() ([]string, error) {
	out, err := fwOutput("pfctl", "-t", pfTable, "-T", "show")
	if err != nil {
		return nil, nil
	}
	return pfTableEntries(string(out)), nil
}

// ── FreeBSD pf (table-based, OPNsense-friendly) ─────────────────────────────

const freebsdPFTable = "obliguard_blocklist"

type FreeBSDPFFirewall struct{}

func (f *FreeBSDPFFirewall) Name() string { return "freebsd_pf" }

func (f *FreeBSDPFFirewall) IsAvailable() bool {
	if !fwHave("pfctl") {
		return false
	}
	out, err := fwOutput("pfctl", "-si")
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "Status: Enabled")
}

func (f *FreeBSDPFFirewall) BanIP(ip string) error {
	k, _, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	f.ensureTable()
	return fwRun("pfctl", "-t", freebsdPFTable, "-T", "add", k)
}

func (f *FreeBSDPFFirewall) UnbanIP(ip string) error {
	k, _, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	return fwRun("pfctl", "-t", freebsdPFTable, "-T", "delete", k)
}

func (f *FreeBSDPFFirewall) Flush() error { return nil }

func (f *FreeBSDPFFirewall) GetBannedIPs() ([]string, error) {
	out, err := fwOutput("pfctl", "-t", freebsdPFTable, "-T", "show")
	if err != nil {
		return nil, nil
	}
	return pfTableEntries(string(out)), nil
}

func (f *FreeBSDPFFirewall) ensureTable() {
	if fwRun("pfctl", "-a", "obliguard", "-t", freebsdPFTable, "-T", "show") == nil {
		return
	}
	if fwRun("pfctl", "-t", freebsdPFTable, "-T", "show") == nil {
		return
	}
	rules := fmt.Sprintf("table <%s> persist\nblock in quick from <%s>\nblock out quick to <%s>\n",
		freebsdPFTable, freebsdPFTable, freebsdPFTable)
	if err := fwRunStdin(rules, "pfctl", "-a", "obliguard", "-f", "-"); err != nil {
		log.Printf("Firewall: pf anchor init warning: %v", err)
	}
}

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// Not wired for pf yet: it would need a dedicated rate-limit anchor (pf
// keep-state max-src-conn / dummynet) — a separate pass.

func (f *PFFirewall) IsRateLimitSupported() bool              { return false }
func (f *PFFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }

func (f *FreeBSDPFFirewall) IsRateLimitSupported() bool              { return false }
func (f *FreeBSDPFFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }
