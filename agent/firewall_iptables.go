package main

import (
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
)

// ── iptables (ipset-based if available, fallback to chain rules) ─────────────
//
// Strategy: if ipset is available, use a hash:net set "obliguard" (hosts and
// CIDR networks) with two iptables rules matching the set. Otherwise, fall
// back to individual chain rules (-s / -d accept CIDR natively).
//
// IPv4 only: the set has family inet and the rules are iptables (not
// ip6tables), so IPv6 entries are refused before they can poison a batch.

const iptChain = "OBLIGUARD"
const iptChainOut = "OBLIGUARD_OUT"
const iptSetName = "obliguard"

type IptablesFirewall struct {
	// mu serializes the ban goroutine (BanIP/UnbanIP/Flush) and the heartbeat
	// (GetBannedIPs / SupportsCIDR).
	mu          sync.Mutex
	initialized bool
	hasIpset    bool
	// cidrOK is false only when an old hash:ip set could not be migrated.
	cidrOK     bool
	pendingAdd []string
	pendingDel []string
}

func (f *IptablesFirewall) Name() string { return "iptables" }

func (f *IptablesFirewall) IsAvailable() bool {
	return fwHave("iptables")
}

// iptRebind points the OBLIGUARD chains from one set to another, adding the
// new rules before removing the old ones (no enforcement gap).
func iptRebind(from, to string) {
	fwRun("iptables", "-A", iptChain, "-m", "set", "--match-set", to, "src", "-j", "DROP")
	fwRun("iptables", "-A", iptChainOut, "-m", "set", "--match-set", to, "dst", "-j", "DROP")
	fwRun("iptables", "-D", iptChain, "-m", "set", "--match-set", from, "src", "-j", "DROP")
	fwRun("iptables", "-D", iptChainOut, "-m", "set", "--match-set", from, "dst", "-j", "DROP")
}

// ensureChain creates the chains, hooks and set (idempotent). Called with f.mu held.
func (f *IptablesFirewall) ensureChain() error {
	if f.initialized {
		return nil
	}
	// Check for ipset support
	f.hasIpset = fwHave("ipset")

	// Create chains and hook them into INPUT/OUTPUT
	fwRun("iptables", "-N", iptChain)
	fwRun("iptables", "-N", iptChainOut)
	if fwRun("iptables", "-C", "INPUT", "-j", iptChain) != nil {
		fwRun("iptables", "-I", "INPUT", "1", "-j", iptChain)
	}
	if fwRun("iptables", "-C", "OUTPUT", "-j", iptChainOut) != nil {
		fwRun("iptables", "-I", "OUTPUT", "1", "-j", iptChainOut)
	}

	if f.hasIpset {
		// hash:net set (migrated in place from an older hash:ip set).
		f.cidrOK = ensureIpsetNet(iptSetName, iptRebind)
		// Flush chains and add set-matching rules
		fwRun("iptables", "-F", iptChain)
		fwRun("iptables", "-F", iptChainOut)
		fwRun("iptables", "-A", iptChain, "-m", "set", "--match-set", iptSetName, "src", "-j", "DROP")
		fwRun("iptables", "-A", iptChainOut, "-m", "set", "--match-set", iptSetName, "dst", "-j", "DROP")
	} else {
		// Fallback: individual rules in the custom chains (CIDR accepted).
		f.cidrOK = true
	}
	f.initialized = true
	return nil
}

// SupportsCIDR implements cidrSupporter.
func (f *IptablesFirewall) SupportsCIDR() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = f.ensureChain()
	return f.cidrOK
}

// iptEntry canonicalizes an entry for an IPv4-only, possibly host-only backend.
func iptEntry(ip string, cidrOK bool) (string, error) {
	k, p, err := canonicalBanEntry(ip)
	if err != nil {
		return "", err
	}
	if !p.Addr().Is4() {
		return "", fmt.Errorf("%s: IPv6 is not supported by this backend", k)
	}
	if !isHostEntry(p) && !cidrOK {
		return "", fmt.Errorf("%s: CIDR needs a hash:net ipset", k)
	}
	return k, nil
}

