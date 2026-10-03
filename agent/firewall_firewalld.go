package main

import (
	"fmt"
	"log"
	"net/netip"
	"os"
	"regexp"
	"strings"
	"sync"
)

// ── firewalld (ipset-based for scalability) ─────────────────────────────────
//
// Strategy: use firewalld's own ipset support. Single addresses go into the
// hash:ip ipset "obliguard"; CIDR networks go into the hash:net ipset
// "obliguard_net" (a separate set, so the long-standing host set needs no
// migration). Each ipset is referenced by two drop rich-rules. Ban/unban =
// add/delete set entries.
//
// firewalld >= 1.2 refuses overlapping entries in a hash:net ipset ("INVALID_ENTRY:
// Entry '1.2.0.0/16' overlaps with existing entry '1.2.3.0/24'"), at runtime and
// when it loads the permanent XML on --reload. Network adds are therefore planned
// with planIntervalSet, as for the nftables interval sets: a network inside a
// banned network is tracked as covered, never inserted.
// Fallback to individual rich-rules (one per entry, CIDR accepted) if ipset is
// not available.

const fwdSetName = "obliguard"
const fwdNetSetName = "obliguard_net"

type FirewalldFirewall struct {
	// mu serializes all firewall access. The command handler (cmd_ws.go) spawns
	// a fresh goroutine per config response that runs BanIP/UnbanIP/Flush, while
	// the heartbeat goroutine concurrently calls GetBannedIPs → init(). Without
	// this lock those race the pendingAdd/pendingDel slices and the initialized
	// flag (double init → double ipset-create + double --reload on a fresh box).
	mu          sync.Mutex
	hasIpset    bool
	hasNetSet   bool
	initialized bool
	pendingAdd  []string
	pendingDel  []string
	// coveredNets holds requested networks kept out of obliguard_net because a
	// banned network already contains them (see planIntervalSet).
	coveredNets map[string]netip.Prefix
	// entriesFromFile caches the firewalld capability probe for
	// --add-entries-from-file / --remove-entries-from-file: 0=unknown, 1=yes, -1=no.
	entriesFromFile int
}

func (f *FirewalldFirewall) Name() string { return "firewalld" }

func (f *FirewalldFirewall) IsAvailable() bool {
	out, err := fwOutput("firewall-cmd", "--state")
	return err == nil && strings.TrimSpace(string(out)) == "running"
}

// fwdHasToken reports whether name is one of the whitespace-separated words of
// out (`--get-ipsets` prints "obliguard obliguard_net": a substring test would
// mistake one set for the other).
func fwdHasToken(out []byte, name string) bool {
	for _, w := range strings.Fields(string(out)) {
		if w == name {
			return true
		}
	}
	return false
}

// fwdHasSetRule reports whether rules contain the drop rich-rule binding set in
// the given direction ("source" or "destination"), quoted or not.
func fwdHasSetRule(rules, dir, set string) bool {
	re := regexp.MustCompile(dir + ` ipset="?` + regexp.QuoteMeta(set) + `("|\s|$)`)
	return re.MatchString(rules)
}

// fwdEnsureIpset creates a permanent ipset if missing. Returns (present, created).
func fwdEnsureIpset(name, typ string) (bool, bool) {
	permIpsets, _ := fwOutput("firewall-cmd", "--permanent", "--get-ipsets")
	if fwdHasToken(permIpsets, name) {
		return true, false
	}
	if fwRun("firewall-cmd", "--permanent", "--new-ipset="+name, "--type="+typ, "--option=maxelem=1048576") == nil {
		return true, true
	}
	// Re-check (created concurrently / already exists).
	reCheck, _ := fwOutput("firewall-cmd", "--permanent", "--get-ipsets")
	return fwdHasToken(reCheck, name), false
}

