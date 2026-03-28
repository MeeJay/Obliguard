//go:build freebsd

package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	freebsdRCScript    = "/usr/local/etc/rc.d/obliguard_agent"
	freebsdInstallBin  = "/usr/local/bin/obliguard-agent"
	freebsdLogFile     = "/var/log/obliguard-agent.log"
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
	}
	return false
}

// installFreeBSDService:
//  1. Saves the agent config
//  2. Copies the binary to /usr/local/bin/
//  3. Writes an rc.d script
//  4. Enables and starts the service
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

	// 4. Configure pf firewall rules
	configurePFRules()

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

	// Remove pf rules
	fmt.Println("Cleaning up pf rules…")
	cleanupPFRules()

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

// ── pf firewall configuration ────────────────────────────────────────────────

const (
	pfConfPath       = "/etc/pf.conf"
	pfAnchorConf     = "/usr/local/etc/pf.obliguard.conf"
	opnsenseFilterDir = "/usr/local/opnsense/service/conf/actions.d"
	opnsenseHookConf  = "/usr/local/opnsense/service/conf/actions.d/actions_obliguard.conf"
	opnsenseHookScript = "/usr/local/opnsense/scripts/filter/obliguard_reload.sh"
	pfMarker         = "obliguard_blocklist"
)

// pfAnchorRules is the minimal anchor ruleset for Obliguard.
const pfAnchorRules = `# Obliguard IPS — managed automatically, do not edit
table <obliguard_blocklist> persist
block in quick from <obliguard_blocklist>
block out quick to <obliguard_blocklist>
`

// isOPNsense returns true if running on OPNsense (pf.conf is auto-generated).
func isOPNsense() bool {
	_, err := os.Stat("/usr/local/opnsense/version/core")
	return err == nil
}

// configurePFRules sets up pf block rules for the Obliguard blocklist table.
// On plain FreeBSD it appends rules to /etc/pf.conf.
// On OPNsense it installs a filter-reload hook (since pf.conf is regenerated).
func configurePFRules() {
	if isOPNsense() {
		configurePFRulesOPNsense()
	} else {
		configurePFRulesFreeBSD()
	}
}

// configurePFRulesFreeBSD appends Obliguard rules to /etc/pf.conf if not
// already present, then reloads the pf ruleset.
func configurePFRulesFreeBSD() {
	// Check if rules are already in pf.conf
	existing, err := os.ReadFile(pfConfPath)
	if err != nil && !os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "Warning: cannot read %s: %v\n", pfConfPath, err)
		return
	}
	if strings.Contains(string(existing), pfMarker) {
		fmt.Printf("pf rules already configured in %s\n", pfConfPath)
		return
	}

	// Append rules to pf.conf
	f, err := os.OpenFile(pfConfPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: cannot write %s: %v\n", pfConfPath, err)
		fmt.Fprintln(os.Stderr, "You may need to manually add these rules to your pf.conf:")
		fmt.Fprint(os.Stderr, pfAnchorRules)
		return
	}
	defer f.Close()

	if _, err := f.WriteString("\n" + pfAnchorRules); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to append rules to %s: %v\n", pfConfPath, err)
		return
	}

	fmt.Printf("pf rules added to %s\n", pfConfPath)

	// Reload pf
	if err := exec.Command("pfctl", "-f", pfConfPath).Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: pfctl reload failed: %v (rules will apply on next pf restart)\n", err)
	} else {
		fmt.Println("pf reloaded successfully")
	}
}

