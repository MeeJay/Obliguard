package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// handleUninstallCommand is called when the server delivers an 'uninstall' command
// in a push response. It writes a detached OS-appropriate uninstall script and
// exits immediately, allowing the script to outlive the agent process.
//
// The script approach is used on all platforms so the cleanup commands run after
// the agent process (and its service supervisor) have fully stopped.
func handleUninstallCommand(cfg *Config) {
	log.Printf("Uninstall command received — initiating self-removal...")

	var err error
	switch runtime.GOOS {
	case "windows":
		err = handleWindowsUninstall(cfg)
	case "linux":
		err = handleLinuxUninstall()
	case "darwin":
		err = handleDarwinUninstall()
	case "freebsd":
		err = handleFreeBSDUninstall()
	default:
		log.Printf("Uninstall: unsupported platform %q — ignoring command", runtime.GOOS)
		return
	}

	if err != nil {
		log.Printf("Uninstall: failed to launch uninstall script: %v", err)
		return
	}

	log.Printf("Uninstall: script launched, shutting down agent...")
	os.Exit(0)
}

// ── Windows ───────────────────────────────────────────────────────────────────

// handleWindowsUninstall downloads the MSI and runs msiexec /x via a detached
// batch script. The MSI uninstall stops the service and removes all files.
func handleWindowsUninstall(cfg *Config) error {
	// Download the MSI to a temp path
	msiPath := filepath.Join(os.TempDir(), "obliguard-uninstall.msi")
	if err := downloadFile(cfg.ServerURL+"/api/agent/download/obliguard-agent.msi", msiPath); err != nil {
		return fmt.Errorf("download MSI: %w", err)
	}

	logPath := filepath.Join(os.TempDir(), "obliguard-uninstall.log")
	scriptPath := filepath.Join(os.TempDir(), "obliguard-uninstall.bat")

	script := fmt.Sprintf(
		"@echo off\r\n"+
			"timeout /t 2 /nobreak >nul\r\n"+
			"msiexec /x \"%s\" /quiet /norestart /l*v \"%s\"\r\n"+
			"del /q \"%s\"\r\n"+
			"del /q \"%%~f0\"\r\n",
		msiPath, logPath, msiPath)

	if err := os.WriteFile(scriptPath, []byte(script), 0644); err != nil {
		return fmt.Errorf("write uninstall batch: %w", err)
	}

	return exec.Command("cmd", "/c", scriptPath).Start()
}

// ── Linux ─────────────────────────────────────────────────────────────────────

// handleLinuxUninstall writes a shell script that stops and removes the
// obliguard-agent systemd (or init.d) service and its binary, then runs it
// detached so it survives the agent process exit.
func handleLinuxUninstall() error {
	scriptPath := "/tmp/obliguard-uninstall.sh"
	script := "#!/bin/sh\n" +
		"sleep 2\n" +
		// Stop and disable — works for both systemd and SysV init
		"systemctl stop obliguard-agent 2>/dev/null || service obliguard-agent stop 2>/dev/null || true\n" +
		"systemctl disable obliguard-agent 2>/dev/null || true\n" +
		// Remove service unit / init script
		"rm -f /etc/systemd/system/obliguard-agent.service /etc/init.d/obliguard-agent\n" +
		"systemctl daemon-reload 2>/dev/null || true\n" +
		// Remove binary and install directory (config at /etc/obliguard-agent/ is kept)
		"rm -rf /opt/obliguard-agent/\n" +
		// Self-delete
		"rm -f \"$0\"\n"

	if err := os.WriteFile(scriptPath, []byte(script), 0755); err != nil {
		return fmt.Errorf("write uninstall script: %w", err)
	}

	return exec.Command("sh", scriptPath).Start()
}

// ── macOS ─────────────────────────────────────────────────────────────────────

// handleDarwinUninstall writes a shell script that unloads the launchd daemon,
// removes the plist and the installed binary, then runs it detached.
// Config and logs at /etc/obliguard-agent/ and /var/log/obliguard-agent.log are
// preserved (same behaviour as `obliguard-agent uninstall`).
func handleDarwinUninstall() error {
	const plist = "/Library/LaunchDaemons/com.obliguard.agent.plist"
	const binary = "/usr/local/bin/obliguard-agent"

	scriptPath := "/tmp/obliguard-uninstall.sh"
	script := "#!/bin/sh\n" +
		"sleep 2\n" +
		// Unload the launchd daemon (prevents auto-restart)
		"launchctl unload " + plist + " 2>/dev/null || true\n" +
		"rm -f " + plist + "\n" +
		"rm -f " + binary + "\n" +
		// Self-delete
		"rm -f \"$0\"\n"

	if err := os.WriteFile(scriptPath, []byte(script), 0755); err != nil {
		return fmt.Errorf("write uninstall script: %w", err)
	}

	return exec.Command("sh", scriptPath).Start()
}

// ── FreeBSD ──────────────────────────────────────────────────────────────────

// handleFreeBSDUninstall writes a shell script that stops and removes the
// obliguard-agent rc.d service, its binary, and the rc.d script.
// Config at /etc/obliguard-agent/ is preserved.
func handleFreeBSDUninstall() error {
	scriptPath := "/tmp/obliguard-uninstall.sh"
	script := "#!/bin/sh\n" +
		"sleep 2\n" +
		"service obliguard_agent stop 2>/dev/null || true\n" +
		"sysrc -x obliguard_agent_enable 2>/dev/null || true\n" +
		// Flush pf table and anchor
		"pfctl -t obliguard_blocklist -T flush 2>/dev/null || true\n" +
		"pfctl -t obliguard_blocklist -T kill 2>/dev/null || true\n" +
		"pfctl -a obliguard -F all 2>/dev/null || true\n" +
		// Remove OPNsense hook files if present
		"rm -f /usr/local/opnsense/scripts/filter/obliguard_reload.sh\n" +
		"rm -f /usr/local/opnsense/service/conf/actions.d/actions_obliguard.conf\n" +
		"rm -f /usr/local/etc/pf.opnsense.d/obliguard.conf\n" +
		// Remove service files
		"rm -f /usr/local/etc/rc.d/obliguard_agent\n" +
		"rm -f /usr/local/bin/obliguard-agent\n" +
		"rm -f /var/run/obliguard_agent.pid\n" +
		// Self-delete
		"rm -f \"$0\"\n"

	if err := os.WriteFile(scriptPath, []byte(script), 0755); err != nil {
		return fmt.Errorf("write uninstall script: %w", err)
	}

	return exec.Command("sh", scriptPath).Start()
}

// ── Shared helper ─────────────────────────────────────────────────────────────

// downloadFile downloads url and writes it to destPath, creating the file if
// needed. Uses a 120-second timeout (same as the auto-update download).
func downloadFile(url, destPath string) error {
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = io.Copy(f, resp.Body)
	return err
}
