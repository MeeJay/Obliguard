//go:build !windows

package main

import (
	"os"
	"testing"
)

// config.json holds the API key: written owner-only, and a file left 0644 by
// an older agent is tightened at the next save (W14-5).
func TestSaveConfigOwnerOnly(t *testing.T) {
	useTempConfig(t)
	if err := os.WriteFile(configFile, []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := saveConfig(&Config{ServerURL: "https://a", APIKey: "k"}); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(configFile)
	if err != nil {
		t.Fatal(err)
	}
	if mode := st.Mode().Perm(); mode != 0600 {
		t.Fatalf("config.json mode = %o, want 600", mode)
	}
}
