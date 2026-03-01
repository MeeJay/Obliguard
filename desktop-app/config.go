package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Config holds all persisted user preferences.
type Config struct {
	URL    string `json:"url"`
	Width  int    `json:"width,omitempty"`  // last known window content width  (logical px)
	Height int    `json:"height,omitempty"` // last known window content height (logical px)
}

// configPath returns the OS-appropriate path for config.json:
//   - Windows : %APPDATA%\Obliview\config.json
//   - macOS   : ~/Library/Application Support/Obliview/config.json
//   - Linux   : ~/.config/obliview/config.json
func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "Obliview", "config.json"), nil
}

// loadConfig reads the config file and returns the parsed Config.
// Returns an empty Config (no error) when the file does not exist yet.
func loadConfig() (*Config, error) {
	path, err := configPath()
	if err != nil {
		return &Config{}, nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		// File not found on first run — not an error.
		return &Config{}, nil
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return &Config{}, nil
	}

	return &cfg, nil
}

// saveConfig persists the Config to disk.
func saveConfig(cfg *Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0o600)
}