func (f *IptablesFirewall) BanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = f.ensureChain()
	k, err := iptEntry(ip, f.cidrOK)
	if err != nil {
		return err
	}
	if f.hasIpset {
		f.pendingAdd = append(f.pendingAdd, k)
		return nil
	}
	fwRun("iptables", "-A", iptChain, "-s", k, "-j", "DROP")
	return fwRun("iptables", "-A", iptChainOut, "-d", k, "-j", "DROP")
}

func (f *IptablesFirewall) UnbanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = f.ensureChain()
	k, _, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	if f.hasIpset {
		f.pendingDel = append(f.pendingDel, k)
		return nil
	}
	fwRun("iptables", "-D", iptChain, "-s", k, "-j", "DROP")
	fwRun("iptables", "-D", iptChainOut, "-d", k, "-j", "DROP")
	return nil
}

func (f *IptablesFirewall) Flush() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.hasIpset {
		return nil // non-ipset mode applies immediately
	}
	ipsetApply(iptSetName, f.pendingAdd, f.pendingDel)
	f.pendingAdd = nil
	f.pendingDel = nil
	return nil
}

func (f *IptablesFirewall) GetBannedIPs() ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = f.ensureChain()
	if f.hasIpset {
		members, err := ipsetMembers(iptSetName)
		if err != nil {
			return nil, nil
		}
		return members, nil
	}
	out, err := fwOutput("iptables", "-L", iptChain, "-n")
	if err != nil {
		return nil, nil
	}
	return parseIptablesSources(string(out)), nil
}

// parseIptablesSources extracts the source column of the DROP rules of an
// `iptables -L <chain> -n` listing ("DROP all -- 1.2.3.0/24 0.0.0.0/0").
func parseIptablesSources(out string) []string {
	var res []string
	seen := make(map[string]bool)
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[0] != "DROP" {
			continue
		}
		if k, _, err := canonicalBanEntry(fields[3]); err == nil && !seen[k] {
			seen[k] = true
			res = append(res, k)
		}
	}
	return res
}

// ── ipset helpers (shared with the ufw backend) ─────────────────────────────

// ipsetMaxElem is raised well above the default 65536 (large fleets have
// reported 30K+ bans) so adds never silently fail on a full set.
const ipsetMaxElem = "1048576"

// ipsetType returns the type of an existing set ("hash:ip", "hash:net"), or ""
// when the set does not exist.
func ipsetType(name string) string {
	out, err := fwOutput("ipset", "list", "-t", name)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Type:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "Type:"))
		}
	}
	return ""
}

// ipsetMembers returns the canonical members of a set.
func ipsetMembers(name string) ([]string, error) {
	out, err := fwOutput("ipset", "list", name)
	if err != nil {
		return nil, err
	}
	return parseIpsetMembers(string(out)), nil
}

// parseIpsetMembers parses the "Members:" block of `ipset list`. hash:net
// prints hosts bare and networks as "a.b.c.d/nn"; trailing options
// ("timeout 0") are ignored.
func parseIpsetMembers(out string) []string {
	var res []string
	seen := make(map[string]bool)
	inMembers := false
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Members:") {
			inMembers = true
			continue
		}
		if !inMembers || line == "" {
			continue
		}
		if k, _, err := canonicalBanEntry(strings.Fields(line)[0]); err == nil && !seen[k] {
			seen[k] = true
			res = append(res, k)
		}
	}
	return res
}

// ipsetApply removes then adds entries in one `ipset restore`; when restore
// refuses the batch, each entry is retried alone. Idempotent (-exist).
func ipsetApply(set string, adds, dels []string) {
	if len(adds) == 0 && len(dels) == 0 {
		return
	}
	var lines []string
	for _, ip := range dels {
		lines = append(lines, fmt.Sprintf("del %s %s -exist", set, ip))
	}
	for _, ip := range adds {
		lines = append(lines, fmt.Sprintf("add %s %s -exist", set, ip))
	}
	if err := fwRunStdin(strings.Join(lines, "\n")+"\n", "ipset", "restore"); err != nil {
		// Fallback: one by one
		for _, ip := range dels {
			fwRun("ipset", "del", set, ip, "-exist")
		}
		for _, ip := range adds {
			fwRun("ipset", "add", set, ip, "-exist")
		}
	}
}

var errIpsetMigration = errors.New("ipset migration failed")

