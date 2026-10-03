package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// ── cleanup-firewall subcommand ───────────────────────────────────────────────

// cleanupFirewallArg is the subcommand removing the agent's firewall objects
// (firewall_cleanup.go). `--purge` also removes the agent data (config.json,
// update directory, logs). Run by the MSI uninstall custom action
// (installer/product.wxs) and by the uninstall scripts below, always after the
// service is stopped so nothing re-applies a ban behind it.
const (
	cleanupFirewallArg = "cleanup-firewall"
	cleanupPurgeArg    = "--purge"
)

// init dispatches the subcommand before main() parses flags or starts the
// service: on Windows the MSI runs the binary outside the SCM, which main()
// would treat as an interactive agent start. Go runs init() functions in file
// name order, so main.go's init (configDir) has already run here.
func init() {
	if len(os.Args) < 2 || os.Args[1] != cleanupFirewallArg {
		return
	}
	purge := false
	for _, a := range os.Args[2:] {
		if a == cleanupPurgeArg {
			purge = true
		}
	}
	runCleanupCLI(purge)
	os.Exit(0)
}

// runCleanupCLI removes the firewall objects and, with purge, the agent data.
// Best effort: it always completes and reports on stdout.
func runCleanupCLI(purge bool) {
	logf := func(format string, args ...any) { fmt.Printf(format+"\n", args...) }
	cleanupFirewall(logf)
	if purge {
		purgeAgentData(logf)
	}
}

// agentLogFiles are the log files written outside configDir (macOS launchd
// and FreeBSD daemon(8) redirect stdout there; Linux logs to the journal and
// Windows to configDir\agent.log).
func agentLogFiles() []string {
	switch runtime.GOOS {
	case "darwin", "freebsd":
		return []string{"/var/log/obliguard-agent.log"}
	}
	return nil
}

// purgeAgentData removes configDir (config.json, agent.log on Windows, the
// update directory) and the log files.
func purgeAgentData(logf func(format string, args ...any)) {
	// Never remove anything but the agent's own directory.
	if base := filepath.Base(configDir); base == "ObliguardAgent" || base == "obliguard-agent" {
		if err := os.RemoveAll(configDir); err != nil {
			logf("Warning: cannot remove %s: %v", configDir, err)
		} else {
			logf("Removed %s", configDir)
		}
	}
	for _, f := range agentLogFiles() {
		if err := os.Remove(f); err == nil {
			logf("Removed %s", f)
		}
	}
}

// ── Remote uninstall ──────────────────────────────────────────────────────────

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

// windowsInstallDirName is the MSI install directory name (INSTALLFOLDER in
// installer/product.wxs).
const windowsInstallDirName = "ObliguardAgent"

// productCodeRe matches an MSI ProductCode ("{8D56E26E-B218-...}").
var productCodeRe = regexp.MustCompile(`^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$`)

// handleWindowsUninstall runs, through a detached batch script, msiexec /x on
// the INSTALLED product (its ProductCode from the registry): uninstalling with
// a package downloaded from the server fails as soon as the server's MSI is a
// different version (another ProductCode). The MSI stops and removes the
// service, then its custom action runs `cleanup-firewall --purge`. Without an
// MSI registration, or when msiexec fails, the script removes the agent by
// hand. The script and the msiexec log are staged in the update directory
// (SYSTEM and Administrators only, see prepareUpdateDir).
func handleWindowsUninstall(_ *Config) error {
	dir, err := prepareUpdateDir()
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate agent binary: %w", err)
	}
	productCode := installedProductCode()
	if !productCodeRe.MatchString(productCode) {
		if productCode != "" {
			log.Printf("Uninstall: ignoring malformed ProductCode %q", productCode)
		}
		productCode = ""
		log.Printf("Uninstall: no MSI registration found — removing the agent directly")
	}

	scriptPath := filepath.Join(dir, "obliguard-uninstall.bat")
	script := buildWindowsUninstallScript(productCode, exe, filepath.Join(dir, "obliguard-uninstall.log"), configDir)
	if err := os.WriteFile(scriptPath, []byte(script), 0600); err != nil {
		return fmt.Errorf("write uninstall batch: %w", err)
	}
	return exec.Command("cmd", "/c", scriptPath).Start()
}

