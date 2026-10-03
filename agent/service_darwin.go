//go:build darwin

package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

const (
	launchdLabel   = "com.obliguard.agent"
	launchdPlist   = "/Library/LaunchDaemons/com.obliguard.agent.plist"
	installBinPath = "/usr/local/bin/obliguard-agent"
	logFile        = "/var/log/obliguard-agent.log"
)

// runAsService checks for "install" / "uninstall" positional arguments
// (after flag.Parse, these appear in flag.Args()).
func runAsService(urlFlag, keyFlag *string) bool {
	args := flag.Args()
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "install":
		installLaunchdService(*urlFlag, *keyFlag)
		return true
	case "uninstall":
		uninstallLaunchdService()
		return true
	case "pf-setup":
		// (Re)install the pf anchor hook: used by install-macos.sh and to
		// repair a pf.conf rewritten by a macOS upgrade.
		if err := pfSetupCLI(); err != nil {
			fmt.Fprintf(os.Stderr, "pf setup: %v\n", err)
			os.Exit(1)
		}
		return true
	case "pf-cleanup":
		// Remove the pf anchor hook (run by the remote uninstall script).
		pfCleanupCLI()
		return true
	}
	return false
}

// installLaunchdService:
//  1. Initialises the agent config (saves to /etc/obliguard-agent/config.json)
//  2. Copies the current binary to /usr/local/bin/obliguard-agent
//  3. Configures pf: anchor file /etc/pf.anchors/obliguard, anchor lines in
//     /etc/pf.conf (backup first), pf enabled now and at boot (launchd job)
//  4. Writes the launchd plist
//  5. Loads the daemon (launchctl load)
func installLaunchdService(urlArg, keyArg string) {
	if urlArg == "" || keyArg == "" {
		fmt.Fprintln(os.Stderr, "Usage: sudo obliguard-agent --url <URL> --key <KEY> install")
		os.Exit(1)
	}

	// ── 1. Save config ──────────────────────────────────────────────────────
	cfg := setupConfig(urlArg, keyArg)
	fmt.Printf("Config saved to %s\n", configFile)

	// ── 2. Copy binary ──────────────────────────────────────────────────────
	exePath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Cannot determine binary path: %v\n", err)
		os.Exit(1)
	}
	// Resolve symlinks so we copy the real binary
	exePath, _ = filepath.EvalSymlinks(exePath)

	if exePath != installBinPath {
		if err := copyFile(exePath, installBinPath, 0755); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to copy binary to %s: %v\n", installBinPath, err)
			fmt.Fprintln(os.Stderr, "Run with sudo or ensure /usr/local/bin is writable.")
			os.Exit(1)
		}
		fmt.Printf("Binary installed to %s\n", installBinPath)
	}

	// ── 3. Configure pf ─────────────────────────────────────────────────────
	// Without the anchor reference in /etc/pf.conf and pf enabled, bans land
	// in a table no rule evaluates. A failure is not fatal: the agent retries
	// at start and logs a warning while bans are not enforced.
	fmt.Println("Configuring pf (anchor \"obliguard\")…")
	if err := pfSetupCLI(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: pf setup: %v\n", err)
		fmt.Fprintln(os.Stderr, "Bans will not be enforced until this is fixed (then run: sudo obliguard-agent pf-setup).")
	}

	// ── 4. Write plist ──────────────────────────────────────────────────────
	plistContent := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>

    <key>ProgramArguments</key>
    <array>
        <string>%s</string>
    </array>

    <!-- Restart automatically if it crashes -->
    <key>KeepAlive</key>
    <true/>

    <!-- Start on boot -->
    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>%s</string>
    <key>StandardErrorPath</key>
    <string>%s</string>

    <!-- Lower priority so it doesn't interfere with the user's work -->
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`, launchdLabel, installBinPath, logFile, logFile)

	if err := os.WriteFile(launchdPlist, []byte(plistContent), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write plist to %s: %v\n", launchdPlist, err)
		os.Exit(1)
	}
	fmt.Printf("Plist written to %s\n", launchdPlist)

	// ── 5. Load daemon ──────────────────────────────────────────────────────
	// Unload first in case an old version is running
	_ = exec.Command("launchctl", "unload", launchdPlist).Run()

	if err := exec.Command("launchctl", "load", launchdPlist).Run(); err != nil {
		fmt.Fprintf(os.Stderr, "launchctl load failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("\n✓ Obliguard Agent installed and running (label: %s)\n", launchdLabel)
	fmt.Printf("  Logs: %s\n", logFile)
	fmt.Println("  To stop:      sudo launchctl unload " + launchdPlist)
	fmt.Println("  To uninstall: sudo obliguard-agent uninstall")
	_ = cfg // config already saved
}

// uninstallLaunchdService stops and removes the launchd daemon and the pf
// configuration (anchor, pf.conf lines, boot job).
func uninstallLaunchdService() {
	fmt.Println("Unloading launchd daemon…")
	if err := exec.Command("launchctl", "unload", launchdPlist).Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: launchctl unload: %v\n", err)
	}

	fmt.Println("Removing pf configuration…")
	pfCleanupCLI()

	for _, path := range []string{launchdPlist, installBinPath} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "Warning: could not remove %s: %v\n", path, err)
		} else if err == nil {
			fmt.Printf("Removed %s\n", path)
		}
	}

	fmt.Println("\n✓ Obliguard Agent uninstalled.")
	fmt.Println("  Config and logs were kept. Remove manually if needed:")
	fmt.Printf("    sudo rm -rf %s %s\n", configDir, logFile)
}

// copyFile copies src to dst with the given permission bits.
func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}
