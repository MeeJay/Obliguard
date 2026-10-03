package main

import (
	"fmt"
	"runtime"
	"strings"
)

// ── Firewall cleanup (uninstall) ──────────────────────────────────────────────
//
// cleanupFirewall removes every firewall object the agent creates, on every
// backend present on the host — not only the one detected now: the backend
// may have changed over the agent's life (nftables installed later, ufw
// enabled, WFP replacing netsh). It never builds a FirewallManager: a live
// backend would re-apply bans (the WFP reconcile loop re-adds the banlist).
//
// Entry points:
//   - `obliguard-agent cleanup-firewall [--purge]` (uninstall.go), run by the
//     MSI uninstall custom action (installer/product.wxs) and by the remote
//     uninstall scripts once the service is stopped;
//   - linuxFirewallCleanupShell: the same teardown as shell lines, the script
//     fallback when the binary cannot run.
//
// Windows: WFP filters/sublayer/provider, the netsh Obliguard-Block-N rules
// (grouped and legacy per-IP) and obliguard-banlist.txt
// (firewall_cleanup_windows.go). macOS / FreeBSD: pfUninstall (anchor rules
// and table, pf.conf lines, anchor file, OPNsense plugin, macOS boot job).
// Linux: nftables table, iptables chains and jumps, ipsets, firewalld ipsets
// and rich rules. ufw's per-IP fallback rules (hosts without ipset) are left
// alone: they cannot be told apart from the administrator's own deny rules.

// cleanupFirewall runs the teardown for the current OS. logf receives one
// line per object removed.
func cleanupFirewall(logf func(format string, args ...any)) {
	switch runtime.GOOS {
	case "windows":
		cleanupWindowsFirewall(logf)
	case "darwin", "freebsd":
		pfUninstall(pfDetectPlatform(runtime.GOOS), logf)
	default:
		cleanupLinuxFirewall(logf)
	}
}

// fwCleanupStep is one teardown command. repeat runs it until it fails, to
// remove a rule inserted more than once (iptables -D removes one copy).
type fwCleanupStep struct {
	args   []string
	repeat bool
}

// fwCleanupRepeatMax bounds a repeated step.
const fwCleanupRepeatMax = 32

// fwdCleanupSets are the firewalld ipsets the agent creates (firewall_firewalld.go).
var fwdCleanupSets = []string{fwdSetName, fwdNetSetName}

// firewalldCleanupSteps removes the drop rich-rules bound to the agent's
// ipsets, then the ipsets (permanent config; one reload follows).
func firewalldCleanupSteps() []fwCleanupStep {
	var steps []fwCleanupStep
	for _, set := range fwdCleanupSets {
		steps = append(steps,
			fwCleanupStep{args: []string{"firewall-cmd", "--permanent", "--remove-rich-rule=rule family=ipv4 source ipset=" + set + " drop"}},
			fwCleanupStep{args: []string{"firewall-cmd", "--permanent", "--remove-rich-rule=rule family=ipv4 destination ipset=" + set + " drop"}},
			fwCleanupStep{args: []string{"firewall-cmd", "--permanent", "--delete-ipset=" + set}},
		)
	}
	return steps
}

// nftCleanupSteps deletes the agent's table: ban sets, ban chains and the
// rate-limit chains/sets all live in `inet obliguard`.
func nftCleanupSteps() []fwCleanupStep {
	return []fwCleanupStep{{args: []string{"nft", "delete", "table", "inet", nftTable}}}
}

// iptablesCleanupSteps unhooks and deletes the iptables chains (ban and rate
// limit), and the set-match rules the ufw backend inserts in INPUT/OUTPUT
// (also for the temporary "<set>_mig" set of an interrupted migration).
func iptablesCleanupSteps() []fwCleanupStep {
	var steps []fwCleanupStep
	del := func(args ...string) {
		steps = append(steps, fwCleanupStep{args: append([]string{"iptables", "-D"}, args...), repeat: true})
	}
	del("INPUT", "-j", iptChain)
	del("OUTPUT", "-j", iptChainOut)
	for _, parent := range []string{"INPUT", "FORWARD", "DOCKER-USER"} {
		del(parent, "-j", iptRLChain)
	}
	for _, set := range []string{ufwSetName, ufwSetName + "_mig"} {
		del("INPUT", "-m", "set", "--match-set", set, "src", "-j", "DROP")
		del("OUTPUT", "-m", "set", "--match-set", set, "dst", "-j", "DROP")
	}
	for _, chain := range []string{iptChain, iptChainOut, iptRLChain} {
		steps = append(steps,
			fwCleanupStep{args: []string{"iptables", "-F", chain}},
			fwCleanupStep{args: []string{"iptables", "-X", chain}},
		)
	}
	return steps
}

