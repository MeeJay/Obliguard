package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// ── Obliguard push payload types ──────────────────────────────────────────────

type AgentDetectedService struct {
	Type   string `json:"type"`
	Port   *int   `json:"port,omitempty"`
	Active bool   `json:"active"`
}

type AgentIpEvent struct {
	ID        string `json:"id"`
	IP        string `json:"ip"`
	Username  string `json:"username,omitempty"`
	Service   string `json:"service"`
	EventType string `json:"eventType"` // "auth_failure" | "auth_success" | "port_scan"
	Timestamp string `json:"timestamp"` // RFC3339
	RawLog    string `json:"rawLog,omitempty"`
}

type pushBody struct {
	Hostname       string                 `json:"hostname"`
	AgentVersion   string                 `json:"agentVersion"`
	OSInfo         OSInfo                 `json:"osInfo"`
	Services       []AgentDetectedService `json:"services,omitempty"`
	Events         []AgentIpEvent         `json:"events,omitempty"`
	FirewallBanned []string               `json:"firewallBanned,omitempty"`
	FirewallName   string                 `json:"firewallName,omitempty"`
	LogSamples     map[string][]string    `json:"logSamples,omitempty"`
	// RFC-1918 LAN IPs for agent-to-agent peer link detection on the NetMap.
	LanIPs         []string               `json:"lanIPs,omitempty"`
}

// ── Obliguard push response types ─────────────────────────────────────────────

type AgentServiceConfig struct {
	Enabled         bool    `json:"enabled"`
	Threshold       int     `json:"threshold"`
	WindowSeconds   int     `json:"windowSeconds"`
	CustomRegex     *string `json:"customRegex,omitempty"`
	SampleRequested bool    `json:"sampleRequested,omitempty"`
}

type banListDelta struct {
	Add    []string `json:"add"`
	Remove []string `json:"remove"`
}

type pushResponse struct {
	Status        string                        `json:"status"`
	LatestVersion string                        `json:"latestVersion,omitempty"`
	Config        *struct {
		PushIntervalSeconds int `json:"pushIntervalSeconds"`
	} `json:"config,omitempty"`
	BanList   *banListDelta                     `json:"banList,omitempty"`
	Whitelist []string                           `json:"whitelist,omitempty"`
	Services  map[string]AgentServiceConfig      `json:"services,omitempty"`
	Command   string                             `json:"command,omitempty"`
}

var httpClient = &http.Client{Timeout: 30 * time.Second}

func push(cfg *Config, lw *LogWatcher, fw FirewallManager) {
	// Collect detected services
	services := detectServices()

	// Drain pending auth events from log watcher
	var events []AgentIpEvent
	var logSamples map[string][]string
	if lw != nil {
		events = lw.DrainEvents()
		logSamples = lw.DrainSamples()
	}

	// Current firewall ban list so server can compute the delta
	banned, _ := fw.GetBannedIPs()

	body := pushBody{
		Hostname:       getHostname(),
		AgentVersion:   cfg.AgentVersion,
		OSInfo:         getOSInfo(),
		Services:       services,
		Events:         events,
		FirewallBanned: banned,
		FirewallName:   fw.Name(),
		LogSamples:     logSamples,
		LanIPs:         getLanIPs(),
	}

	data, err := json.Marshal(body)
	if err != nil {
		log.Printf("Push marshal error: %v", err)
		return
	}

	req, err := http.NewRequest("POST", cfg.ServerURL+"/api/agent/push", bytes.NewReader(data))
	if err != nil {
		log.Printf("Push request error: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", cfg.APIKey)
	req.Header.Set("X-Device-UUID", cfg.DeviceUUID)

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("Push error: %v", err)
		applyBackoff(cfg)
		return
	}
	defer resp.Body.Close()

	var result pushResponse
	if decErr := json.NewDecoder(resp.Body).Decode(&result); decErr != nil {
		log.Printf("Push decode error: %v", decErr)
		return
	}

	switch resp.StatusCode {
	case 200:
		backoffLevel = 0
		cfg.BackoffUntil = 0

		// Interval update
		if result.Config != nil && result.Config.PushIntervalSeconds > 0 &&
			result.Config.PushIntervalSeconds != cfg.CheckIntervalSeconds {
			cfg.CheckIntervalSeconds = result.Config.PushIntervalSeconds
			_ = saveConfig(cfg)
			log.Printf("Push interval updated to %ds", cfg.CheckIntervalSeconds)
		}

		// Apply firewall ban delta
		if result.BanList != nil {
			for _, ip := range result.BanList.Add {
				if err := fw.BanIP(ip); err != nil {
					log.Printf("Firewall ban %s: %v", ip, err)
				} else {
					log.Printf("Firewall: banned %s", ip)
				}
			}
			for _, ip := range result.BanList.Remove {
				if err := fw.UnbanIP(ip); err != nil {
					log.Printf("Firewall unban %s: %v", ip, err)
				} else {
					log.Printf("Firewall: unbanned %s", ip)
				}
			}
		}

		// Forward updated service configs to the log watcher
		if lw != nil && len(result.Services) > 0 {
			lw.UpdateConfigs(result.Services)
		}

		// Cache service configs in config file for next startup
		if len(result.Services) > 0 {
			cfg.ServiceConfigs = result.Services
			_ = saveConfig(cfg)
		}

		addLen, removeLen := 0, 0
		if result.BanList != nil {
			addLen = len(result.BanList.Add)
			removeLen = len(result.BanList.Remove)
		}
		log.Printf("Push OK — events=%d ban_add=%d ban_remove=%d",
			len(events), addLen, removeLen)

		// One-shot command (uninstall, etc.)
		if result.Command != "" {
			log.Printf("Received command: %s", result.Command)
			if result.Command == "uninstall" {
				handleUninstallCommand(cfg)
				return
			}
		}

		// Piggy-backed version check
		if result.LatestVersion != "" {
			applyUpdateIfNewer(cfg, result.LatestVersion)
		}

	case 202:
		log.Printf("Push: device pending approval")
		if result.Command == "uninstall" {
			handleUninstallCommand(cfg)
		}

	case 401:
		applyBackoff(cfg)
		log.Printf("Push: auth failed — backing off")

	default:
		log.Printf("Push: unexpected status %d", resp.StatusCode)
		applyBackoff(cfg)
	}
}

func applyBackoff(cfg *Config) {
	idx := backoffLevel
	if idx >= len(backoffSteps) {
		idx = len(backoffSteps) - 1
	}
	waitSec := backoffSteps[idx]
	cfg.BackoffUntil = time.Now().UnixMilli() + int64(waitSec)*1000
	backoffLevel++
	// NOTE: backoff is intentionally NOT persisted to disk.
	// Saving it caused agents to remain stuck after a server reboot: the
	// BackoffUntil timestamp written before the reboot survived process restarts
	// and prevented reconnection even after the server was back online.
	// In-memory backoff is sufficient — it still prevents hammering during an
	// outage, and restarting the agent service always clears the wait period.
}

// backoffSteps and backoffLevel are declared in main.go