// ensureIpsetNet makes name a hash:net set (hosts and CIDR networks).
//
// Agents up to 1.8.55 created a hash:ip set, which would expand a CIDR into
// one entry per address. ipset cannot swap sets of different types, so the
// migration goes through a temporary set without an enforcement gap:
//
//  1. copy the members into a new hash:net set name+"_mig";
//  2. rebind the rules from name to the temporary set;
//  3. re-create name as hash:net and copy the members back;
//  4. rebind the rules to name and destroy the temporary set.
//
// rebind(from, to) must add the rules matching `to` before deleting those
// matching `from`. Returns false when name is still hash:ip (CIDR entries are
// then refused by the backend).
func ensureIpsetNet(name string, rebind func(from, to string)) bool {
	switch ipsetType(name) {
	case "hash:net":
		return true
	case "":
		if err := fwRun("ipset", "create", name, "hash:net", "maxelem", ipsetMaxElem, "-exist"); err != nil {
			log.Printf("Firewall: ipset create %s: %v", name, err)
			return false
		}
		return true
	}
	if err := migrateIpsetToNet(name, rebind); err != nil {
		log.Printf("Firewall: %v — CIDR bans stay disabled on this host", err)
		return false
	}
	return true
}

func migrateIpsetToNet(name string, rebind func(from, to string)) error {
	tmp := name + "_mig"
	members, err := ipsetMembers(name)
	if err != nil {
		return fmt.Errorf("%w: list %s: %v", errIpsetMigration, name, err)
	}
	fwRun("ipset", "destroy", tmp) // leftover of an interrupted migration
	if err := fwRun("ipset", "create", tmp, "hash:net", "maxelem", ipsetMaxElem); err != nil {
		return fmt.Errorf("%w: create %s: %v", errIpsetMigration, tmp, err)
	}
	ipsetApply(tmp, members, nil)
	rebind(name, tmp)
	if err := fwRun("ipset", "destroy", name); err != nil {
		// Still referenced by a rule we do not own: roll back.
		rebind(tmp, name)
		fwRun("ipset", "destroy", tmp)
		return fmt.Errorf("%w: %s is still in use: %v", errIpsetMigration, name, err)
	}
	if err := fwRun("ipset", "create", name, "hash:net", "maxelem", ipsetMaxElem); err != nil {
		// The bans stay enforced through the temporary set; the next start
		// creates name again.
		return fmt.Errorf("%w: re-create %s: %v (bans kept in %s)", errIpsetMigration, name, err, tmp)
	}
	ipsetApply(name, members, nil)
	rebind(tmp, name)
	fwRun("ipset", "destroy", tmp)
	log.Printf("Firewall: ipset %s migrated to hash:net (%d entries, CIDR enabled)", name, len(members))
	return nil
}

// ── iptables rate limiting ──────────────────────────────────────────────────
//
// A dedicated chain OBLIGUARD_RL holds the rate-limit rules. It is hooked into:
//   - INPUT            → traffic destined to this machine's own services
//   - DOCKER-USER      → if Docker is present (Docker routes ALL forwarded
//                        traffic through DOCKER-USER first), covering containers
//   - FORWARD          → only when DOCKER-USER is absent (router/bridge case)
// We pick exactly one forward-path hook to avoid double-counting a packet.
//
// connection limits use connlimit; rate limits use hashlimit (srcip mode).
// Escalation bans use an ipset with per-entry timeout via the SET target, kept
// in obliguard_rl_bans — SEPARATE from the server-managed ban set, so the two
// never fight. GetBannedIPs does not report it.

const iptRLChain = "OBLIGUARD_RL"
const iptRLBanSet = "obliguard_rl_bans"

func (f *IptablesFirewall) IsRateLimitSupported() bool { return true }

func (f *IptablesFirewall) ApplyRateLimits(rules []RateLimitRule) error {
	return applyIptablesRateLimits(rules)
}

// iptHasDockerUserChain reports whether Docker's DOCKER-USER chain exists.
func iptHasDockerUserChain() bool {
	return fwRun("iptables", "-L", "DOCKER-USER", "-n") == nil
}

// ensureRLJump idempotently inserts a jump to OBLIGUARD_RL at the top of chain.
func ensureRLJump(parent string) {
	if fwRun("iptables", "-C", parent, "-j", iptRLChain) != nil {
		fwRun("iptables", "-I", parent, "1", "-j", iptRLChain)
	}
}

