//go:build windows

package main

import (
	"golang.org/x/sys/windows/registry"
)

const regPath = `SOFTWARE\ObliguardAgent`

func loadConfigFromRegistry() (*Config, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, regPath, registry.QUERY_VALUE)
	if err != nil {
		return nil, err
	}
	defer k.Close()

	serverURL, _, err := k.GetStringValue("ServerURL")
	if err != nil {
		return nil, err
	}
	apiKey, _, err := k.GetStringValue("APIKey")
	if err != nil {
		return nil, err
	}

	return &Config{
		ServerURL:    serverURL,
		APIKey:       apiKey,
		AgentVersion: agentVersion,
	}, nil
}