// init() is always called with f.mu held (from BanIP/UnbanIP/GetBannedIPs), so
// it does NOT lock itself.
func (f *FirewalldFirewall) init() {
	if f.initialized {
		return
	}
	f.initialized = true

	// changed tracks whether we mutated PERMANENT config, so we reload at most
	// once (and only when necessary) to materialize the runtime ipsets + rules.
	changed := false

	// Create the ipsets if missing (ipset *creation* is permanent-only). maxelem
	// is raised well above any realistic ban volume (default is 65536; large
	// fleets have reported 30K+ bans) so adds never silently fail on a full set.
	var created bool
	f.hasIpset, created = fwdEnsureIpset(fwdSetName, "hash:ip")
	changed = changed || created
	if !f.hasIpset {
		return
	}
	f.hasNetSet, created = fwdEnsureIpset(fwdNetSetName, "hash:net")
	changed = changed || created

	sets := []string{fwdSetName}
	if f.hasNetSet {
		sets = append(sets, fwdNetSetName)
	}

	// Ensure the drop rich-rules of each ipset exist (permanent). Only add when
	// absent so agent restarts don't churn permanent config / force reloads.
	existingRules, _ := fwOutput("firewall-cmd", "--permanent", "--list-rich-rules")
	rules := string(existingRules)
	for _, set := range sets {
		if !fwdHasSetRule(rules, "source", set) {
			fwRun("firewall-cmd", "--permanent", fmt.Sprintf("--add-rich-rule=rule family=ipv4 source ipset=%s drop", set))
			changed = true
		}
		if !fwdHasSetRule(rules, "destination", set) {
			fwRun("firewall-cmd", "--permanent", fmt.Sprintf("--add-rich-rule=rule family=ipv4 destination ipset=%s drop", set))
			changed = true
		}
	}

	// Migrate legacy per-IP rich-rules into the ipset and remove them (one-time;
	// bounded by the number of pre-existing legacy rules, ~0 on a fresh deploy).
	if f.migrateLegacyRichRules() {
		changed = true
	}

	// Reload ONCE — only if we changed permanent config, or if the RUNTIME state
	// is incomplete. "Incomplete" means either a runtime ipset is absent, or
	// one of the drop rich-rules is missing at runtime. The rich-rule check
	// closes a silent enforcement hole: a partial/failed prior reload can
	// materialize the ipset in the runtime WITHOUT its referencing drop rules —
	// Flush would then add IPs to a set nothing drops on, so GetBannedIPs reports
	// them "banned" while attacker traffic still flows. Never reloaded again after
	// init(): steady-state Flush() applies to the runtime set directly, so there
	// is no per-cycle --reload storm.
	needReload := changed
	if !needReload {
		runtimeIpsets, _ := fwOutput("firewall-cmd", "--get-ipsets")
		runtimeRules, _ := fwOutput("firewall-cmd", "--list-rich-rules")
		rr := string(runtimeRules)
		for _, set := range sets {
			if !fwdHasToken(runtimeIpsets, set) || !fwdHasSetRule(rr, "source", set) || !fwdHasSetRule(rr, "destination", set) {
				needReload = true
			}
		}
	}
	if needReload {
		fwRun("firewall-cmd", "--reload")
	}
}

// SupportsCIDR implements cidrSupporter: networks need the hash:net ipset
// (or the rich-rule fallback, which accepts them directly).
func (f *FirewalldFirewall) SupportsCIDR() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.init()
	return !f.hasIpset || f.hasNetSet
}

// fwdAddressRe extracts the address of a "source|destination address=X" rich-rule.
var fwdAddressRe = regexp.MustCompile(`address="?([0-9A-Fa-f:.]+(?:/[0-9]{1,3})?)"?`)

// fwdRuleAddress returns the canonical address of a drop rich-rule, or "".
func fwdRuleAddress(line string) string {
	m := fwdAddressRe.FindStringSubmatch(line)
	if m == nil {
		return ""
	}
	k, _, err := canonicalBanEntry(m[1])
	if err != nil {
		return ""
	}
	return k
}

// migrateLegacyRichRules finds individual "source address=X.X.X.X drop" rich-rules,
// imports their IPs into the ipset, and removes the rules. Only single IPv4
// addresses are migrated: a network rule is more likely an admin's own and is
// left alone.
// migrateLegacyRichRules returns true if it migrated at least one rule (so the
// caller knows permanent config changed and a single reload is warranted).
func (f *FirewalldFirewall) migrateLegacyRichRules() bool {
	out, err := fwOutput("firewall-cmd", "--permanent", "--list-rich-rules")
	if err != nil {
		return false
	}
	var legacyIPs []string
	var legacyLines []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "drop") {
			continue
		}
		// Skip the ipset-based rules we just created
		if strings.Contains(line, "ipset=") {
			continue
		}
		// Extract IP from "rule family=ipv4 source address=X.X.X.X drop"
		if ip := fwdRuleAddress(line); ip != "" && !strings.Contains(ip, "/") && ipPattern().MatchString(ip) {
			legacyIPs = append(legacyIPs, ip)
			legacyLines = append(legacyLines, line)
		}
	}
	if len(legacyIPs) == 0 {
		return false
	}
	// Import all legacy IPs into the permanent ipset in as few calls as possible
	// (batch), then remove the legacy rich-rules.
	f.applyEntries(fwdSetName, legacyIPs, true, true)
	for _, line := range legacyLines {
		fwRun("firewall-cmd", "--permanent", "--remove-rich-rule="+line)
	}
	log.Printf("Firewall: migrated %d legacy firewalld rich-rules to ipset", len(legacyIPs))
	return true
}

