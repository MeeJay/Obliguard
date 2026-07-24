package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
)

// ── FirewallManager interface ─────────────────────────────────────────────────

// FirewallManager abstracts platform-specific firewall operations.
type FirewallManager interface {
	// BanIP adds DROP rules (inbound + outbound) for the given IP.
	BanIP(ip string) error
	// UnbanIP removes all Obliguard rules for the given IP.
	UnbanIP(ip string) error
	// GetBannedIPs returns the list of IPs currently banned by Obliguard.
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

// ── nftables (set-based — single rule matches all IPs) ──────────────────────
//
// Strategy: one nftables set "obliguard_ips" holds all banned IPs.
// Two rules (inbound + outbound) match the set. Ban/unban = add/delete from set.
// Result: 2 rules total regardless of IP count.

const nftTable = "obliguard"
const nftSet = "obliguard_ips"
const nftChain = "blocklist"
const nftChainOut = "blocklist_out"

type NftablesFirewall struct {
	initialized bool
	pendingAdd  []string
	pendingDel  []string
}

func (f *NftablesFirewall) Name() string { return "nftables" }

func (f *NftablesFirewall) IsAvailable() bool {
	_, err := exec.LookPath("nft")
	return err == nil
}

func (f *NftablesFirewall) ensureTable() error {
	if f.initialized {
		return nil
	}
	cmds := []string{
		fmt.Sprintf("add table inet %s", nftTable),
		fmt.Sprintf("add set inet %s %s { type ipv4_addr; }", nftTable, nftSet),
		fmt.Sprintf("add chain inet %s %s { type filter hook input priority -10; policy accept; }", nftTable, nftChain),
		fmt.Sprintf("add chain inet %s %s { type filter hook output priority -10; policy accept; }", nftTable, nftChainOut),
	}
	for _, c := range cmds {
		exec.Command("nft", strings.Fields(c)...).Run()
	}
	exec.Command("nft", "flush", "chain", "inet", nftTable, nftChain).Run()
	exec.Command("nft", "flush", "chain", "inet", nftTable, nftChainOut).Run()
	ruleIn := fmt.Sprintf("add rule inet %s %s ip saddr @%s drop", nftTable, nftChain, nftSet)
	ruleOut := fmt.Sprintf("add rule inet %s %s ip daddr @%s drop", nftTable, nftChainOut, nftSet)
	exec.Command("nft", strings.Fields(ruleIn)...).Run()
	exec.Command("nft", strings.Fields(ruleOut)...).Run()
	f.initialized = true
	return nil
}

func (f *NftablesFirewall) BanIP(ip string) error {
	if err := f.ensureTable(); err != nil {
		return err
	}
	f.pendingAdd = append(f.pendingAdd, ip)
	return nil
}

func (f *NftablesFirewall) UnbanIP(ip string) error {
	f.pendingDel = append(f.pendingDel, ip)
	return nil
}

func (f *NftablesFirewall) Flush() error {
	// Batch add: nft add element inet obliguard obliguard_ips { ip1, ip2, ip3 }
	if len(f.pendingAdd) > 0 {
		ipList := strings.Join(f.pendingAdd, ", ")
		cmd := fmt.Sprintf("add element inet %s %s { %s }", nftTable, nftSet, ipList)
		if err := exec.Command("nft", strings.Fields(cmd)...).Run(); err != nil {
			// Fallback: add one by one (some may already exist)
			for _, ip := range f.pendingAdd {
				c := fmt.Sprintf("add element inet %s %s { %s }", nftTable, nftSet, ip)
				exec.Command("nft", strings.Fields(c)...).Run()
			}
		}
		f.pendingAdd = nil
	}
	// Batch delete
	if len(f.pendingDel) > 0 {
		ipList := strings.Join(f.pendingDel, ", ")
		cmd := fmt.Sprintf("delete element inet %s %s { %s }", nftTable, nftSet, ipList)
		if err := exec.Command("nft", strings.Fields(cmd)...).Run(); err != nil {
			for _, ip := range f.pendingDel {
				c := fmt.Sprintf("delete element inet %s %s { %s }", nftTable, nftSet, ip)
				exec.Command("nft", strings.Fields(c)...).Run()
			}
		}
		f.pendingDel = nil
	}
	return nil
}

func (f *NftablesFirewall) GetBannedIPs() ([]string, error) {
	// IMPORTANT: only report the server-managed ban set. The rate-limit
	// escalation set (nftRLBanSet) is intentionally excluded so the server's
	// computeBanDelta does not try to "unban" IPs the rate limiter auto-banned.
	out, err := exec.Command("nft", "list", "set", "inet", nftTable, nftSet).Output()
	if err != nil {
		return nil, nil
	}
	var ips []string
	ipRe := ipPattern()
	for _, m := range ipRe.FindAllString(string(out), -1) {
		ips = append(ips, m)
	}
	return ips, nil
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
	if err := f.ensureTable(); err != nil {
		return err
	}

	run := func(c string) { exec.Command("nft", strings.Fields(c)...).Run() }

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

// ── firewalld (ipset-based for scalability) ─────────────────────────────────
//
// Strategy: use an ipset "obliguard" managed via firewalld's own ipset support.
// Two rich-rules reference the ipset. Ban/unban = add/delete from ipset.
// Fallback to individual rich-rules if ipset is not available.

const fwdSetName = "obliguard"

type FirewalldFirewall struct {
	// mu serializes all firewall access. The command handler (cmd_ws.go) spawns
	// a fresh goroutine per config response that runs BanIP/UnbanIP/Flush, while
	// the heartbeat goroutine concurrently calls GetBannedIPs → init(). Without
	// this lock those race the pendingAdd/pendingDel slices and the initialized
	// flag (double init → double ipset-create + double --reload on a fresh box).
	mu          sync.Mutex
	hasIpset    bool
	initialized bool
	pendingAdd  []string
	pendingDel  []string
	// entriesFromFile caches the firewalld capability probe for
	// --add-entries-from-file / --remove-entries-from-file: 0=unknown, 1=yes, -1=no.
	entriesFromFile int
}

func (f *FirewalldFirewall) Name() string { return "firewalld" }

func (f *FirewalldFirewall) IsAvailable() bool {
	out, err := exec.Command("firewall-cmd", "--state").Output()
	return err == nil && strings.TrimSpace(string(out)) == "running"
}

//
// init() is always called with f.mu held (from BanIP/UnbanIP/GetBannedIPs), so
// it does NOT lock itself.
func (f *FirewalldFirewall) init() {
	if f.initialized {
		return
	}
	f.initialized = true

	// changed tracks whether we mutated PERMANENT config, so we reload at most
	// once (and only when necessary) to materialize the runtime ipset + rules.
	changed := false

	// Create the ipset if missing (ipset *creation* is permanent-only). maxelem
	// is raised well above any realistic ban volume (default is 65536; large
	// fleets have reported 30K+ bans) so adds never silently fail on a full set.
	permIpsets, _ := exec.Command("firewall-cmd", "--permanent", "--get-ipsets").Output()
	if strings.Contains(string(permIpsets), fwdSetName) {
		f.hasIpset = true
	} else if err := exec.Command("firewall-cmd", "--permanent", "--new-ipset="+fwdSetName, "--type=hash:ip", "--option=maxelem=1048576").Run(); err == nil {
		f.hasIpset = true
		changed = true
	} else {
		// Re-check (created concurrently / already exists).
		reCheck, _ := exec.Command("firewall-cmd", "--permanent", "--get-ipsets").Output()
		f.hasIpset = strings.Contains(string(reCheck), fwdSetName)
	}
	if !f.hasIpset {
		return
	}

	// Ensure the two ipset drop rich-rules exist (permanent). Only add when
	// absent so agent restarts don't churn permanent config / force reloads.
	existingRules, _ := exec.Command("firewall-cmd", "--permanent", "--list-rich-rules").Output()
	rules := string(existingRules)
	ruleIn := fmt.Sprintf("rule family=ipv4 source ipset=%s drop", fwdSetName)
	ruleOut := fmt.Sprintf("rule family=ipv4 destination ipset=%s drop", fwdSetName)
	if !strings.Contains(rules, "source ipset=\""+fwdSetName+"\"") && !strings.Contains(rules, "source ipset="+fwdSetName) {
		exec.Command("firewall-cmd", "--permanent", "--add-rich-rule="+ruleIn).Run()
		changed = true
	}
	if !strings.Contains(rules, "destination ipset=\""+fwdSetName+"\"") && !strings.Contains(rules, "destination ipset="+fwdSetName) {
		exec.Command("firewall-cmd", "--permanent", "--add-rich-rule="+ruleOut).Run()
		changed = true
	}

	// Migrate legacy per-IP rich-rules into the ipset and remove them (one-time;
	// bounded by the number of pre-existing legacy rules, ~0 on a fresh deploy).
	if f.migrateLegacyRichRules() {
		changed = true
	}

	// Reload ONCE — only if we changed permanent config, or if the RUNTIME state
	// is incomplete. "Incomplete" means either the runtime ipset is absent, or
	// one of the two drop rich-rules is missing at runtime. The rich-rule check
	// closes a silent enforcement hole: a partial/failed prior reload can
	// materialize the ipset in the runtime WITHOUT its referencing drop rules —
	// Flush would then add IPs to a set nothing drops on, so GetBannedIPs reports
	// them "banned" while attacker traffic still flows. Never reloaded again after
	// init(): steady-state Flush() applies to the runtime set directly, so there
	// is no per-cycle --reload storm.
	needReload := changed
	if !needReload {
		runtimeIpsets, _ := exec.Command("firewall-cmd", "--get-ipsets").Output()
		if !strings.Contains(string(runtimeIpsets), fwdSetName) {
			needReload = true
		} else {
			runtimeRules, _ := exec.Command("firewall-cmd", "--list-rich-rules").Output()
			rr := string(runtimeRules)
			haveIn := strings.Contains(rr, "source ipset=\""+fwdSetName+"\"") || strings.Contains(rr, "source ipset="+fwdSetName)
			haveOut := strings.Contains(rr, "destination ipset=\""+fwdSetName+"\"") || strings.Contains(rr, "destination ipset="+fwdSetName)
			if !haveIn || !haveOut {
				needReload = true
			}
		}
	}
	if needReload {
		exec.Command("firewall-cmd", "--reload").Run()
	}
}

// migrateLegacyRichRules finds individual "source address=X.X.X.X drop" rich-rules,
// imports their IPs into the ipset, and removes the rules.
// migrateLegacyRichRules returns true if it migrated at least one rule (so the
// caller knows permanent config changed and a single reload is warranted).
func (f *FirewalldFirewall) migrateLegacyRichRules() bool {
	out, err := exec.Command("firewall-cmd", "--permanent", "--list-rich-rules").Output()
	if err != nil {
		return false
	}
	ipRe := ipPattern()
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
		if m := ipRe.FindString(line); m != "" {
			legacyIPs = append(legacyIPs, m)
			legacyLines = append(legacyLines, line)
		}
	}
	if len(legacyIPs) == 0 {
		return false
	}
	// Import all legacy IPs into the permanent ipset in as few calls as possible
	// (batch), then remove the legacy rich-rules.
	f.applyEntries(legacyIPs, true, true)
	for _, line := range legacyLines {
		exec.Command("firewall-cmd", "--permanent", "--remove-rich-rule="+line).Run()
	}
	log.Printf("Firewall: migrated %d legacy firewalld rich-rules to ipset", len(legacyIPs))
	return true
}

func (f *FirewalldFirewall) BanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.init()
	if f.hasIpset {
		f.pendingAdd = append(f.pendingAdd, ip)
		return nil
	}
	ruleIn := fmt.Sprintf("rule family=ipv4 source address=%s drop", ip)
	ruleOut := fmt.Sprintf("rule family=ipv4 destination address=%s drop", ip)
	exec.Command("firewall-cmd", "--permanent", fmt.Sprintf("--add-rich-rule=%s", ruleIn)).Run()
	exec.Command("firewall-cmd", "--permanent", fmt.Sprintf("--add-rich-rule=%s", ruleOut)).Run()
	return exec.Command("firewall-cmd", "--reload").Run()
}