// buildWindowsUninstallScript returns the uninstall batch script:
//  1. stops the SCM recovery actions (the agent exits right after starting
//     the script, which the SCM would otherwise treat as a crash to restart);
//  2. msiexec /x {ProductCode} when the product is registered — the MSI
//     custom action removes the firewall objects and the agent data (this
//     script included, so nothing after msiexec runs on success);
//  3. otherwise, or if msiexec fails: stop the service, run cleanup-firewall,
//     delete the service, the install directory, the registry key and the
//     data directory (last: it holds this script).
//
// "ping" is used as the delay: "timeout" fails without a console (services).
func buildWindowsUninstallScript(productCode, exePath, logPath, dataDir string) string {
	lines := []string{
		"@echo off",
		"setlocal",
		`set "SVC=ObliguardAgent"`,
		`sc failure "%SVC%" reset= 0 actions= "" >nul 2>&1`,
		"ping -n 3 127.0.0.1 >nul",
	}
	if productCode != "" {
		lines = append(lines,
			`msiexec /x `+productCode+` /qn /norestart /l*v "`+batQuote(logPath)+`"`,
			`set "RC=%ERRORLEVEL%"`,
			`if "%RC%"=="0" goto done`,
			`if "%RC%"=="3010" goto done`,
			`if "%RC%"=="1641" goto done`,
		)
	}
	// The install directory is removed only when it is the MSI's
	// (...\ObliguardAgent); a binary run from anywhere else (a copy, a dev
	// build) removes only itself, never its whole directory.
	removeBinary := `del /f /q "` + batQuote(exePath) + `" >nul 2>&1`
	if strings.EqualFold(filepath.Base(filepath.Dir(exePath)), windowsInstallDirName) {
		removeBinary = `rd /s /q "` + batQuote(filepath.Dir(exePath)) + `" >nul 2>&1`
	}
	lines = append(lines,
		// Manual removal.
		`sc stop "%SVC%" >nul 2>&1`,
		"set /a WAITED=0",
		":waitstop",
		`sc query "%SVC%" | find "STOPPED" >nul`,
		"if not errorlevel 1 goto stopped",
		"if %WAITED% GEQ 60 goto stopped",
		"ping -n 3 127.0.0.1 >nul",
		"set /a WAITED+=2",
		"goto waitstop",
		":stopped",
		`"`+batQuote(exePath)+`" `+cleanupFirewallArg+` >nul 2>&1`,
		`sc delete "%SVC%" >nul 2>&1`,
		`reg delete "HKLM\SOFTWARE\ObliguardAgent" /f /reg:64 >nul 2>&1`,
		removeBinary,
		":done",
		`rd /s /q "`+batQuote(dataDir)+`" >nul 2>&1`,
	)
	return strings.Join(lines, "\r\n") + "\r\n"
}

// uninstallScriptPath returns the path of the detached unix uninstall script,
// in the root-only update directory (a fixed name in the world-writable /tmp
// could be a symlink planted by a local user).
func uninstallScriptPath() (string, error) {
	dir, err := prepareUpdateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "obliguard-uninstall.sh"), nil
}

// pfUninstallScript is the pf step of the macOS / FreeBSD uninstall scripts:
// the agent binary removes the anchor rules and table, its pf.conf lines, the
// anchor file, the OPNsense plugin or macOS boot job (`pf-cleanup` runs the
// same pfUninstall as cleanup-firewall on these platforms). If the binary
// cannot run, at least the anchor rules and tables go. Never `pfctl -F all`:
// it also flushes the state of every connection of the host.
func pfUninstallScript(binary string) string {
	return binary + " pf-cleanup >/dev/null 2>&1 || {\n" +
		"  pfctl -a " + pfAnchor + " -F rules 2>/dev/null\n" +
		"  pfctl -a " + pfAnchor + " -t " + pfTable + " -T kill 2>/dev/null\n" +
		"  pfctl -t " + pfTable + " -T flush 2>/dev/null\n" +
		"  true\n" +
		"}\n"
}

// unixPurgeScript removes the agent data: configDir (config.json and the
// update directory holding the running script — sh keeps it open) and logs.
func unixPurgeScript() string {
	s := "rm -rf " + shellQuote(configDir) + "\n"
	for _, f := range agentLogFiles() {
		s += "rm -f " + shellQuote(f) + "\n"
	}
	return s
}

// writeUninstallScript writes the script into the root-only update directory
// and returns its path.
func writeUninstallScript(script string) (string, error) {
	scriptPath, err := uninstallScriptPath()
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(scriptPath, []byte(script), 0700); err != nil {
		return "", fmt.Errorf("write uninstall script: %w", err)
	}
	return scriptPath, nil
}

// startViaSystemdRun runs the script in a transient systemd unit and reports
// whether it was started. The agent's unit (Restart=always,
// KillMode=control-group) kills every process of its cgroup when the agent
// exits, own process group or not.
func startViaSystemdRun(scriptPath string) bool {
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return false
	}
	path, err := exec.LookPath("systemd-run")
	if err != nil {
		return false
	}
	unit := "obliguard-agent-uninstall-" + strconv.FormatInt(time.Now().Unix(), 10)
	out, err := exec.Command(path, "--unit="+unit, "--quiet", "/bin/sh", scriptPath).CombinedOutput()
	if err != nil {
		log.Printf("Uninstall: systemd-run failed (%v: %s) — starting the script directly", err, strings.TrimSpace(string(out)))
		return false
	}
	return true
}

