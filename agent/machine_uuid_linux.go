//go:build linux

package main

import (
	"fmt"
	"os"
	"strings"
)

// readMachineUUID returns the SMBIOS UUID of this Linux machine.
// Tries /sys/class/dmi/id/product_uuid first (requires root on some distros),
// then falls back to /etc/machine-id (world-readable, always present on
// systemd-based systems).
// Returns "" if no stable ID can be found.
func readMachineUUID() string {
	// Primary: SMBIOS product UUID (identical to what Windows reads via BIOS)
	if b, err := os.ReadFile("/sys/class/dmi/id/product_uuid"); err == nil {
		if uuid := normaliseUUID(strings.TrimSpace(string(b))); uuid != "" {
			return uuid
		}
	}

	// Fallback: systemd machine-id (32 hex chars, no dashes)
	// Format it as a standard UUID so both sides look the same.
	if b, err := os.ReadFile("/etc/machine-id"); err == nil {
		id := strings.TrimSpace(string(b))
		if len(id) == 32 {
			uuid := fmt.Sprintf("%s-%s-%s-%s-%s",
				id[0:8], id[8:12], id[12:16], id[16:20], id[20:32])
			if u := normaliseUUID(uuid); u != "" {
				return u
			}
		}
	}

	return ""
}