func (f *FirewalldFirewall) UnbanIP(ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.init()
	if f.hasIpset {
		f.pendingDel = append(f.pendingDel, ip)
		return nil
	}
	ruleIn := fmt.Sprintf("rule family=ipv4 source address=%s drop", ip)
	ruleOut := fmt.Sprintf("rule family=ipv4 destination address=%s drop", ip)
	exec.Command("firewall-cmd", "--permanent", fmt.Sprintf("--remove-rich-rule=%s", ruleIn)).Run()
	exec.Command("firewall-cmd", "--permanent", fmt.Sprintf("--remove-rich-rule=%s", ruleOut)).Run()
	return exec.Command("firewall-cmd", "--reload").Run()
}

// hasEntriesFromFile probes (once) whether this firewalld build supports the
// batch --add-entries-from-file / --remove-entries-from-file options (firewalld
// >= 0.6.0; present on all RHEL/Rocky/Alma 8/9 and Fedora). Result is cached.
func (f *FirewalldFirewall) hasEntriesFromFile() bool {
	if f.entriesFromFile == 0 {
		out, _ := exec.Command("firewall-cmd", "--help").CombinedOutput()
		if strings.Contains(string(out), "--add-entries-from-file") {
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

// applyEntries adds (add=true) or removes (add=false) a batch of IPs to/from the
// obliguard ipset. permanent=false targets the live RUNTIME set (immediate
// enforcement, no --reload, no permanent-XML reparse); permanent=true mirrors
// into the on-disk config (persist + legacy migration). Empty batch = zero
// processes.
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
func (f *FirewalldFirewall) applyEntries(ips []string, add bool, permanent bool) {
	if len(ips) == 0 {
		return
	}
	base := []string{}
	if permanent {
		base = append(base, "--permanent")
	}
	base = append(base, "--ipset="+fwdSetName)

	if !add {
		// Per-entry, idempotent, isolated — see firewalld#794 note above.
		for _, ip := range ips {
			args := append(append([]string{}, base...), "--remove-entry="+ip)
			exec.Command("firewall-cmd", args...).Run()
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
		exec.Command("firewall-cmd", args...).Run()
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
		out, e := exec.Command("firewall-cmd", args...).CombinedOutput()
		os.Remove(path)
		if e != nil {
			log.Printf("Firewall: batch add returned %v: %s", e, strings.TrimSpace(string(out)))
			return false
		}
	}
	return true
}

// persist mirrors the just-applied delta into PERMANENT config so bans survive
// BOTH a reboot AND an unrelated `firewall-cmd --reload` (a reload repopulates
// the runtime ipset from permanent, so anything not persisted would be silently
// un-banned).
//
// It is deliberately SCOPED to the obliguard ipset (--permanent --ipset=...):
// it touches only /etc/firewalld/ipsets/obliguard.xml and never runs --reload.
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
	f.applyEntries(adds, true, true)
	f.applyEntries(dels, false, true)
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

	// 1) Enforce on the RUNTIME ipset — immediate, no --reload, no permanent
	//    reparse. Adds batch into a tiny constant number of firewall-cmd
	//    processes; removes are per-entry idempotent.
	f.applyEntries(adds, true, false)
	f.applyEntries(dels, false, false)

	// 2) Mirror the delta into PERMANENT (scoped to our ipset) for reboot AND
	//    --reload survival. No per-cycle --reload, ever; only touches
	//    obliguard.xml. Only cycles that changed something reach here.
	f.persist(adds, dels)
	return nil
}

func (f *FirewalldFirewall) GetBannedIPs() ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.init()
	if f.hasIpset {
		// Read the RUNTIME set (drop --permanent): this is what is actually
		// enforced, so the server's ban delta (desired − reported) converges to
		// empty as soon as a runtime add lands, instead of trailing permanent
		// writes and re-sending adds.
		out, err := exec.Command("firewall-cmd", "--ipset="+fwdSetName, "--get-entries").Output()
		if err != nil {
			return nil, nil
		}
		var ips []string
		for _, line := range strings.Split(string(out), "\n") {
			ip := strings.TrimSpace(line)
			if ip != "" && ipPattern().MatchString(ip) {
				ips = append(ips, ip)
			}
		}
		return ips, nil
	}
	out, err := exec.Command("firewall-cmd", "--list-rich-rules").Output()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var ips []string
	ipRe := ipPattern()
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "drop") {
			if m := ipRe.FindString(line); m != "" && !seen[m] {
				seen[m] = true
				ips = append(ips, m)
			}
		}
	}
	return ips, nil
}