// ── Linux ─────────────────────────────────────────────────────────────────────

// buildLinuxUninstallScript stops and removes the obliguard-agent systemd (or
// init.d) service, removes every firewall object (the agent binary, or the
// same teardown in shell when it cannot run), the install directory and the
// agent data.
func buildLinuxUninstallScript() string {
	const binary = "/opt/obliguard-agent/obliguard-agent"
	return "#!/bin/sh\n" +
		"sleep 2\n" +
		// Stop and disable — works for both systemd and SysV init
		"systemctl stop obliguard-agent 2>/dev/null || service obliguard-agent stop 2>/dev/null || true\n" +
		"systemctl disable obliguard-agent 2>/dev/null || true\n" +
		// Remove service unit / init script
		"rm -f /etc/systemd/system/obliguard-agent.service /etc/init.d/obliguard-agent\n" +
		"systemctl daemon-reload 2>/dev/null || true\n" +
		// Firewall: ban sets and chains, rate-limit objects, firewalld ipsets
		"if ! " + binary + " " + cleanupFirewallArg + " >/dev/null 2>&1; then\n" +
		linuxFirewallCleanupShell() +
		"fi\n" +
		// Binary and install directory, then config and update directory
		"rm -rf /opt/obliguard-agent/\n" +
		unixPurgeScript() +
		// Self-delete
		"rm -f \"$0\"\n"
}

func handleLinuxUninstall() error {
	scriptPath, err := writeUninstallScript(buildLinuxUninstallScript())
	if err != nil {
		return err
	}
	if startViaSystemdRun(scriptPath) {
		return nil
	}
	cmd := exec.Command("sh", scriptPath)
	detachCmd(cmd) // own process group: not killed with the agent's service
	return cmd.Start()
}

// ── macOS ─────────────────────────────────────────────────────────────────────

// buildDarwinUninstallScript unloads the launchd daemon, removes the pf
// configuration (anchor, pf.conf lines, boot job), the plist, the installed
// binary, then the config and log.
func buildDarwinUninstallScript() string {
	const plist = "/Library/LaunchDaemons/com.obliguard.agent.plist"
	const binary = "/usr/local/bin/obliguard-agent"

	return "#!/bin/sh\n" +
		"sleep 2\n" +
		// Unload the launchd daemon (prevents auto-restart)
		"launchctl unload " + plist + " 2>/dev/null || true\n" +
		// pf: anchor, table, pf.conf lines, anchor file, boot job
		pfUninstallScript(binary) +
		"rm -f " + plist + "\n" +
		"rm -f " + binary + "\n" +
		unixPurgeScript() +
		// Self-delete
		"rm -f \"$0\"\n"
}

func handleDarwinUninstall() error {
	scriptPath, err := writeUninstallScript(buildDarwinUninstallScript())
	if err != nil {
		return err
	}
	cmd := exec.Command("sh", scriptPath)
	detachCmd(cmd) // own process group: not killed with the agent's service
	return cmd.Start()
}

// ── FreeBSD ──────────────────────────────────────────────────────────────────

// buildFreeBSDUninstallScript stops and removes the obliguard-agent rc.d
// service, the pf configuration (anchor, pf.conf lines or OPNsense plugin
// hook), its binary, the rc.d script, then the config and log.
func buildFreeBSDUninstallScript() string {
	const binary = "/usr/local/bin/obliguard-agent"

	return "#!/bin/sh\n" +
		"sleep 2\n" +
		"service obliguard_agent stop 2>/dev/null || true\n" +
		"sysrc -x obliguard_agent_enable 2>/dev/null || true\n" +
		// pf: anchor, table, pf.conf lines, OPNsense plugin (and reload)
		pfUninstallScript(binary) +
		// OPNsense hook files (plugin and older agents' hooks), in case
		// pf-cleanup could not run
		"rm -f " + pfOPNsensePlugin + "\n" +
		"rm -f /usr/local/opnsense/scripts/filter/obliguard_reload.sh\n" +
		"rm -f /usr/local/opnsense/service/conf/actions.d/actions_obliguard.conf\n" +
		"rm -f /usr/local/etc/pf.opnsense.d/obliguard.conf\n" +
		// Remove service files
		"rm -f /usr/local/etc/rc.d/obliguard_agent\n" +
		"rm -f " + binary + "\n" +
		"rm -f /var/run/obliguard_agent.pid\n" +
		unixPurgeScript() +
		// Self-delete
		"rm -f \"$0\"\n"
}

func handleFreeBSDUninstall() error {
	scriptPath, err := writeUninstallScript(buildFreeBSDUninstallScript())
	if err != nil {
		return err
	}
	cmd := exec.Command("sh", scriptPath)
	detachCmd(cmd) // own process group: not killed with the agent's service
	return cmd.Start()
}
