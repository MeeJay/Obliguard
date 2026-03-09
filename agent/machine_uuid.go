package main

import (
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/google/uuid"
)

// agentNamespaceUUID is the fixed namespace used to derive machine UUIDs for
// all Obliguard / Obliview agents (UUID v5 — deterministic, SHA-1 based).
//
// IMPORTANT: both Obliguard and Obliview MUST use this exact value so that
// the same physical machine always receives the same agent UUID regardless of
// which product is installed.  This enables the cross-platform API to
// correlate agents across deployments.
//
// Never change this constant after agents have been deployed.
var agentNamespaceUUID = uuid.MustParse("f7a9d3c2-1e58-4b0a-9f6e-3d8c2a5b7e91")

// getMachineUUID returns a deterministic UUID v5 derived from the machine's
// SMBIOS product UUID (or the closest equivalent on each OS).
//
// Returns "" when no stable hardware identifier is available — the caller
// should fall back to generateUUID() and persist the result in config.json.
func getMachineUUID() string {
	raw := getRawHardwareID()
	if raw == "" {
		return ""
	}
	// Derive v5 UUID: SHA-1(namespace || "obliguard-agent:" || hardware_id).
	// The fixed prefix keeps the derivation scoped to agent identity even if
	// the same hardware ID source is used for something else.
	derived := uuid.NewSHA1(agentNamespaceUUID, []byte("obliguard-agent:"+raw))
	return derived.String()
}

// getRawHardwareID returns a platform-specific stable hardware identifier.
func getRawHardwareID() string {
	switch runtime.GOOS {
	case "windows":
		return getWindowsProductUUID()
	case "linux":
		return getLinuxMachineID()
	case "darwin":
		return getMacOSPlatformUUID()
	default:
		return ""
	}
}

// getWindowsProductUUID reads the SMBIOS product UUID on Windows.
//
// Uses PowerShell / CIM (modern, works on Windows 10+) with a wmic fallback
// for older systems.  wmic is deprecated in Windows 11 24H2+ so PowerShell
// is tried first.
func getWindowsProductUUID() string {
	// PowerShell — preferred
	out, err := exec.Command(
		"powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID",
	).Output()
	if err == nil {
		if v := strings.TrimSpace(string(out)); isValidHardwareID(v) {
			return v
		}
	}

	// wmic — fallback for older Windows / environments without PowerShell
	out, err = exec.Command("wmic", "csproduct", "get", "uuid", "/value").Output()
	if err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			upper := strings.ToUpper(strings.TrimSpace(line))
			if strings.HasPrefix(upper, "UUID=") {
				if v := strings.TrimSpace(line[5:]); isValidHardwareID(v) {
					return v
				}
			}
		}
	}

	return ""
}

// getLinuxMachineID reads the SMBIOS product UUID or falls back to machine-id.
//
// Priority:
//  1. /sys/class/dmi/id/product_uuid — SMBIOS, survives OS reinstalls
//  2. /etc/machine-id               — generated on first boot; may change on
//     full reinstall but is far more stable than a random UUID
//  3. /var/lib/dbus/machine-id      — symlink or copy of /etc/machine-id
func getLinuxMachineID() string {
	for _, path := range []string{
		"/sys/class/dmi/id/product_uuid",
		"/sys/devices/virtual/dmi/id/product_uuid",
	} {
		if data, err := os.ReadFile(path); err == nil {
			if v := strings.TrimSpace(string(data)); isValidHardwareID(v) {
				return v
			}
		}
	}
	for _, path := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if data, err := os.ReadFile(path); err == nil {
			if v := strings.TrimSpace(string(data)); len(v) >= 16 {
				return v
			}
		}
	}
	return ""
}

// getMacOSPlatformUUID reads IOPlatformUUID from the macOS I/O registry.
func getMacOSPlatformUUID() string {
	out, err := exec.Command("ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "IOPlatformUUID") {
			continue
		}
		// Line format: | "IOPlatformUUID" = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
		parts := strings.Split(line, `"`)
		for i, p := range parts {
			if p == "IOPlatformUUID" && i+2 < len(parts) {
				if v := strings.TrimSpace(parts[i+2]); isValidHardwareID(v) {
					return v
				}
			}
		}
	}
	return ""
}

// isValidHardwareID returns true when v looks like a real hardware UUID —
// i.e. not the all-zeros, all-Fs, or placeholder strings that some VMs or
// bare-metal boards emit when they have no SMBIOS UUID programmed.
func isValidHardwareID(v string) bool {
	if len(v) < 16 {
		return false
	}
	clean := strings.ToUpper(strings.ReplaceAll(v, "-", ""))
	switch {
	case strings.TrimRight(clean, "0") == "":
		return false // all zeros
	case strings.TrimRight(clean, "F") == "":
		return false // all Fs (FFFFFFFFFFFF…)
	case strings.EqualFold(v, "None"):
		return false
	case strings.EqualFold(v, "Default string"):
		return false
	case strings.EqualFold(v, "Not Specified"):
		return false
	}
	return true
}