// ── UFW (uses ipset under the hood if available) ─────────────────────────────
//
// UFW doesn't support ipsets natively. When ipset is available, we bypass ufw
// and inject iptables rules matching the ipset directly. This scales to 30K+ IPs.
// Fallback: individual ufw deny rules (slow for large sets).

const ufwSetName = "obliguard"

type UFWFirewall struct {
	hasIpset    bool
	initialized bool
	pendingAdd  []string
	pendingDel  []string
}

func (f *UFWFirewall) Name() string { return "ufw" }

func (f *UFWFirewall) IsAvailable() bool {
	out, err := exec.Command("ufw", "status").Output()
	return err == nil && strings.Contains(string(out), "Status: active")
}

func (f *UFWFirewall) init() {
	if f.initialized {
		return
	}
	f.initialized = true
	_, err := exec.LookPath("ipset")
	f.hasIpset = err == nil
	if f.hasIpset {
		exec.Command("ipset", "create", ufwSetName, "hash:ip", "-exist").Run()
		// Add iptables rules matching the ipset (bypass ufw for performance)
		if exec.Command("iptables", "-C", "INPUT", "-m", "set", "--match-set", ufwSetName, "src", "-j", "DROP").Run() != nil {
			exec.Command("iptables", "-I", "INPUT", "1", "-m", "set", "--match-set", ufwSetName, "src", "-j", "DROP").Run()
		}
		if exec.Command("iptables", "-C", "OUTPUT", "-m", "set", "--match-set", ufwSetName, "dst", "-j", "DROP").Run() != nil {
			exec.Command("iptables", "-I", "OUTPUT", "1", "-m", "set", "--match-set", ufwSetName, "dst", "-j", "DROP").Run()
		}
		// Migrate legacy per-IP ufw rules into ipset
		f.migrateLegacyUfwRules()
	}
}

