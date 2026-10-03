//go:build windows

package main

import "os/exec"

// detachCmd is a no-op on Windows: the uninstall script started by the service
// is not killed with it (see detach_unix.go).
func detachCmd(_ *exec.Cmd) {}