// configurePFRulesOPNsense installs a configd action + shell script that
// re-applies the Obliguard pf table and block rules after every OPNsense
// filter reload. This ensures rules survive pf.conf regeneration.
func configurePFRulesOPNsense() {
	// 1. Write the reload hook script
	hookScript := fmt.Sprintf(`#!/bin/sh
# Obliguard IPS — re-apply pf table + block rules after OPNsense filter reload.
# Installed by obliguard-agent; removed on uninstall.

# Ensure the table exists (persist flag keeps it across reloads)
/sbin/pfctl -t %s -T show >/dev/null 2>&1 || \
    echo "table <%s> persist" | /sbin/pfctl -a obliguard -f -

# Load block rules into the obliguard anchor
echo "table <%s> persist
block in quick from <%s>
block out quick to <%s>" | /sbin/pfctl -a obliguard -f -
`, pfMarker, pfMarker, pfMarker, pfMarker, pfMarker)

	os.MkdirAll(filepath.Dir(opnsenseHookScript), 0755)
	if err := os.WriteFile(opnsenseHookScript, []byte(hookScript), 0755); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: cannot write OPNsense hook script: %v\n", err)
		return
	}
	fmt.Printf("OPNsense reload hook script written to %s\n", opnsenseHookScript)

	// 2. Write the configd action that triggers the hook after filter reload
	actionConf := `[reload]
command:/usr/local/opnsense/scripts/filter/obliguard_reload.sh
parameters:
type:script
message:Obliguard pf table reload
description:Reload Obliguard IPS pf rules
`
	os.MkdirAll(filepath.Dir(opnsenseHookConf), 0755)
	if err := os.WriteFile(opnsenseHookConf, []byte(actionConf), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: cannot write OPNsense configd action: %v\n", err)
		return
	}
	fmt.Printf("OPNsense configd action written to %s\n", opnsenseHookConf)

	// 3. Restart configd to pick up the new action
	exec.Command("service", "configd", "restart").Run()

	// 4. Also apply rules immediately via the anchor
	cmd := exec.Command("pfctl", "-a", "obliguard", "-f", "-")
	cmd.Stdin = strings.NewReader(fmt.Sprintf(
		"table <%s> persist\nblock in quick from <%s>\nblock out quick to <%s>\n",
		pfMarker, pfMarker, pfMarker))
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: immediate anchor load failed: %v\n", err)
	} else {
		fmt.Println("pf anchor 'obliguard' loaded with block rules")
	}

	// 5. Ensure the anchor is referenced in the main ruleset
	// OPNsense includes anchors automatically via its generated config, but
	// we also check if a manual anchor reference is needed.
	ensureOPNsenseAnchor()
}

// ensureOPNsenseAnchor checks that the 'obliguard' anchor is referenced in
// OPNsense's pf ruleset. If not, it adds it via pfctl.
func ensureOPNsenseAnchor() {
	// Check if the anchor is already loaded
	out, _ := exec.Command("pfctl", "-sA").Output()
	if strings.Contains(string(out), "obliguard") {
		return
	}
	// The anchor was loaded via pfctl -a above, but OPNsense needs to also
	// evaluate it. We add an "anchor obliguard" rule to the main ruleset.
	// On OPNsense, the safest way is via /usr/local/etc/pf.opnsense.d/
	anchorDir := "/usr/local/etc/pf.opnsense.d"
	os.MkdirAll(anchorDir, 0755)
	anchorFile := filepath.Join(anchorDir, "obliguard.conf")
	if err := os.WriteFile(anchorFile, []byte("anchor \"obliguard\"\n"), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: cannot write anchor include: %v\n", err)
	}
}

// cleanupPFRules removes Obliguard rules from the pf configuration.
func cleanupPFRules() {
	if isOPNsense() {
		cleanupPFRulesOPNsense()
	} else {
		cleanupPFRulesFreeBSD()
	}
	// Flush the table
	exec.Command("pfctl", "-t", pfMarker, "-T", "flush").Run()
	exec.Command("pfctl", "-t", pfMarker, "-T", "kill").Run()
}

// cleanupPFRulesFreeBSD removes Obliguard lines from /etc/pf.conf and reloads.
func cleanupPFRulesFreeBSD() {
	data, err := os.ReadFile(pfConfPath)
	if err != nil {
		return
	}
	var cleaned []string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.Contains(line, pfMarker) || strings.Contains(line, "Obliguard IPS") {
			continue
		}
		cleaned = append(cleaned, line)
	}
	result := strings.TrimRight(strings.Join(cleaned, "\n"), "\n") + "\n"
	if err := os.WriteFile(pfConfPath, []byte(result), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: cannot clean %s: %v\n", pfConfPath, err)
		return
	}
	exec.Command("pfctl", "-f", pfConfPath).Run()
	fmt.Printf("Obliguard rules removed from %s\n", pfConfPath)
}

// cleanupPFRulesOPNsense removes the hook script, configd action, and anchor.
func cleanupPFRulesOPNsense() {
	for _, path := range []string{
		opnsenseHookScript,
		opnsenseHookConf,
		"/usr/local/etc/pf.opnsense.d/obliguard.conf",
	} {
		if err := os.Remove(path); err == nil {
			fmt.Printf("Removed %s\n", path)
		}
	}
	// Flush the anchor
	exec.Command("pfctl", "-a", "obliguard", "-F", "all").Run()
	// Restart configd to drop the action
	exec.Command("service", "configd", "restart").Run()
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