// ipsetCleanupSteps destroys the kernel ipsets (after the rules using them).
func ipsetCleanupSteps() []fwCleanupStep {
	var steps []fwCleanupStep
	for _, set := range []string{iptSetName, iptSetName + "_mig", iptRLBanSet} {
		steps = append(steps, fwCleanupStep{args: []string{"ipset", "destroy", set}})
	}
	return steps
}

// firewalldHasAgentSets reports whether firewalld's permanent config holds one
// of the agent's ipsets. The cleanup (and its reload) only runs then: a
// reload drops other tools' runtime-only rules.
func firewalldHasAgentSets() bool {
	out, err := fwOutput("firewall-cmd", "--permanent", "--get-ipsets")
	if err != nil {
		return false
	}
	for _, set := range fwdCleanupSets {
		if fwdHasToken(out, set) {
			return true
		}
	}
	return false
}

// runCleanupSteps runs steps, logging those that removed something.
func runCleanupSteps(steps []fwCleanupStep, logf func(format string, args ...any)) {
	for _, st := range steps {
		n := 1
		if st.repeat {
			n = fwCleanupRepeatMax
		}
		for i := 0; i < n; i++ {
			if fwRun(st.args[0], st.args[1:]...) != nil {
				break
			}
			logf("Removed: %s", strings.Join(st.args, " "))
		}
	}
}

// cleanupLinuxFirewall tears down every Linux backend whose tool is present.
// Order: firewalld (owns ipsets of its own), nftables, iptables rules, then
// the ipsets those rules referenced.
func cleanupLinuxFirewall(logf func(format string, args ...any)) {
	if fwHave("firewall-cmd") && firewalldHasAgentSets() {
		runCleanupSteps(firewalldCleanupSteps(), logf)
		if err := fwRun("firewall-cmd", "--reload"); err != nil {
			logf("Warning: firewall-cmd --reload: %v", err)
		}
	}
	if fwHave("nft") {
		runCleanupSteps(nftCleanupSteps(), logf)
	}
	if fwHave("iptables") {
		runCleanupSteps(iptablesCleanupSteps(), logf)
	}
	if fwHave("ipset") {
		runCleanupSteps(ipsetCleanupSteps(), logf)
	}
}

// linuxFirewallCleanupShell returns cleanupLinuxFirewall as POSIX shell lines
// (every command best effort), for the uninstall script when the agent binary
// cannot run.
func linuxFirewallCleanupShell() string {
	var b strings.Builder
	line := func(st fwCleanupStep) {
		cmd := shellJoin(st.args) + " >/dev/null 2>&1"
		if st.repeat {
			fmt.Fprintf(&b, "i=0; while [ $i -lt %d ] && %s; do i=$((i+1)); done\n", fwCleanupRepeatMax, cmd)
		} else {
			b.WriteString(cmd + " || true\n")
		}
	}
	// firewalld: only when it holds one of the agent's ipsets (see firewalldHasAgentSets).
	b.WriteString("if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --permanent --get-ipsets 2>/dev/null | tr ' ' '\\n' | grep -qx -e " +
		shellQuote(fwdSetName) + " -e " + shellQuote(fwdNetSetName) + "; then\n")
	for _, st := range firewalldCleanupSteps() {
		line(st)
	}
	b.WriteString("firewall-cmd --reload >/dev/null 2>&1 || true\nfi\n")
	for _, st := range nftCleanupSteps() {
		line(st)
	}
	for _, st := range iptablesCleanupSteps() {
		line(st)
	}
	for _, st := range ipsetCleanupSteps() {
		line(st)
	}
	return b.String()
}

// shellQuote quotes s for POSIX sh.
func shellQuote(s string) string {
	if s != "" && strings.Trim(s, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./=:") == "" {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// shellJoin quotes and joins a command line.
func shellJoin(args []string) string {
	q := make([]string, len(args))
	for i, a := range args {
		q[i] = shellQuote(a)
	}
	return strings.Join(q, " ")
}
