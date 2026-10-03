//go:build windows

package main

import (
	"errors"
	"os"
	"syscall"

	"github.com/tailscale/wf"
)

// cleanupWindowsFirewall removes the WFP objects (every filter of the
// Obliguard provider or sublayer, then the sublayer and the provider), the
// netsh rules of the fallback backend (grouped Obliguard-Block-in/out-N and
// legacy per-IP rules) and the shared banlist file next to the binary. See
// firewall_cleanup.go.
func cleanupWindowsFirewall(logf func(format string, args ...any)) {
	cleanupWFP(logf)

	nf := &WindowsFirewall{}
	if nf.IsAvailable() {
		nf.deleteGroupedRules()
		nf.cleanupLegacyRules()
		logf("netsh Obliguard-Block rules removed")
	}

	if err := os.Remove(wfpBanlistPath()); err == nil {
		logf("Removed %s", wfpBanlistPath())
	} else if !os.IsNotExist(err) {
		logf("Warning: cannot remove %s: %v", wfpBanlistPath(), err)
	}
}

// cleanupWFP deletes the persistent WFP objects from a dynamic session (the
// objects deleted are persistent ones; the session itself leaves nothing).
func cleanupWFP(logf func(format string, args ...any)) {
	sess, err := wf.New(&wf.Options{
		Name:        "Obliguard cleanup",
		Description: "Obliguard agent uninstall",
		Dynamic:     true,
	})
	if err != nil {
		logf("Warning: WFP session: %v", err)
		return
	}
	defer sess.Close()

	rules, err := sess.Rules()
	if err != nil {
		logf("Warning: WFP enumerate: %v", err)
	}
	removed, failed := 0, 0
	for _, r := range rules {
		if r.Provider != obliProviderID && r.Sublayer != obliSublayerID {
			continue
		}
		if err := sess.DeleteRule(r.ID); err != nil && !isNotFound(err) {
			failed++
			continue
		}
		removed++
	}
	if removed > 0 || failed > 0 {
		logf("WFP: %d filter(s) removed, %d failed", removed, failed)
	}
	if err := sess.DeleteSublayer(obliSublayerID); err != nil && !wfpObjectGone(err) {
		logf("Warning: WFP sublayer: %v", err)
	}
	if err := sess.DeleteProvider(obliProviderID); err != nil && !wfpObjectGone(err) {
		logf("Warning: WFP provider: %v", err)
	}
}

// FWP_E_PROVIDER_NOT_FOUND / FWP_E_SUBLAYER_NOT_FOUND: nothing to delete (the
// netsh backend never created them).
const (
	fwpErrProviderNotFound = 0x80320005
	fwpErrSublayerNotFound = 0x80320007
)

func wfpObjectGone(err error) bool {
	return isNotFound(err) ||
		errors.Is(err, syscall.Errno(fwpErrProviderNotFound)) ||
		errors.Is(err, syscall.Errno(fwpErrSublayerNotFound))
}