func (f *UFWFirewall) BanIP(ip string) error {
	f.init()
	if f.hasIpset {
		f.pendingAdd = append(f.pendingAdd, ip)
		return nil
	}
	exec.Command("ufw", "insert", "1", "deny", "from", ip, "to", "any").Run()
	return exec.Command("ufw", "insert", "1", "deny", "out", "from", "any", "to", ip).Run()
}

func (f *UFWFirewall) UnbanIP(ip string) error {
	f.init()
	if f.hasIpset {
		f.pendingDel = append(f.pendingDel, ip)
		return nil
	}
	exec.Command("ufw", "delete", "deny", "from", ip, "to", "any").Run()
	exec.Command("ufw", "delete", "deny", "out", "from", "any", "to", ip).Run()
	return nil
}

func (f *UFWFirewall) Flush() error {
	if !f.hasIpset {
		return nil
	}
	if len(f.pendingAdd) > 0 || len(f.pendingDel) > 0 {
		var lines []string
		for _, ip := range f.pendingAdd {
			lines = append(lines, fmt.Sprintf("add %s %s -exist", ufwSetName, ip))
		}
		for _, ip := range f.pendingDel {
			lines = append(lines, fmt.Sprintf("del %s %s -exist", ufwSetName, ip))
		}
		cmd := exec.Command("ipset", "restore")
		cmd.Stdin = strings.NewReader(strings.Join(lines, "\n") + "\n")
		if err := cmd.Run(); err != nil {
			for _, ip := range f.pendingAdd {
				exec.Command("ipset", "add", ufwSetName, ip, "-exist").Run()
			}
			for _, ip := range f.pendingDel {
				exec.Command("ipset", "del", ufwSetName, ip, "-exist").Run()
			}
		}
		f.pendingAdd = nil
		f.pendingDel = nil
	}
	return nil
}

func (f *UFWFirewall) GetBannedIPs() ([]string, error) {
	f.init()
	if f.hasIpset {
		out, err := exec.Command("ipset", "list", ufwSetName).Output()
		if err != nil {
			return nil, nil
		}
		var ips []string
		ipRe := ipPattern()
		inMembers := false
		for _, line := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(line, "Members:") {
				inMembers = true
				continue
			}
			if inMembers {
				if m := ipRe.FindString(line); m != "" {
					ips = append(ips, m)
				}
			}
		}
		return ips, nil
	}
	out, err := exec.Command("ufw", "status", "numbered").Output()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var ips []string
	ipRe := ipPattern()
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(strings.ToUpper(line), "DENY") {
			if m := ipRe.FindString(line); m != "" && !seen[m] {
				seen[m] = true
				ips = append(ips, m)
			}
		}
	}
	return ips, nil
}

