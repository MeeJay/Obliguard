//go:build !windows

// The install wizard is a Windows-only GUI tool (it pulls in lxn/walk, which
// only compiles for windows). This stub lets the package list/vet on other
// platforms without dragging in walk — the build script only ever builds it
// with GOOS=windows.

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "obliguard-installer-wizard runs on Windows only.")
	os.Exit(1)
}
