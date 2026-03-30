package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ── Timing constants ──────────────────────────────────────────────────────────

const (
	// cmdWSHeartbeatInterval: status heartbeat cadence (services, LAN IPs, firewall list).
	// Full handlePush pipeline runs at this rate. Event flushes are immediate (debounced 500 ms).
	cmdWSHeartbeatInterval = 30 * time.Second

	// cmdWSReadTimeout: maximum time to wait for any frame (message or server ping).
	// Server sends pings every 15 s; 4 missed = 60 s.
	cmdWSReadTimeout = 60 * time.Second

	// Event debounce: wait this long after the last new event before flushing.
	// Batches rapid bursts into a single WS frame while keeping latency low.
	cmdWSEventDebounce = 500 * time.Millisecond

	// Reconnect backoff: starts at 2 s, grows ×1.5 each failure, caps at 60 s.
	cmdWSReconnectBase = 2 * time.Second
	cmdWSReconnectMax  = 60 * time.Second
)

// ── Message types ─────────────────────────────────────────────────────────────

// cmdHeartbeatMsg is the periodic status frame sent agent → server every 30 s.
// Does NOT include events — those are flushed immediately via cmdEventsMsg.
type cmdHeartbeatMsg struct {
	Type           string                 `json:"type"`                      // always "heartbeat"
	Hostname       string                 `json:"hostname"`
	AgentVersion   string                 `json:"agentVersion"`
	OSInfo         OSInfo                 `json:"osInfo"`
	Services       []AgentDetectedService `json:"services,omitempty"`
	FirewallBanned []string               `json:"firewallBanned,omitempty"`
	FirewallName   string                 `json:"firewallName,omitempty"`
	LanIPs         []string               `json:"lanIPs,omitempty"`
}

// cmdEventsMsg carries auth events flushed in near-real-time (≤500 ms debounce).
type cmdEventsMsg struct {
	Type   string         `json:"type"`   // always "events"
	Events []AgentIpEvent `json:"events"`
}

// cmdConfigMsg is the server's config response to a heartbeat.
type cmdConfigMsg struct {
	Type                string                       `json:"type"`                          // "config"
	PushIntervalSeconds int                          `json:"pushIntervalSeconds,omitempty"` // heartbeat cadence (currently fixed at 30 s)
	LatestVersion       string                       `json:"latestVersion,omitempty"`
	BanList             *banListDelta                `json:"banList,omitempty"`
	Whitelist           []string                     `json:"whitelist,omitempty"`
	Services            map[string]AgentServiceConfig `json:"services,omitempty"`
	Command             string                       `json:"command,omitempty"`
}

// ── Public entry point ────────────────────────────────────────────────────────

// runCmdWS replaces the old HTTP push loop with a persistent WebSocket.
// Events are flushed to the server within 500 ms of occurrence; the full
// heartbeat (services, LAN IPs, firewall state) is sent every 30 s.
func runCmdWS(cfg *Config, lw *LogWatcher, fw FirewallManager) {
	log.Printf("Obliguard Agent v%s starting (WS mode, uuid=%s server=%s)",
		cfg.AgentVersion, cfg.DeviceUUID, cfg.ServerURL)

	checkForUpdate(cfg)

	backoff := cmdWSReconnectBase

	for {
		err := cmdWSSession(cfg, lw, fw)
		if err == nil {
			log.Printf("Command WS: clean close — reconnecting in %s", cmdWSReconnectBase)
			backoff = cmdWSReconnectBase
		} else {
			log.Printf("Command WS: %v — reconnecting in %s", err, backoff)
			next := time.Duration(float64(backoff) * 1.5)
			if next > cmdWSReconnectMax {
				next = cmdWSReconnectMax
			}
			backoff = next
		}
		time.Sleep(backoff)
	}
}

// ── Session ───────────────────────────────────────────────────────────────────

