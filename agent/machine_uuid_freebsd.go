//go:build freebsd

package main

import (
	"os/exec"
	"strings"
)

// readMachineUUID returns a stable UUID for this FreeBSD machine using
// kern.hostuuid (set at install time, persists across reboots).
func readMachineUUID() string {
	out, err := exec.Command("sysctl", "-n", "kern.hostuuid").Output()
	if err != nil {
		return ""
	}
	return normaliseUUID(strings.TrimSpace(string(out)))
}