// fwdRichRules returns the in/out drop rich-rules of the fallback mode.
func fwdRichRules(k string, isV4 bool) (string, string) {
	family := "ipv4"
	if !isV4 {
		family = "ipv6"
	}
	return fmt.Sprintf("rule family=%s source address=%s drop", family, k),
		fmt.Sprintf("rule family=%s destination address=%s drop", family, k)
}

func (f *FirewalldFirewall) BanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.init()
	if f.hasIpset {
		k, err := iptEntry(ip, f.hasNetSet)
		if err != nil {
			return err
		}
		f.pendingAdd = append(f.pendingAdd, k)
		return nil
	}
	k, p, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	ruleIn, ruleOut := fwdRichRules(k, p.Addr().Is4())
	fwRun("firewall-cmd", "--permanent", "--add-rich-rule="+ruleIn)
	fwRun("firewall-cmd", "--permanent", "--add-rich-rule="+ruleOut)
	return fwRun("firewall-cmd", "--reload")
}

func (f *FirewalldFirewall) UnbanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.init()
	k, p, err := canonicalBanEntry(ip)
	if err != nil {
		return err
	}
	if f.hasIpset {
		f.pendingDel = append(f.pendingDel, k)
		return nil
	}
	ruleIn, ruleOut := fwdRichRules(k, p.Addr().Is4())
	fwRun("firewall-cmd", "--permanent", "--remove-rich-rule="+ruleIn)
	fwRun("firewall-cmd", "--permanent", "--remove-rich-rule="+ruleOut)
	return fwRun("firewall-cmd", "--reload")
}

// hasEntriesFromFile probes (once) whether this firewalld build supports the
// batch --add-entries-from-file / --remove-entries-from-file options (firewalld
// >= 0.6.0; present on all RHEL/Rocky/Alma 8/9 and Fedora). Result is cached.
func (f *FirewalldFirewall) hasEntriesFromFile() bool {
	if f.entriesFromFile == 0 {
		out, err := fwOutput("firewall-cmd", "--help")
		text := string(out)
		if err != nil {
			text += err.Error()
		}
		if strings.Contains(text, "--add-entries-from-file") {
			f.entriesFromFile = 1
		} else {
			f.entriesFromFile = -1
		}
	}
	return f.entriesFromFile == 1
}

// writeEntriesFile writes IPs (one per line) to a temp file firewalld can read
// via --add-entries-from-file / --remove-entries-from-file. Caller removes it.
func writeEntriesFile(ips []string) (string, error) {
	tmp, err := os.CreateTemp("", "obliguard-ipset-*.txt")
	if err != nil {
		return "", err
	}
	name := tmp.Name()
	_, werr := tmp.WriteString(strings.Join(ips, "\n") + "\n")
	cerr := tmp.Close()
	if werr != nil {
		os.Remove(name)
		return "", werr
	}
	if cerr != nil {
		os.Remove(name)
		return "", cerr
	}
	return name, nil
}

// fwdBatchSize bounds how many IPs go into one --add-entries-from-file call, so
// a single firewall-cmd invocation can't hold firewalld's dbus lock for an
// unbounded time on a very large cold sync.
const fwdBatchSize = 1000

