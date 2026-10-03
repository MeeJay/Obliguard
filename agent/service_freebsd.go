//go:build freebsd

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
	freebsdRCScript   = "/usr/local/etc/rc.d/obliguard_agent"
	freebsdInstallBin = "/usr/local/bin/obliguard-agent"
	freebsdLogFile    = "/var/log/obliguard-agent.log"
)

// runAsService checks for "install" / "uninstall" positional arguments.
func runAsService(urlFlag, keyFlag *string) bool {
	args := flag.Args()
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "install":
		installFreeBSDService(*urlFlag, *keyFlag)
		return true
	case "uninstall":
		uninstallFreeBSDService()
		return true
	case "pf-setup":
		// (Re)install the pf anchor hook: used by install-freebsd.sh.
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

// installFreeBSDService:
//  1. Saves the agent config
//  2. Copies the binary to /usr/local/bin/
//  3. Writes an rc.d script
//  4. Configures pf (anchor "obliguard": pf.conf lines on FreeBSD, plugin
//     hook on OPNsense)
//  5. Enables and starts the service
func installFreeBSDService(urlArg, keyArg string) {
	if urlArg == "" || keyArg == "" {
		fmt.Fprintln(os.Stderr, "Usage: sudo obliguard-agent --url <URL> --key <KEY> install")
		os.Exit(1)
	}

	// 1. Save config
	cfg := setupConfig(urlArg, keyArg)
	fmt.Printf("Config saved to %s\n", configFile)

	// 2. Copy binary
	exePath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Cannot determine binary path: %v\n", err)
		os.Exit(1)
	}
	exePath, _ = filepath.EvalSymlinks(exePath)

	if exePath != freebsdInstallBin {
		if err := freebsdCopyFile(exePath, freebsdInstallBin, 0755); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to copy binary to %s: %v\n", freebsdInstallBin, err)
			fmt.Fprintln(os.Stderr, "Run with sudo or ensure /usr/local/bin is writable.")
			os.Exit(1)
		}
		fmt.Printf("Binary installed to %s\n", freebsdInstallBin)
	}

	// 3. Write rc.d script
	rcScript := fmt.Sprintf(`#!/bin/sh

# PROVIDE: obliguard_agent
# REQUIRE: NETWORKING
# KEYWORD: shutdown

. /etc/rc.subr

name="obliguard_agent"
rcvar="obliguard_agent_enable"

command="%s"
command_args=">> %s 2>&1 &"

pidfile="/var/run/${name}.pid"

start_cmd="${name}_start"
stop_cmd="${name}_stop"
status_cmd="${name}_status"

obliguard_agent_start()
{
    echo "Starting ${name}."
    /usr/sbin/daemon -p ${pidfile} -o %s %s
}

obliguard_agent_stop()
{
    if [ -f ${pidfile} ]; then
        echo "Stopping ${name}."
        kill $(cat ${pidfile}) 2>/dev/null
        rm -f ${pidfile}
    else
        echo "${name} is not running."
    fi
}

obliguard_agent_status()
{
    if [ -f ${pidfile} ] && kill -0 $(cat ${pidfile}) 2>/dev/null; then
        echo "${name} is running as pid $(cat ${pidfile})."
    else
        echo "${name} is not running."
        return 1
    fi
}

load_rc_config $name
: ${obliguard_agent_enable:="NO"}
run_rc_command "$1"
`, freebsdInstallBin, freebsdLogFile, freebsdLogFile, freebsdInstallBin)

	if err := os.WriteFile(freebsdRCScript, []byte(rcScript), 0755); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write rc.d script to %s: %v\n", freebsdRCScript, err)
		os.Exit(1)
	}
	fmt.Printf("RC script written to %s\n", freebsdRCScript)

	// 4. Configure pf. A failure is not fatal: the agent retries at start and
	//    logs a warning while bans are not enforced.
	fmt.Println("Configuring pf (anchor \"obliguard\")…")
	if err := pfSetupCLI(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: pf setup: %v\n", err)
		fmt.Fprintln(os.Stderr, "Bans will not be enforced until this is fixed (then run: obliguard-agent pf-setup).")
	}

	// 5. Enable and start
	exec.Command("sysrc", "obliguard_agent_enable=YES").Run()

	if err := exec.Command("service", "obliguard_agent", "start").Run(); err != nil {
		fmt.Fprintf(os.Stderr, "service start failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("\n✓ Obliguard Agent installed and running (rc.d: %s)\n", freebsdRCScript)
	fmt.Printf("  Logs: %s\n", freebsdLogFile)
	fmt.Println("  To stop:      sudo service obliguard_agent stop")
	fmt.Println("  To uninstall: sudo obliguard-agent uninstall")
	_ = cfg
}

// uninstallFreeBSDService stops and removes the rc.d service.
func uninstallFreeBSDService() {
	fmt.Println("Stopping service…")
	exec.Command("service", "obliguard_agent", "stop").Run()

	// Disable in rc.conf
	exec.Command("sysrc", "-x", "obliguard_agent_enable").Run()

	// Remove the pf anchor, its hook and the legacy rules
	fmt.Println("Cleaning up pf rules…")
	pfCleanupCLI()

	for _, path := range []string{freebsdRCScript, freebsdInstallBin} {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "Warning: could not remove %s: %v\n", path, err)
		} else if err == nil {
			fmt.Printf("Removed %s\n", path)
		}
	}

	fmt.Println("\n✓ Obliguard Agent uninstalled.")
	fmt.Println("  Config and logs were kept. Remove manually if needed:")
	fmt.Printf("    sudo rm -rf %s %s\n", configDir, freebsdLogFile)
}

// ── file copy helper ─────────────────────────────────────────────────────────

func freebsdCopyFile(src, dst string, mode os.FileMode) error {
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
