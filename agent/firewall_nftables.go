package main

import (
	"fmt"
	"log"
	"net/netip"
	"strings"
	"sync"
)

// ── nftables (set-based — single rule matches all entries) ──────────────────
//
// Strategy: two interval sets hold every banned entry, hosts and networks
// alike: "obliguard_nets" (ipv4_addr) and "obliguard_nets6" (ipv6_addr), both
// with `flags interval` so they accept prefixes. Four rules (in/out × v4/v6)
// match the sets. Ban/unban = add/delete set elements.
// Result: 4 rules total regardless of entry count.
//
// The sets deliberately do NOT use auto-merge: merging would rewrite adjacent
// elements into ranges ("1.2.3.4-1.2.3.5") the server never sent, so the
// reported state would never converge. Without auto-merge the kernel refuses
// overlapping elements, which planIntervalSet resolves before anything is sent
// (an entry inside a banned network is tracked as covered, not inserted).
//
// Agents up to 1.8.55 used a plain (non-interval) set "obliguard_ips". It is
// migrated on first use: its elements are copied into the new set, the chains
// are switched in one transaction, then the old set is deleted.

const nftTable = "obliguard"
const nftSet4 = "obliguard_nets"
const nftSet6 = "obliguard_nets6"
const nftLegacySet = "obliguard_ips"
const nftChain = "blocklist"
const nftChainOut = "blocklist_out"

// nftElemsPerStmt bounds the elements per add/delete statement in one script.
const nftElemsPerStmt = 2000

type NftablesFirewall struct {
	// mu serializes everything: the ban goroutine (BanIP/UnbanIP/Flush), the
	// heartbeat (GetBannedIPs) and ApplyRateLimits all touch the table.
	mu          sync.Mutex
	initialized bool
	pendingAdd  []string
	pendingDel  []string
	// covered holds requested entries kept out of the sets because a banned
	// network already contains them (see planIntervalSet).
	covered map[string]netip.Prefix
	// legacy is true while the pre-interval set still exists (migration failed
	// or pending); its elements stay enforced and reported.
	legacy bool
}

func (f *NftablesFirewall) Name() string { return "nftables" }

func (f *NftablesFirewall) IsAvailable() bool {
	return fwHave("nft")
}

// nftSetFor returns the set holding entries of p's family.
func nftSetFor(p netip.Prefix) string {
	if p.Addr().Is4() {
		return nftSet4
	}
	return nftSet6
}

// nftBaseRules returns the drop rules of the two ban chains.
func nftBaseRules(withLegacy bool) []string {
	rules := []string{
		fmt.Sprintf("add rule inet %s %s ip saddr @%s drop", nftTable, nftChain, nftSet4),
		fmt.Sprintf("add rule inet %s %s ip6 saddr @%s drop", nftTable, nftChain, nftSet6),
		fmt.Sprintf("add rule inet %s %s ip daddr @%s drop", nftTable, nftChainOut, nftSet4),
		fmt.Sprintf("add rule inet %s %s ip6 daddr @%s drop", nftTable, nftChainOut, nftSet6),
	}
	if withLegacy {
		rules = append(rules,
			fmt.Sprintf("add rule inet %s %s ip saddr @%s drop", nftTable, nftChain, nftLegacySet),
			fmt.Sprintf("add rule inet %s %s ip daddr @%s drop", nftTable, nftChainOut, nftLegacySet),
		)
	}
	return rules
}

// nftChainsScript rebuilds the two ban chains in one transaction (flush and
// re-add are atomic, so enforcement never has a gap).
func nftChainsScript(withLegacy bool) string {
	lines := []string{
		fmt.Sprintf("flush chain inet %s %s", nftTable, nftChain),
		fmt.Sprintf("flush chain inet %s %s", nftTable, nftChainOut),
	}
	lines = append(lines, nftBaseRules(withLegacy)...)
	return strings.Join(lines, "\n") + "\n"
}

