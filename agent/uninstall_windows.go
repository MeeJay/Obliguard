//go:build windows

package main

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

// msiProductName is the Package Name of installer/product.wxs, shown as the
// DisplayName of the product's Uninstall registration.
const msiProductName = "Obliguard Agent"

// installedProductCode returns the ProductCode of the installed Obliguard
// Agent MSI ("" when none is registered). Windows Installer registers each
// product under the Uninstall key named by its ProductCode (64-bit view: the
// MSI is built for x64).
func installedProductCode() string {
	const uninstallKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, uninstallKey,
		registry.ENUMERATE_SUB_KEYS|registry.WOW64_64KEY)
	if err != nil {
		return ""
	}
	defer k.Close()
	names, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return ""
	}
	for _, name := range names {
		if !strings.HasPrefix(name, "{") {
			continue
		}
		sk, err := registry.OpenKey(k, name, registry.QUERY_VALUE|registry.WOW64_64KEY)
		if err != nil {
			continue
		}
		display, _, derr := sk.GetStringValue("DisplayName")
		msi, _, merr := sk.GetIntegerValue("WindowsInstaller")
		sk.Close()
		if derr == nil && merr == nil && msi == 1 && display == msiProductName {
			return name
		}
	}
	return ""
}