// applyEntries adds (add=true) or removes (add=false) a batch of entries
// to/from one of the obliguard ipsets. permanent=false targets the live
// RUNTIME set (immediate enforcement, no --reload, no permanent-XML reparse);
// permanent=true mirrors into the on-disk config (persist + legacy migration).
// Empty batch = zero processes.
//
// ADD and REMOVE take deliberately different paths:
//
//   - ADD uses --add-entries-from-file: ONE firewall-cmd process per <=1000-IP
//     chunk (a tiny constant number of processes for a 4000-IP cold sync),
//     instead of the old one-process-per-IP loop that was O(n) processes AND
//     O(n^2) permanent-XML reparses — the root cause of the incident. Adding an
//     already-present hash:ip entry only warns, so a duplicated add is safe. If
//     a whole batch call fails (older firewalld that aborts the batch atomically,
//     or a bad line), it falls back to a per-entry loop so one line can't drop
//     the batch and stall convergence.
//
//   - REMOVE is ALWAYS per-entry, never --remove-entries-from-file. On the
//     nftables backend, removing an entry that isn't present raises a CRITICAL
//     COMMAND_FAILED (firewalld#794) that ABORTS the whole batch — so a single
//     stale IP would drop every other valid removal, leave them reported by
//     GetBannedIPs, and make the server re-send the same remove[] forever. An
//     isolated per-entry .Run() swallows the "not present" error so removals are
//     idempotent and always converge. Removals are tiny at steady state.
func (f *FirewalldFirewall) applyEntries(set string, ips []string, add bool, permanent bool) {
	if len(ips) == 0 {
		return
	}
	base := []string{}
	if permanent {
		base = append(base, "--permanent")
	}
	base = append(base, "--ipset="+set)

	if !add {
		// Per-entry, idempotent, isolated — see firewalld#794 note above.
		for _, ip := range ips {
			args := append(append([]string{}, base...), "--remove-entry="+ip)
			fwRun("firewall-cmd", args...)
		}
		return
	}

	if f.hasEntriesFromFile() {
		if f.addEntriesFromFile(base, ips) {
			return
		}
		// Batch path failed as a whole — fall through to the per-entry loop.
		log.Printf("Firewall: batch add fell back to per-entry")
	}

	// Fallback for firewalld < 0.6 (no *-entries-from-file), or when the batch
	// path failed. firewall-cmd argparse keeps only the LAST --add-entry, so
	// entries CANNOT be combined into one call — we must loop. O(n) processes,
	// but each is a cheap runtime (or permanent, no-reload) op with no ruleset
	// rebuild — NOT the old O(n^2)+per-cycle-reload storm. Idempotent.
	for _, ip := range ips {
		args := append(append([]string{}, base...), "--add-entry="+ip)
		fwRun("firewall-cmd", args...)
	}
}

// addEntriesFromFile applies adds in <=fwdBatchSize chunks via
// --add-entries-from-file (one firewall-cmd process per chunk). Returns true if
// every chunk succeeded; false (caller falls back to per-entry) on any failure.
func (f *FirewalldFirewall) addEntriesFromFile(base, ips []string) bool {
	for _, chunk := range chunkStrings(ips, fwdBatchSize) {
		path, err := writeEntriesFile(chunk)
		if err != nil {
			log.Printf("Firewall: could not write entries file: %v", err)
			return false
		}
		args := append(append([]string{}, base...), "--add-entries-from-file="+path)
		_, e := fwOutput("firewall-cmd", args...)
		os.Remove(path)
		if e != nil {
			log.Printf("Firewall: batch add returned %v", e)
			return false
		}
	}
	return true
}

// splitBySet routes canonical entries to the host set or the network set.
func splitBySet(entries []string) (hosts, nets []string) {
	for _, k := range entries {
		if strings.Contains(k, "/") {
			nets = append(nets, k)
		} else {
			hosts = append(hosts, k)
		}
	}
	return hosts, nets
}

// persist mirrors the just-applied delta into PERMANENT config so bans survive
// BOTH a reboot AND an unrelated `firewall-cmd --reload` (a reload repopulates
// the runtime ipset from permanent, so anything not persisted would be silently
// un-banned).
//
// It is deliberately SCOPED to the obliguard ipsets (--permanent --ipset=...):
// it touches only /etc/firewalld/ipsets/obliguard*.xml and never runs --reload.
// We do NOT use `firewall-cmd --runtime-to-permanent`: that serializes the
// ENTIRE runtime firewall into permanent, which on a prod box freezes any
// admin runtime-only change (a temporarily opened rescue port, a diagnostic
// rule) into permanent the next time a single IP is banned, and wipes any
// permanent-only rule not yet reloaded — unacceptable collateral on the exact
// host class in the incident.
//
// Adds go through the same chunked batch path as runtime (a tiny constant
// number of processes); removes are per-entry idempotent (firewalld#794). Only
// reached on cycles that actually changed something — empty deltas never get
// here (Flush short-circuits).
func (f *FirewalldFirewall) persist(adds, dels []string) {
	f.applyDelta(adds, dels, true)
}