// ensureTable creates the table, sets and chains (idempotent). Called with
// f.mu held.
func (f *NftablesFirewall) ensureTable() error {
	if f.initialized {
		return nil
	}
	if f.covered == nil {
		f.covered = make(map[string]netip.Prefix)
	}
	_, legacyErr := fwOutput("nft", "list", "set", "inet", nftTable, nftLegacySet)
	hasLegacy := legacyErr == nil

	script := strings.Join([]string{
		fmt.Sprintf("add table inet %s", nftTable),
		fmt.Sprintf("add set inet %s %s { type ipv4_addr; flags interval; }", nftTable, nftSet4),
		fmt.Sprintf("add set inet %s %s { type ipv6_addr; flags interval; }", nftTable, nftSet6),
		fmt.Sprintf("add chain inet %s %s { type filter hook input priority -10; policy accept; }", nftTable, nftChain),
		fmt.Sprintf("add chain inet %s %s { type filter hook output priority -10; policy accept; }", nftTable, nftChainOut),
	}, "\n") + "\n" + nftChainsScript(hasLegacy)
	if err := fwRunStdin(script, "nft", "-f", "-"); err != nil {
		// Older nft without stdin scripts, or one statement refused: apply the
		// statements one by one (as agents up to 1.8.55 did), then check that
		// the sets exist.
		log.Printf("Firewall: nft init script refused (%v) — applying statement by statement", err)
		for _, line := range strings.Split(strings.TrimSpace(script), "\n") {
			fwRun("nft", strings.Fields(line)...)
		}
		if _, lerr := fwOutput("nft", "list", "set", "inet", nftTable, nftSet4); lerr != nil {
			return fmt.Errorf("nft init: %w", err)
		}
	}
	f.initialized = true
	f.legacy = hasLegacy
	if hasLegacy {
		f.migrateLegacy()
	}
	return nil
}

// migrateLegacy copies the pre-interval set into the interval sets, switches
// the chains to the new sets only, then deletes the old set. Any failure keeps
// the old set enforced (double enforcement, never a gap) until the next start.
func (f *NftablesFirewall) migrateLegacy() {
	legacyEntries, err := f.listSet(nftLegacySet)
	if err != nil {
		log.Printf("Firewall: nft legacy set unreadable (%v) — kept", err)
		return
	}
	if len(legacyEntries) > 0 {
		present, err := f.listPresent()
		if err != nil {
			log.Printf("Firewall: nft migration skipped: %v", err)
			return
		}
		toDel, toAdd := planIntervalSet(present, f.covered, legacyEntries, nil)
		if failed := f.apply(toDel, toAdd); failed > 0 {
			log.Printf("Firewall: nft migration incomplete (%d element(s) failed) — legacy set kept", failed)
			return
		}
	}
	if err := fwRunStdin(nftChainsScript(false), "nft", "-f", "-"); err != nil {
		log.Printf("Firewall: nft migration chain switch failed: %v — legacy set kept", err)
		return
	}
	if err := fwRun("nft", "delete", "set", "inet", nftTable, nftLegacySet); err != nil {
		log.Printf("Firewall: nft legacy set not deleted: %v", err)
	}
	f.legacy = false
	log.Printf("Firewall: nftables ban set migrated to interval sets (%d entries, CIDR enabled)", len(legacyEntries))
}

// listSet returns the canonical elements of one set.
func (f *NftablesFirewall) listSet(set string) ([]string, error) {
	out, err := fwOutput("nft", "list", "set", "inet", nftTable, set)
	if err != nil {
		return nil, err
	}
	return parseNftElements(string(out)), nil
}

// parseNftElements extracts the elements of a `nft list set` output. Only the
// `elements = { ... }` block is parsed, so the set header is never mistaken for
// an entry.
func parseNftElements(out string) []string {
	i := strings.Index(out, "elements")
	if i < 0 {
		return nil
	}
	rest := out[i:]
	open := strings.Index(rest, "{")
	if open < 0 {
		return nil
	}
	rest = rest[open+1:]
	if end := strings.Index(rest, "}"); end >= 0 {
		rest = rest[:end]
	}
	return parseBanEntries(rest)
}

// listPresent returns the elements of both interval sets (key → prefix).
func (f *NftablesFirewall) listPresent() (map[string]netip.Prefix, error) {
	present := make(map[string]netip.Prefix)
	for _, set := range []string{nftSet4, nftSet6} {
		entries, err := f.listSet(set)
		if err != nil {
			return nil, fmt.Errorf("list %s: %w", set, err)
		}
		for _, e := range entries {
			if k, p, err := canonicalBanEntry(e); err == nil {
				present[k] = p
			}
		}
	}
	return present, nil
}

// nftElementScript builds one transaction: deletions first, then additions,
// grouped per set and chunked.
func nftElementScript(toDel, toAdd []string) string {
	var b strings.Builder
	emit := func(verb string, keys []string) {
		bySet := map[string][]string{}
		for _, k := range keys {
			if _, p, err := canonicalBanEntry(k); err == nil {
				s := nftSetFor(p)
				bySet[s] = append(bySet[s], k)
			}
		}
		for _, set := range []string{nftSet4, nftSet6} {
			for _, chunk := range chunkStrings(bySet[set], nftElemsPerStmt) {
				fmt.Fprintf(&b, "%s element inet %s %s { %s }\n", verb, nftTable, set, strings.Join(chunk, ", "))
			}
		}
	}
	emit("delete", toDel)
	emit("add", toAdd)
	return b.String()
}

