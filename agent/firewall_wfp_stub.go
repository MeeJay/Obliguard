//go:build !windows

package main

import "errors"

// newWFPFirewall is Windows-only. This stub lets the tagless DetectFirewall in
// firewall.go compile on Linux/macOS/FreeBSD cross-builds.
func newWFPFirewall() (FirewallManager, error) {
	return nil, errors.New("wfp: windows only")
}