// migrateLegacyUfwRules removes individual "deny from X.X.X.X" ufw rules
// and imports their IPs into the ipset.
func (f *UFWFirewall) migrateLegacyUfwRules() {
	out, err := exec.Command("ufw", "status", "numbered").Output()
	if err != nil {
		return
	}
	ipRe := ipPattern()
	var legacyIPs []string
	seen := make(map[string]bool)
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(strings.ToUpper(line), "DENY") {
			continue
		}
		if m := ipRe.FindString(line); m != "" && !seen[m] {
			seen[m] = true
			legacyIPs = append(legacyIPs, m)
		}
	}
	if len(legacyIPs) == 0 {
		return
	}
	log.Printf("Firewall: migrating %d legacy ufw rules to ipset...", len(legacyIPs))
	// Add all IPs to ipset first
	for _, ip := range legacyIPs {
		exec.Command("ipset", "add", ufwSetName, ip, "-exist").Run()
	}
	// Delete legacy ufw rules (delete from bottom to top to keep numbering stable)
	for i := len(legacyIPs) - 1; i >= 0; i-- {
		ip := legacyIPs[i]
		exec.Command("ufw", "--force", "delete", "deny", "from", ip, "to", "any").Run()
		exec.Command("ufw", "--force", "delete", "deny", "out", "from", "any", "to", ip).Run()
	}
	log.Printf("Firewall: migration complete — %d IPs moved to ipset", len(legacyIPs))
}

// ── iptables (ipset-based if available, fallback to chain rules) ─────────────
//
// Strategy: if ipset is available, use a hash:ip set "obliguard" with two
// iptables rules matching the set. Otherwise, fall back to individual chain rules.

const iptChain = "OBLIGUARD"
const iptChainOut = "OBLIGUARD_OUT"
const iptSetName = "obliguard"

type IptablesFirewall struct {
	initialized bool
	hasIpset    bool
	pendingAdd  []string
	pendingDel  []string
}

func (f *IptablesFirewall) Name() string { return "iptables" }

func (f *IptablesFirewall) IsAvailable() bool {
	_, err := exec.LookPath("iptables")
	return err == nil
}

func (f *IptablesFirewall) ensureChain() error {
	if f.initialized {
		return nil
	}
	// Check for ipset support
	_, ipsetErr := exec.LookPath("ipset")
	f.hasIpset = ipsetErr == nil

	if f.hasIpset {
		// Create ipset (ignore error if already exists)
		exec.Command("ipset", "create", iptSetName, "hash:ip", "-exist").Run()
		// Create chains
		exec.Command("iptables", "-N", iptChain).Run()
		exec.Command("iptables", "-N", iptChainOut).Run()
		// Hook chains into INPUT/OUTPUT
		if exec.Command("iptables", "-C", "INPUT", "-j", iptChain).Run() != nil {
			exec.Command("iptables", "-I", "INPUT", "1", "-j", iptChain).Run()
		}
		if exec.Command("iptables", "-C", "OUTPUT", "-j", iptChainOut).Run() != nil {
			exec.Command("iptables", "-I", "OUTPUT", "1", "-j", iptChainOut).Run()
		}
		// Flush chains and add set-matching rules
		exec.Command("iptables", "-F", iptChain).Run()
		exec.Command("iptables", "-F", iptChainOut).Run()
		exec.Command("iptables", "-A", iptChain, "-m", "set", "--match-set", iptSetName, "src", "-j", "DROP").Run()
		exec.Command("iptables", "-A", iptChainOut, "-m", "set", "--match-set", iptSetName, "dst", "-j", "DROP").Run()
	} else {
		// Fallback: individual rules in custom chains
		exec.Command("iptables", "-N", iptChain).Run()
		if exec.Command("iptables", "-C", "INPUT", "-j", iptChain).Run() != nil {
			exec.Command("iptables", "-I", "INPUT", "1", "-j", iptChain).Run()
		}
		exec.Command("iptables", "-N", iptChainOut).Run()
		if exec.Command("iptables", "-C", "OUTPUT", "-j", iptChainOut).Run() != nil {
			exec.Command("iptables", "-I", "OUTPUT", "1", "-j", iptChainOut).Run()
		}
	}
	f.initialized = true
	return nil
}

func (f *IptablesFirewall) BanIP(ip string) error {
	_ = f.ensureChain()
	if f.hasIpset {
		f.pendingAdd = append(f.pendingAdd, ip)
		return nil
	}
	exec.Command("iptables", "-A", iptChain, "-s", ip, "-j", "DROP").Run()
	return exec.Command("iptables", "-A", iptChainOut, "-d", ip, "-j", "DROP").Run()
}

func (f *IptablesFirewall) UnbanIP(ip string) error {
	if f.hasIpset {
		f.pendingDel = append(f.pendingDel, ip)
		return nil
	}
	exec.Command("iptables", "-D", iptChain, "-s", ip, "-j", "DROP").Run()
	exec.Command("iptables", "-D", iptChainOut, "-d", ip, "-j", "DROP").Run()
	return nil
}

func (f *IptablesFirewall) Flush() error {
	if !f.hasIpset {
		return nil // non-ipset mode applies immediately
	}
	// ipset doesn't support batch in a single command, but we can use restore
	if len(f.pendingAdd) > 0 || len(f.pendingDel) > 0 {
		var lines []string
		for _, ip := range f.pendingAdd {
			lines = append(lines, fmt.Sprintf("add %s %s -exist", iptSetName, ip))
		}
		for _, ip := range f.pendingDel {
			lines = append(lines, fmt.Sprintf("del %s %s -exist", iptSetName, ip))
		}
		cmd := exec.Command("ipset", "restore")
		cmd.Stdin = strings.NewReader(strings.Join(lines, "\n") + "\n")
		if err := cmd.Run(); err != nil {
			// Fallback: one by one
			for _, ip := range f.pendingAdd {
				exec.Command("ipset", "add", iptSetName, ip, "-exist").Run()
			}
			for _, ip := range f.pendingDel {
				exec.Command("ipset", "del", iptSetName, ip, "-exist").Run()
			}
		}
		f.pendingAdd = nil
		f.pendingDel = nil
	}
	return nil
}