// apply runs the planned changes as one atomic script; when the kernel refuses
// it, each element is retried alone so one bad element cannot block the rest.
// Returns the number of elements that failed.
func (f *NftablesFirewall) apply(toDel, toAdd []string) int {
	if len(toDel) == 0 && len(toAdd) == 0 {
		return 0
	}
	script := nftElementScript(toDel, toAdd)
	err := fwRunStdin(script, "nft", "-f", "-")
	if err == nil {
		return 0
	}
	log.Printf("Firewall: nft batch refused (%v) — applying per element", err)
	failed := 0
	one := func(verb, k string) {
		_, p, perr := canonicalBanEntry(k)
		if perr != nil {
			failed++
			return
		}
		if e := fwRun("nft", verb, "element", "inet", nftTable, nftSetFor(p), "{", k, "}"); e != nil {
			failed++
			if verb == "add" {
				log.Printf("Firewall: nft add %s failed: %v", k, e)
			}
		}
	}
	for _, k := range toDel {
		one("delete", k)
	}
	for _, k := range toAdd {
		one("add", k)
	}
	return failed
}

func (f *NftablesFirewall) BanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.ensureTable(); err != nil {
		return err
	}
	f.pendingAdd = append(f.pendingAdd, ip)
	return nil
}

func (f *NftablesFirewall) UnbanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pendingDel = append(f.pendingDel, ip)
	return nil
}

func (f *NftablesFirewall) Flush() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.pendingAdd) == 0 && len(f.pendingDel) == 0 {
		return nil
	}
	adds, dels := f.pendingAdd, f.pendingDel
	f.pendingAdd, f.pendingDel = nil, nil
	if err := f.ensureTable(); err != nil {
		return err
	}
	present, err := f.listPresent()
	if err != nil {
		return fmt.Errorf("nft flush: %w", err)
	}
	toDel, toAdd := planIntervalSet(present, f.covered, adds, dels)
	if f.legacy {
		// Entries still held by the old set are removed from it as well.
		for _, d := range canonicalBanList(dels) {
			fwRun("nft", "delete", "element", "inet", nftTable, nftLegacySet, "{", d, "}")
		}
	}
	if failed := f.apply(toDel, toAdd); failed > 0 {
		log.Printf("Firewall: nft flush — %d element(s) not applied", failed)
	}
	return nil
}

func (f *NftablesFirewall) GetBannedIPs() ([]string, error) {
	// IMPORTANT: only report the server-managed ban sets. The rate-limit
	// escalation set (nftRLBanSet) is intentionally excluded so the server's
	// computeBanDelta does not try to "unban" IPs the rate limiter auto-banned.
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.ensureTable(); err != nil {
		return nil, nil
	}
	present, err := f.listPresent()
	if err != nil {
		return nil, nil
	}
	out := reportWithCovered(present, f.covered)
	if f.legacy {
		if legacyEntries, lerr := f.listSet(nftLegacySet); lerr == nil {
			out = append(out, legacyEntries...)
			out = canonicalBanList(out)
		}
	}
	return out, nil
}

// ── nftables rate limiting ──────────────────────────────────────────────────
//
// Strategy (declarative, rebuilt on every ApplyRateLimits call):
//   - one timeout set "obliguard_rl_bans" holds IPs auto-banned for blowing
//     past the limit; elements expire on their own (ban_ttl) via the set's
//     `flags timeout`. This set is SEPARATE from the server-managed ban set so
//     the two never fight (see GetBannedIPs).
//   - two chains hooked at input AND forward (priority -15, before the ban
//     chains at -10) so both host-bound traffic and traffic forwarded to Docker
//     containers are rate limited.
//   - each chain drops anything already in the ban set, then evaluates the
//     per-rule meters: a high-threshold meter (maxValue × banMultiplier) that
//     records a timeout ban, followed by the soft meter (maxValue) that drops.

const nftRLBanSet = "obliguard_rl_bans"
const nftRLChainIn = "ratelimit_in"
const nftRLChainFwd = "ratelimit_fwd"

func (f *NftablesFirewall) IsRateLimitSupported() bool { return true }

