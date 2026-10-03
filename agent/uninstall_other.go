//go:build !windows

package main

// installedProductCode is Windows-only (uninstall_windows.go).
func installedProductCode() string { return "" }