func cmdWSSession(cfg *Config, lw *LogWatcher, fw FirewallManager) error {
	// Build ws(s):// URL
	base := strings.TrimRight(cfg.ServerURL, "/")
	var wsBase string
	switch {
	case strings.HasPrefix(base, "https://"):
		wsBase = "wss://" + base[8:]
	case strings.HasPrefix(base, "http://"):
		wsBase = "ws://" + base[7:]
	default:
		wsBase = base
	}
	wsURL := wsBase + "/api/agent/ws?uuid=" + url.QueryEscape(cfg.DeviceUUID)

	ws, err := wsConnect(wsURL, http.Header{"X-API-Key": []string{cfg.APIKey}})
	if err != nil {
		return fmt.Errorf("connect %s: %w", wsBase, err)
	}
	defer ws.Close()

	log.Printf("Command WS: connected to %s", wsBase)

	// Send the first heartbeat immediately — registers/updates the device record
	// in the DB and receives the current config + any offline-queued command.
	if err := sendOGHeartbeat(ws, cfg, lw, fw); err != nil {
		return fmt.Errorf("initial heartbeat: %w", err)
	}

	hbTicker := time.NewTicker(cmdWSHeartbeatInterval)
	defer hbTicker.Stop()

	if err := ws.conn.SetReadDeadline(time.Now().Add(cmdWSReadTimeout)); err != nil {
		return fmt.Errorf("set read deadline: %w", err)
	}

	// Frame reader goroutine
	type wsFrame struct {
		opcode  byte
		payload []byte
		err     error
	}
	frameCh := make(chan wsFrame, 8)
	go func() {
		for {
			op, pay, err := ws.ReadFrame()
			frameCh <- wsFrame{op, pay, err}
			if err != nil {
				return
			}
		}
	}()

	// Event debounce timer — nil means no pending flush
	var debounce <-chan time.Time

	for {
		select {

		// ── Flush signal from LogWatcher ───────────────────────────────────────
		case <-lw.FlushCh():
			// Start (or restart) the 500 ms debounce window.
			debounce = time.After(cmdWSEventDebounce)

		// ── Debounce timer fired — flush accumulated events ────────────────────
		case <-debounce:
			debounce = nil
			events := lw.DrainEvents()
			if len(events) > 0 {
				if err := sendOGEvents(ws, events); err != nil {
					return fmt.Errorf("events flush: %w", err)
				}
			}

		// ── Periodic full heartbeat ────────────────────────────────────────────
		case <-hbTicker.C:
			if err := sendOGHeartbeat(ws, cfg, lw, fw); err != nil {
				return fmt.Errorf("heartbeat send: %w", err)
			}

		// ── Incoming frame from server ─────────────────────────────────────────
		case f := <-frameCh:
			if f.err != nil {
				return fmt.Errorf("read: %w", f.err)
			}

			_ = ws.conn.SetReadDeadline(time.Now().Add(cmdWSReadTimeout))

			switch f.opcode {
			case 0x8: // close
				return nil

			case 0x9: // ping → pong
				_ = ws.SendPong(f.payload)

			case 0xA: // pong — ignore

			case 0x1: // text — JSON from server
				handleOGServerFrame(cfg, lw, fw, f.payload)
			}
		}
	}
}

// handleOGServerFrame dispatches a server-sent text frame.
func handleOGServerFrame(cfg *Config, lw *LogWatcher, fw FirewallManager, payload []byte) {
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		log.Printf("Command WS: malformed JSON: %v", err)
		return
	}

	switch env.Type {
	case "config":
		var msg cmdConfigMsg
		if err := json.Unmarshal(payload, &msg); err != nil {
			log.Printf("Command WS: malformed config: %v", err)
			return
		}
		applyOGConfig(cfg, lw, fw, &msg)
	}
}

// applyOGConfig applies the config response received after a heartbeat.
func applyOGConfig(cfg *Config, lw *LogWatcher, fw FirewallManager, msg *cmdConfigMsg) {
	// One-shot command (uninstall, etc.) — process before everything else
	if msg.Command != "" {
		log.Printf("Command WS: received command: %s", msg.Command)
		if msg.Command == "uninstall" {
			handleUninstallCommand(cfg)
			return
		}
	}

	// Apply ban delta immediately
	if msg.BanList != nil {
		addCount, addErr := 0, 0
		for _, ip := range msg.BanList.Add {
			if err := fw.BanIP(ip); err != nil {
				addErr++
			} else {
				addCount++
			}
		}
		remCount, remErr := 0, 0
		for _, ip := range msg.BanList.Remove {
			if err := fw.UnbanIP(ip); err != nil {
				remErr++
			} else {
				remCount++
			}
		}
		// Flush buffered changes (nftables/ipset/Windows: single batch call)
		if err := fw.Flush(); err != nil {
			log.Printf("Firewall flush: %v", err)
		}
		if addCount > 0 || remCount > 0 || addErr > 0 || remErr > 0 {
			log.Printf("Firewall: +%d banned, -%d unbanned (errors: +%d/-%d)", addCount, remCount, addErr, remErr)
		}
	}

	// Update log watcher service configs
	if lw != nil && len(msg.Services) > 0 {
		lw.UpdateConfigs(msg.Services)
		cfg.ServiceConfigs = msg.Services
		_ = saveConfig(cfg)
	}

	// Auto-update if newer version available
	if msg.LatestVersion != "" {
		applyUpdateIfNewer(cfg, msg.LatestVersion)
	}
}

// ── Outgoing messages ─────────────────────────────────────────────────────────

func sendOGHeartbeat(ws *wsConn, cfg *Config, lw *LogWatcher, fw FirewallManager) error {
	banned, _ := fw.GetBannedIPs()

	msg := cmdHeartbeatMsg{
		Type:           "heartbeat",
		Hostname:       getHostname(),
		AgentVersion:   cfg.AgentVersion,
		OSInfo:         getOSInfo(),
		Services:       detectServices(),
		FirewallBanned: banned,
		FirewallName:   fw.Name(),
		LanIPs:         getLanIPs(),
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal heartbeat: %w", err)
	}
	return ws.WriteFrame(0x1, data)
}

func sendOGEvents(ws *wsConn, events []AgentIpEvent) error {
	msg := cmdEventsMsg{
		Type:   "events",
		Events: events,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal events: %w", err)
	}
	return ws.WriteFrame(0x1, data)
}