func (f *NftablesFirewall) ApplyRateLimits(rules []RateLimitRule) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.ensureTable(); err != nil {
		return err
	}

	run := func(c string) { fwRun("nft", strings.Fields(c)...) }

	// Timeout-backed ban set (idempotent) and the two rate-limit chains.
	run(fmt.Sprintf("add set inet %s %s { type ipv4_addr; flags timeout; }", nftTable, nftRLBanSet))
	run(fmt.Sprintf("add chain inet %s %s { type filter hook input priority -15; policy accept; }", nftTable, nftRLChainIn))
	run(fmt.Sprintf("add chain inet %s %s { type filter hook forward priority -15; policy accept; }", nftTable, nftRLChainFwd))

	// Rebuild both chains from scratch each time so config is declarative.
	run(fmt.Sprintf("flush chain inet %s %s", nftTable, nftRLChainIn))
	run(fmt.Sprintf("flush chain inet %s %s", nftTable, nftRLChainFwd))

	for _, chain := range []struct{ name, tag string }{
		{nftRLChainIn, "i"}, {nftRLChainFwd, "f"},
	} {
		// Drop anything currently rate-limit-banned.
		run(fmt.Sprintf("add rule inet %s %s ip saddr @%s drop", nftTable, chain.name, nftRLBanSet))

		for _, r := range rules {
			if r.MaxValue < 1 || (r.Type != "connection" && r.Type != "rate" && r.Type != "volume") {
				continue
			}
			for _, cmd := range f.nftRateRules(chain.name, chain.tag, r) {
				run(cmd)
			}
		}
	}
	return nil
}

// nftRateRules builds the nft rule command(s) for one rule on one chain:
// an optional escalation→ban rule (when banMultiplier is set) followed by the
// soft enforcement rule.
//
// Supports all three types:
//   - connection : ct count over N         (per-IP concurrent connections)
//   - rate       : limit rate over N/second (per-IP new connections/sec)
//   - volume     : limit rate over N kbytes/second, action 'drop' only
//     (per-IP bandwidth cap — drops traffic over the limit; this is
//     the cross-platform "drop over limit" mode, NOT true shaping)
//
// volume + 'shape' is not expressible in nftables and is skipped here (tc territory).
func (f *NftablesFirewall) nftRateRules(chainName, chainTag string, r RateLimitRule) []string {
	if r.Type == "volume" && r.Action != "drop" {
		return nil // true shaping is handled by tc, not nftables
	}

	portTag := "all"
	portMatch := "meta l4proto tcp"
	if r.Port != nil {
		portTag = fmt.Sprintf("%d", *r.Port)
		portMatch = fmt.Sprintf("tcp dport %d", *r.Port)
	}

	typeTag := "c"
	stateMatch := "ct state new " // count new connections for conn/rate types
	switch r.Type {
	case "rate":
		typeTag = "r"
	case "volume":
		typeTag = "v"
		stateMatch = "" // byte-rate counts every packet, not just new connections
	}

	// gauge produces the meter body for a threshold in the rule's native unit.
	gauge := func(threshold int) string {
		switch r.Type {
		case "rate":
			return fmt.Sprintf("{ ip saddr limit rate over %d/second }", threshold)
		case "volume":
			// threshold is mbit/s; nftables wants a byte rate (1 mbit = 125 kbytes)
			return fmt.Sprintf("{ ip saddr limit rate over %d kbytes/second }", threshold*125)
		default: // connection
			return fmt.Sprintf("{ ip saddr ct count over %d }", threshold)
		}
	}

	verdict := "drop"
	if r.Type != "volume" && r.Action == "reject" {
		verdict = "reject"
	}

	var cmds []string

	// Escalation tier first: blowing past maxValue × banMultiplier records a
	// timeout ban (then drops). Soft-tier traffic falls through to the next rule.
	if r.BanMultiplier != nil && *r.BanMultiplier >= 2 {
		banThreshold := r.MaxValue * (*r.BanMultiplier)
		ttl := ""
		if r.BanTTLSeconds != nil && *r.BanTTLSeconds > 0 {
			ttl = fmt.Sprintf(" timeout %ds", *r.BanTTLSeconds)
		}
		cmds = append(cmds, fmt.Sprintf(
			"add rule inet %s %s %s %smeter og_%s_%s_%s_b %s add @%s { ip saddr%s } drop",
			nftTable, chainName, portMatch, stateMatch, chainTag, typeTag, portTag,
			gauge(banThreshold), nftRLBanSet, ttl,
		))
	}

	// Soft tier: over maxValue → drop/reject.
	cmds = append(cmds, fmt.Sprintf(
		"add rule inet %s %s %s %smeter og_%s_%s_%s %s %s",
		nftTable, chainName, portMatch, stateMatch, chainTag, typeTag, portTag,
		gauge(r.MaxValue), verdict,
	))

	return cmds
}