func (f *IptablesFirewall) GetBannedIPs() ([]string, error) {
	if f.hasIpset {
		out, err := exec.Command("ipset", "list", iptSetName).Output()
		if err != nil {
			return nil, nil
		}
		var ips []string
		ipRe := ipPattern()
		inMembers := false
		for _, line := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(line, "Members:") {
				inMembers = true
				continue
			}
			if inMembers {
				if m := ipRe.FindString(line); m != "" {
					ips = append(ips, m)
				}
			}
		}
		return ips, nil
	}
	out, err := exec.Command("iptables", "-L", iptChain, "-n").Output()
	if err != nil {
		return nil, nil
	}
	var ips []string
	ipRe := ipPattern()
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "DROP") {
			if m := ipRe.FindString(line); m != "" {
				ips = append(ips, m)
			}
		}
	}
	return ips, nil
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
	return exec.Command("iptables", "-L", "DOCKER-USER", "-n").Run() == nil
}

// ensureRLJump idempotently inserts a jump to OBLIGUARD_RL at the top of chain.
func ensureRLJump(parent string) {
	if exec.Command("iptables", "-C", parent, "-j", iptRLChain).Run() != nil {
		exec.Command("iptables", "-I", parent, "1", "-j", iptRLChain).Run()
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
	if _, err := exec.LookPath("ipset"); err == nil {
		hasIpset = true
	}

	// Dedicated rate-limit chain + escalation ban set.
	exec.Command("iptables", "-N", iptRLChain).Run() // ignore "exists"
	if hasIpset {
		exec.Command("ipset", "create", iptRLBanSet, "hash:ip", "timeout", "0", "-exist").Run()
	}

	// Hook points: always INPUT, plus exactly one forward-path hook.
	ensureRLJump("INPUT")
	if iptHasDockerUserChain() {
		ensureRLJump("DOCKER-USER")
	} else {
		ensureRLJump("FORWARD")
	}

	// Rebuild the chain declaratively.
	exec.Command("iptables", "-F", iptRLChain).Run()

	// Drop anything currently rate-limit-banned (first packet after escalation
	// adds the IP; subsequent packets are dropped here).
	if hasIpset {
		exec.Command("iptables", "-A", iptRLChain, "-m", "set", "--match-set", iptRLBanSet, "src", "-j", "DROP").Run()
	}

	for i, r := range rules {
		if r.MaxValue < 1 || (r.Type != "connection" && r.Type != "rate") {
			continue
		}
		for _, args := range iptRateRuleArgs(i, r, hasIpset) {
			exec.Command("iptables", args...).Run()
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

// ── Windows Firewall (single rule with comma-separated IPs) ─────────────────
//
// Strategy: two rules total — "Obliguard-Block-in" and "Obliguard-Block-out".
// Each rule's remoteip field is a comma-separated list of all banned IPs.
// Ban = add IP to the list. Unban = remove IP from the list.
// Result: 2 rules total regardless of IP count.

const winRuleIn = "Obliguard-Block-in"
const winRuleOut = "Obliguard-Block-out"
const winRulePrefix = "Obliguard-Block-" // kept for legacy cleanup

type WindowsFirewall struct {
	cache         map[string]bool
	dirty         bool
	loaded        bool
	legacyCleaned bool
	// Track which chunks are currently applied (hash per chunk index)
	appliedChunks map[int]string
}

func (f *WindowsFirewall) Name() string { return "windows" }

func (f *WindowsFirewall) IsAvailable() bool {
	_, err := exec.LookPath("netsh")
	return err == nil
}

// banlistPath returns the path to the persistent IP list file next to the agent binary.
func (f *WindowsFirewall) banlistPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "obliguard-banlist.txt")
}

// loadCache reads the banlist file into memory, then imports any legacy per-IP rules.
func (f *WindowsFirewall) loadCache() {
	if f.loaded {
		return
	}
	f.loaded = true
	f.cache = make(map[string]bool)

	// 1. Read from banlist file (source of truth)
	data, err := os.ReadFile(f.banlistPath())
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			ip := strings.TrimSpace(line)
			if ip != "" && ipPattern().MatchString(ip) {
				f.cache[ip] = true
			}
		}
	}

	// 2. Also import any legacy per-IP rules still in the firewall
	legacyIPs := f.getLegacyIPs()
	if len(legacyIPs) > 0 {
		log.Printf("Firewall: importing %d legacy per-IP rules", len(legacyIPs))
		for _, ip := range legacyIPs {
			f.cache[ip] = true
		}
		f.dirty = true
	}

	if len(f.cache) > 0 {
		log.Printf("Firewall: loaded %d banned IPs", len(f.cache))
	}
}

func (f *WindowsFirewall) BanIP(ip string) error {
	f.loadCache()
	if f.cache[ip] {
		return nil
	}
	f.cache[ip] = true
	f.dirty = true
	return nil
}

func (f *WindowsFirewall) UnbanIP(ip string) error {
	f.loadCache()
	if !f.cache[ip] {
		return nil
	}
	delete(f.cache, ip)
	f.dirty = true
	return nil
}

// Flush writes all pending changes to both the banlist file AND the Windows Firewall.
func (f *WindowsFirewall) Flush() error {
	if !f.dirty {
		return nil
	}
	f.dirty = false

	// Build sorted IP list for deterministic chunking
	ips := make([]string, 0, len(f.cache))
	for ip := range f.cache {
		ips = append(ips, ip)
	}
	sort.Strings(ips)

	// 1. Persist to file (source of truth — survives crashes)
	f.saveBanlist(ips)

	// 2. Apply to Windows Firewall
	if len(ips) == 0 {
		f.deleteGroupedRules()
	} else {
		f.syncRules(ips)
	}

	// 3. Clean up legacy per-IP rules on first flush only
	if !f.legacyCleaned {
		f.legacyCleaned = true
		f.cleanupLegacyRules()
	}
	return nil
}

