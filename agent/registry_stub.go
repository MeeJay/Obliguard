//go:build !windows

package main

import "errors"

// loadConfigFromRegistry is a no-op stub on non-Windows platforms.
func loadConfigFromRegistry() (*Config, error) {
	return nil, errors.New("registry not available on this platform")
}
