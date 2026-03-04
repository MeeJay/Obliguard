package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

type pushBody struct {
	Hostname     string  `json:"hostname"`
	AgentVersion string  `json:"agentVersion"`
	OSInfo       OSInfo  `json:"osInfo"`
	Metrics      Metrics `json:"metrics"`
}

type pushResponse struct {
	Status        string `json:"status"`
	LatestVersion string `json:"latestVersion,omitempty"` // piggybacked version info
	Config        *struct {
		CheckIntervalSeconds int `json:"checkIntervalSeconds"`
	} `json:"config,omitempty"`
	// One-shot command from the server (e.g. "uninstall"). Cleared in DB once delivered.
	Command string `json:"command,omitempty"`
}

var httpClient = &http.Client{Timeout: 30 * time.Second}

func push(cfg *Config) {
	hostname, _ := os.Hostname()

	body := pushBody{
		Hostname:     hostname,
		AgentVersion: cfg.AgentVersion,
		OSInfo:       getOSInfo(),
		Metrics:      collectMetrics(),
	}

	data, err := json.Marshal(body)
	if err != nil {
		log.Printf("Push error (marshal): %v", err)
		return
	}

	req, err := http.NewRequest("POST", cfg.ServerURL+"/api/agent/push", bytes.NewReader(data))
	if err != nil {
		log.Printf("Push error (request): %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", cfg.APIKey)
	req.Header.Set("X-Device-UUID", cfg.DeviceUUID)

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("Push error: %v", err)
		return
	}
	defer resp.Body.Close()

	var result pushResponse
	_ = json.NewDecoder(resp.Body).Decode(&result)

	switch resp.StatusCode {
	case 200:
		backoffLevel = 0
		cfg.BackoffUntil = 0
		if result.Config != nil && result.Config.CheckIntervalSeconds > 0 &&
			result.Config.CheckIntervalSeconds != cfg.CheckIntervalSeconds {
			cfg.CheckIntervalSeconds = result.Config.CheckIntervalSeconds
			_ = saveConfig(cfg)
			log.Printf("Check interval updated to %ds", cfg.CheckIntervalSeconds)
		}
		log.Printf("Push OK")
		// Handle one-shot command from server (e.g. uninstall) — must be processed
		// before the version check since commands like "uninstall" call os.Exit.
		if result.Command != "" {
			log.Printf("Received command from server: %s", result.Command)
			if result.Command == "uninstall" {
				handleUninstallCommand(cfg)
				return // not reached if uninstall succeeds; guards against unknown commands
			}
		}
		// Version piggybacked on push response — update without an extra round-trip.
		if result.LatestVersion != "" {
			applyUpdateIfNewer(cfg, result.LatestVersion)
		}

	case 202:
		log.Printf("Device pending approval...")
		if result.Config != nil && result.Config.CheckIntervalSeconds > 0 {
			cfg.CheckIntervalSeconds = result.Config.CheckIntervalSeconds
			_ = saveConfig(cfg)
		}
		// Handle one-shot command (pending devices can also receive commands).
		if result.Command != "" {
			log.Printf("Received command from server: %s", result.Command)
			if result.Command == "uninstall" {
				handleUninstallCommand(cfg)
				return
			}
		}
		if result.LatestVersion != "" {
			applyUpdateIfNewer(cfg, result.LatestVersion)
		}

	case 401:
		idx := backoffLevel
		if idx >= len(backoffSteps) {
			idx = len(backoffSteps) - 1
		}
		backoffSecs := backoffSteps[idx]
		log.Printf("Unauthorized. Backing off for %ds...", backoffSecs)
		backoffLevel++
		cfg.BackoffUntil = time.Now().UnixMilli() + int64(backoffSecs)*1000
		_ = saveConfig(cfg)

	default:
		log.Printf("Push returned unexpected status %d", resp.StatusCode)
	}
}