func (f *WindowsFirewall) GetBannedIPs() ([]string, error) {
	f.loadCache()
	var ips []string
	for ip := range f.cache {
		ips = append(ips, ip)
	}
	return ips, nil
}

func (f *WindowsFirewall) saveBanlist(ips []string) {
	data := strings.Join(ips, "\n") + "\n"
	if err := os.WriteFile(f.banlistPath(), []byte(data), 0644); err != nil {
		log.Printf("Firewall: failed to save banlist: %v", err)
	}
}

// maxIPsPerRule — conservative limit for Windows Firewall reliability.
// netsh can fail silently with large remoteip lists; 500 is safe.
const maxIPsPerRule = 500

func (f *WindowsFirewall) syncRules(ips []string) error {
	if f.appliedChunks == nil {
		f.appliedChunks = make(map[int]string)
	}

	chunks := chunkStrings(ips, maxIPsPerRule)
	updated := 0

	for i, chunk := range chunks {
		ipList := strings.Join(chunk, ",")
		if f.appliedChunks[i] == ipList {
			continue
		}

		suffix := ""
		if len(chunks) > 1 {
			suffix = fmt.Sprintf("-%d", i+1)
		}
		nameIn := winRuleIn + suffix
		nameOut := winRuleOut + suffix

		exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+nameIn).Run()
		exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+nameOut).Run()

		if out, err := exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
			"name="+nameIn, "dir=in", "action=block",
			"remoteip="+ipList, "enable=yes",
			"description=Obliguard blocked IPs",
		).CombinedOutput(); err != nil {
			log.Printf("Firewall: rule %s FAILED: %v — %s", nameIn, err, strings.TrimSpace(string(out)))
		}
		if out, err := exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
			"name="+nameOut, "dir=out", "action=block",
			"remoteip="+ipList, "enable=yes",
			"description=Obliguard blocked IPs",
		).CombinedOutput(); err != nil {
			log.Printf("Firewall: rule %s FAILED: %v — %s", nameOut, err, strings.TrimSpace(string(out)))
		}

		f.appliedChunks[i] = ipList
		updated++
	}

	// Delete any extra chunks from previous syncs (if IP count decreased)
	for i := len(chunks); i < len(chunks)+50; i++ {
		key := i
		if _, ok := f.appliedChunks[key]; !ok {
			break // no more old chunks
		}
		suffix := fmt.Sprintf("-%d", i+1)
		exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleIn+suffix).Run()
		exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleOut+suffix).Run()
		delete(f.appliedChunks, key)
		updated++
	}
	// Clean base name (no suffix) if we use numbered chunks
	if len(chunks) > 1 {
		exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleIn).Run()
		exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+winRuleOut).Run()
	}

	if updated > 0 {
		log.Printf("Firewall: synced %d IPs (%d chunks, %d updated)", len(ips), len(chunks), updated)
	}
	return nil
}

// deleteGroupedRules removes all Obliguard-Block-in/out rules by exact name.
// It walks the numbered chunks (-1, -2, …) until several consecutive names are
// absent, so it scales to ANY chunk count — 34920 IPs at 500/rule = 70 chunks,
// which the old fixed -1..-50 limit left half-cleaned. Deletion is by known
// name only (no `netsh show rule` parse — that call is slow/unreliable on a
// huge ruleset and is exactly what made the WFP migration skip cleanup).
func (f *WindowsFirewall) deleteGroupedRules() {
	// netsh exits 0 when it removed ≥1 rule, non-zero ("No rules match") when
	// nothing matched → err==nil means a rule with that name was deleted.
	del := func(name string) bool {
		return exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+name).Run() == nil
	}
	del(winRuleIn)  // base names (single-chunk case)
	del(winRuleOut)
	misses := 0
	for i := 1; misses < 8 && i <= 100000; i++ {
		suffix := fmt.Sprintf("-%d", i)
		hit := del(winRuleIn + suffix)
		if del(winRuleOut+suffix) {
			hit = true
		}
		if hit {
			misses = 0
		} else {
			misses++
		}
	}
}

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

func (f *WindowsFirewall) cleanupLegacyRules() {
	out, _ := exec.Command("netsh", "advfirewall", "firewall", "show", "rule", "name=all", "dir=in").Output()
	for _, line := range strings.Split(string(out), "\n") {
		idx := strings.Index(line, winRulePrefix)
		if idx < 0 {
			continue
		}
		raw := strings.TrimRight(line[idx:], " \r\n\t")
		if raw == winRuleIn || raw == winRuleOut {
			continue
		}
		exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+raw).Run()
	}
}

