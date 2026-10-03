//go:build !windows

package main

// cleanupWindowsFirewall is Windows-only (firewall_cleanup_windows.go); this
// stub lets the tagless cleanupFirewall compile everywhere.
func cleanupWindowsFirewall(_ func(format string, args ...any)) {}
