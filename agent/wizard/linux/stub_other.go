//go:build !linux

// The Linux install wizard only targets Linux. This stub lets the package
// list/vet on other platforms; the build script only builds it with GOOS=linux.

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "obliguard-installer-wizard-linux runs on Linux only.")
	os.Exit(1)
}
