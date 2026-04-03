//go:build darwin

package main

import (
	"fmt"
	"os/exec"
)

func init() { platformRuleManager = &DarwinRuleManager{} }

type DarwinRuleManager struct{}

func (m *DarwinRuleManager) PlatformName() string { return "macos_pf" }

func (m *DarwinRuleManager) ListRules() ([]FwRule, error) {
	out, err := exec.Command("pfctl", "-sr").Output()
	if err != nil {
		return nil, fmt.Errorf("pfctl -sr: %w", err)
	}
	return parsePfRules(string(out), "macos_pf"), nil
}

func (m *DarwinRuleManager) AddRule(_ FwAddRequest) error {
	return fmt.Errorf("adding pf rules requires anchor file management — not yet implemented")
}

func (m *DarwinRuleManager) DeleteRule(_ string) error {
	return fmt.Errorf("deleting pf rules requires anchor file management — not yet implemented")
}

func (m *DarwinRuleManager) ToggleRule(_ string, _ bool) error {
	return fmt.Errorf("pf does not support enabling/disabling individual rules")
}