// getLegacyIPs reads IPs from old-style per-IP rules (Obliguard-Block-A-B-C-D-*).
func (f *WindowsFirewall) getLegacyIPs() []string {
	out, err := exec.Command("netsh", "advfirewall", "firewall", "show", "rule",
		"name=all", "dir=in").Output()
	if err != nil {
		return nil
	}
	seen := make(map[string]bool)
	var ips []string
	ipRe := ipPattern()
	for _, line := range strings.Split(string(out), "\n") {
		idx := strings.Index(line, winRulePrefix)
		if idx < 0 {
			continue
		}
		raw := strings.TrimRight(line[idx:], " \r\n\t")
		if raw == winRuleIn || raw == winRuleOut {
			continue
		}
		raw = strings.TrimSuffix(raw, "-in")
		raw = strings.TrimSuffix(raw, "-out")
		ipDashes := strings.TrimPrefix(raw, winRulePrefix)
		ip := strings.ReplaceAll(ipDashes, "-", ".")
		if ipRe.MatchString(ip) && !seen[ip] {
			seen[ip] = true
			ips = append(ips, ip)
		}
	}
	return ips
}

// ── macOS pf ──────────────────────────────────────────────────────────────────

const pfAnchor = "obliguard"
const pfTable = "obliguard_blocklist"

type PFFirewall struct{ anchorFile string }

func (f *PFFirewall) Name() string { return "macos_pf" }

func (f *PFFirewall) IsAvailable() bool {
	_, err := exec.LookPath("pfctl")
	return err == nil
}

func (f *PFFirewall) BanIP(ip string) error {
	return exec.Command("pfctl", "-t", pfTable, "-T", "add", ip).Run()
}

func (f *PFFirewall) UnbanIP(ip string) error {
	return exec.Command("pfctl", "-t", pfTable, "-T", "delete", ip).Run()
}

func (f *PFFirewall) Flush() error { return nil }

func (f *PFFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("pfctl", "-t", pfTable, "-T", "show").Output()
	if err != nil {
		return nil, nil
	}
	var ips []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			ips = append(ips, line)
		}
	}
	return ips, nil
}

// ── FreeBSD pf (table-based, OPNsense-friendly) ─────────────────────────────

const freebsdPFTable = "obliguard_blocklist"

type FreeBSDPFFirewall struct{}

func (f *FreeBSDPFFirewall) Name() string { return "freebsd_pf" }

func (f *FreeBSDPFFirewall) IsAvailable() bool {
	if _, err := exec.LookPath("pfctl"); err != nil {
		return false
	}
	out, err := exec.Command("pfctl", "-si").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "Status: Enabled")
}

func (f *FreeBSDPFFirewall) BanIP(ip string) error {
	f.ensureTable()
	return exec.Command("pfctl", "-t", freebsdPFTable, "-T", "add", ip).Run()
}

func (f *FreeBSDPFFirewall) UnbanIP(ip string) error {
	return exec.Command("pfctl", "-t", freebsdPFTable, "-T", "delete", ip).Run()
}

func (f *FreeBSDPFFirewall) Flush() error { return nil }

func (f *FreeBSDPFFirewall) GetBannedIPs() ([]string, error) {
	out, err := exec.Command("pfctl", "-t", freebsdPFTable, "-T", "show").Output()
	if err != nil {
		return nil, nil
	}
	var ips []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			ips = append(ips, line)
		}
	}
	return ips, nil
}

func (f *FreeBSDPFFirewall) ensureTable() {
	cmd := exec.Command("pfctl", "-a", "obliguard", "-t", freebsdPFTable, "-T", "show")
	if cmd.Run() == nil {
		return
	}
	if exec.Command("pfctl", "-t", freebsdPFTable, "-T", "show").Run() == nil {
		return
	}
	rules := fmt.Sprintf("table <%s> persist\nblock in quick from <%s>\nblock out quick to <%s>\n",
		freebsdPFTable, freebsdPFTable, freebsdPFTable)
	anchorCmd := exec.Command("pfctl", "-a", "obliguard", "-f", "-")
	anchorCmd.Stdin = strings.NewReader(rules)
	if err := anchorCmd.Run(); err != nil {
		log.Printf("Firewall: pf anchor init warning: %v", err)
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

// ── Rate limiting: remaining backends ────────────────────────────────────────
//
// nftables, iptables and ufw enforce connection/rate limits (ufw reuses the
// iptables path — see below). firewalld and pf (macOS/FreeBSD) are not wired yet:
//   - firewalld: rich-rules can't express per-source connlimit, and raw iptables
//     rules get flushed on `firewall-cmd --reload` — needs a firewalld-native or
//     nft-direct approach.
//   - pf: the macOS/FreeBSD pf integration would need a dedicated rate-limit
//     anchor (pf keep-state max-src-conn / dummynet) — a separate pass.

func (f *FirewalldFirewall) IsRateLimitSupported() bool              { return false }
func (f *FirewalldFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }

// UFW sits on iptables and already injects raw iptables rules for its bans, so
// rate limiting reuses the shared iptables path (connection/rate; volume needs tc).
func (f *UFWFirewall) IsRateLimitSupported() bool { return true }
func (f *UFWFirewall) ApplyRateLimits(rules []RateLimitRule) error {
	return applyIptablesRateLimits(rules)
}

// WindowsFirewall rate limiting lives in firewall_ratelimit_windows.go (real,
// WinDivert-based) and firewall_ratelimit_other.go (no-op on non-Windows).

func (f *PFFirewall) IsRateLimitSupported() bool              { return false }
func (f *PFFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }

func (f *FreeBSDPFFirewall) IsRateLimitSupported() bool              { return false }
func (f *FreeBSDPFFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }

func (f *NoOpFirewall) IsRateLimitSupported() bool              { return false }
func (f *NoOpFirewall) ApplyRateLimits(_ []RateLimitRule) error { return nil }

// ── Shared helper ─────────────────────────────────────────────────────────────

func ipPattern() *regexp.Regexp {
	return regexp.MustCompile(`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`)
}