// applyIptablesRateLimits installs the rate-limit rules via raw iptables. Shared
// by the iptables backend and the ufw backend (ufw already injects raw iptables
// rules for its bans, so this is consistent there).
//
// Note: only 'connection' and 'rate' types are enforceable here — iptables has
// no per-IP byte-rate match, so 'volume' limits are skipped (handled by
// nftables/WinDivert, or tc in a future pass).
func applyIptablesRateLimits(rules []RateLimitRule) error {
	hasIpset := false
	if fwHave("ipset") {
		hasIpset = true
	}

	// Dedicated rate-limit chain + escalation ban set.
	fwRun("iptables", "-N", iptRLChain) // ignore "exists"
	if hasIpset {
		fwRun("ipset", "create", iptRLBanSet, "hash:ip", "timeout", "0", "-exist")
	}

	// Hook points: always INPUT, plus exactly one forward-path hook.
	ensureRLJump("INPUT")
	if iptHasDockerUserChain() {
		ensureRLJump("DOCKER-USER")
	} else {
		ensureRLJump("FORWARD")
	}

	// Rebuild the chain declaratively.
	fwRun("iptables", "-F", iptRLChain)

	// Drop anything currently rate-limit-banned (first packet after escalation
	// adds the IP; subsequent packets are dropped here).
	if hasIpset {
		fwRun("iptables", "-A", iptRLChain, "-m", "set", "--match-set", iptRLBanSet, "src", "-j", "DROP")
	}

	for i, r := range rules {
		if r.MaxValue < 1 || (r.Type != "connection" && r.Type != "rate") {
			continue
		}
		for _, args := range iptRateRuleArgs(i, r, hasIpset) {
			fwRun("iptables", args...)
		}
	}
	return nil
}

// iptRateRuleArgs builds the iptables rule arg-slices for one rule: an optional
// escalation→ban rule (when banMultiplier is set and ipset is available),
// followed by the soft drop/reject rule.
func iptRateRuleArgs(idx int, r RateLimitRule, hasIpset bool) [][]string {
	base := []string{"-A", iptRLChain, "-p", "tcp"}
	if r.Port != nil {
		base = append(base, "--dport", fmt.Sprintf("%d", *r.Port))
	}

	verdict := []string{"-j", "DROP"}
	if r.Action == "reject" {
		verdict = []string{"-j", "REJECT", "--reject-with", "tcp-reset"}
	}

	// matchFor builds the rate/connection match args for a given threshold.
	matchFor := func(threshold int, nameSuffix string) []string {
		if r.Type == "rate" {
			return []string{
				"-m", "conntrack", "--ctstate", "NEW",
				"-m", "hashlimit",
				"--hashlimit-mode", "srcip",
				"--hashlimit-above", fmt.Sprintf("%d/sec", threshold),
				"--hashlimit-name", fmt.Sprintf("og_%d_%s", idx, nameSuffix),
			}
		}
		// connection: concurrent connections per /32 source
		return []string{
			"-m", "connlimit",
			"--connlimit-above", fmt.Sprintf("%d", threshold),
			"--connlimit-mask", "32",
		}
	}

	var out [][]string

	// Escalation tier: over maxValue × banMultiplier → record a timeout ban.
	if r.BanMultiplier != nil && *r.BanMultiplier >= 2 && hasIpset {
		banThreshold := r.MaxValue * (*r.BanMultiplier)
		setTarget := []string{"-j", "SET", "--add-set", iptRLBanSet, "src", "--exist"}
		if r.BanTTLSeconds != nil && *r.BanTTLSeconds > 0 {
			setTarget = []string{"-j", "SET", "--add-set", iptRLBanSet, "src",
				"--timeout", fmt.Sprintf("%d", *r.BanTTLSeconds), "--exist"}
		}
		rule := append(append([]string{}, base...), matchFor(banThreshold, "b")...)
		rule = append(rule, setTarget...)
		out = append(out, rule)
	}

	// Soft tier: over maxValue → drop/reject.
	soft := append(append([]string{}, base...), matchFor(r.MaxValue, "s")...)
	soft = append(soft, verdict...)
	out = append(out, soft)

	return out
}
