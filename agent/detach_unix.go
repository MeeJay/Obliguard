//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// detachCmd starts c in its own process group, so the uninstall script outlives
// the agent: launchd (without AbandonProcessGroup) kills the whole process
// group of the job when the agent exits or is unloaded.
func detachCmd(c *exec.Cmd) {
	if c.SysProcAttr == nil {
		c.SysProcAttr = &syscall.SysProcAttr{}
	}
	c.SysProcAttr.Setpgid = true
}
