//go:build freebsd

package main

import (
	"fmt"
	"os/exec"
)

func init() { platformRuleManager = &FreeBSDRuleManager{} }

type FreeBSDRuleManager struct{}

func (m *FreeBSDRuleManager) PlatformName() string { return "freebsd_pf" }

func (m *FreeBSDRuleManager) ListRules() ([]FwRule, error) {
	out, err := exec.Command("pfctl", "-sr").Output()
	if err != nil {
		return nil, fmt.Errorf("pfctl -sr: %w", err)
	}
	// Reuse darwin parser
	return parsePfRules(string(out), "freebsd_pf"), nil
}

func (m *FreeBSDRuleManager) AddRule(_ FwAddRequest) error {
	return fmt.Errorf("adding pf rules requires anchor file management — not yet implemented")
}

func (m *FreeBSDRuleManager) DeleteRule(_ string) error {
	return fmt.Errorf("deleting pf rules requires anchor file management — not yet implemented")
}

func (m *FreeBSDRuleManager) ToggleRule(_ string, _ bool) error {
	return fmt.Errorf("pf does not support enabling/disabling individual rules")
}