// applyDelta applies adds and removals to the host and network sets.
func (f *FirewalldFirewall) applyDelta(adds, dels []string, permanent bool) {
	addHosts, addNets := splitBySet(adds)
	delHosts, delNets := splitBySet(dels)
	f.applyEntries(fwdSetName, addHosts, true, permanent)
	f.applyEntries(fwdSetName, delHosts, false, permanent)
	if f.hasNetSet {
		// Removals first: a network that retires the narrower ones it contains
		// is refused while they are still in the set (overlap).
		f.applyEntries(fwdNetSetName, delNets, false, permanent)
		f.applyEntries(fwdNetSetName, addNets, true, permanent)
	}
}

// netPresent returns the runtime entries of the network set (key → prefix).
func (f *FirewalldFirewall) netPresent() (map[string]netip.Prefix, error) {
	out, err := fwOutput("firewall-cmd", "--ipset="+fwdNetSetName, "--get-entries")
	if err != nil {
		return nil, err
	}
	present := make(map[string]netip.Prefix)
	for _, k := range parseBanEntries(string(out)) {
		if _, p, perr := canonicalBanEntry(k); perr == nil {
			present[k] = p
		}
	}
	return present, nil
}

// planNets resolves overlaps of the network delta against the live network set
// (firewalld refuses overlapping hash:net entries). When the set cannot be read
// the delta is returned unchanged.
func (f *FirewalldFirewall) planNets(addNets, delNets []string) (toDel, toAdd []string) {
	if f.coveredNets == nil {
		f.coveredNets = make(map[string]netip.Prefix)
	}
	present, err := f.netPresent()
	if err != nil {
		return delNets, addNets
	}
	return planIntervalSet(present, f.coveredNets, addNets, delNets)
}

func (f *FirewalldFirewall) Flush() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.hasIpset {
		return nil
	}
	// Empty flush = zero firewall-cmd calls.
	if len(f.pendingAdd) == 0 && len(f.pendingDel) == 0 {
		return nil
	}
	adds := f.pendingAdd
	dels := f.pendingDel
	f.pendingAdd = nil
	f.pendingDel = nil

	if f.hasNetSet {
		addHosts, addNets := splitBySet(adds)
		delHosts, delNets := splitBySet(dels)
		if len(addNets) > 0 || len(delNets) > 0 {
			// Requested removals are always sent as well (per-entry and
			// idempotent), so a permanent entry missing from the runtime set
			// cannot come back on the next --reload.
			planDel, planAdd := f.planNets(addNets, delNets)
			delNets, addNets = canonicalBanList(append(planDel, delNets...)), planAdd
		}
		adds = append(addHosts, addNets...)
		dels = append(delHosts, delNets...)
	}

	// 1) Enforce on the RUNTIME ipsets — immediate, no --reload, no permanent
	//    reparse. Adds batch into a tiny constant number of firewall-cmd
	//    processes; removes are per-entry idempotent.
	f.applyDelta(adds, dels, false)

	// 2) Mirror the delta into PERMANENT (scoped to our ipsets) for reboot AND
	//    --reload survival. No per-cycle --reload, ever; only touches
	//    obliguard*.xml. Only cycles that changed something reach here.
	f.persist(adds, dels)
	return nil
}

func (f *FirewalldFirewall) GetBannedIPs() ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.init()
	if f.hasIpset {
		// Read the RUNTIME sets (drop --permanent): this is what is actually
		// enforced, so the server's ban delta (desired − reported) converges to
		// empty as soon as a runtime add lands, instead of trailing permanent
		// writes and re-sending adds.
		out, err := fwOutput("firewall-cmd", "--ipset="+fwdSetName, "--get-entries")
		if err != nil {
			return nil, nil
		}
		entries := parseBanEntries(string(out))
		if f.hasNetSet {
			if present, nerr := f.netPresent(); nerr == nil {
				// Networks plus the covered ones a present network still contains.
				entries = append(entries, reportWithCovered(present, f.coveredNets)...)
				entries = canonicalBanList(entries)
			}
		}
		return entries, nil
	}
	out, err := fwOutput("firewall-cmd", "--list-rich-rules")
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var ips []string
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "drop") {
			if k := fwdRuleAddress(line); k != "" && !seen[k] {
				seen[k] = true
				ips = append(ips, k)
			}
		}
	}
	return ips, nil
}

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// Not wired for firewalld yet: rich-rules can't express per-source connlimit,
// and raw iptables rules get flushed on `firewall-cmd --reload` — needs a
// firewalld-native or nft-direct approach.

func (f *FirewalldFirewall) IsRateLimitSupported() bool              { return false }
func (f *FirewalldFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }
