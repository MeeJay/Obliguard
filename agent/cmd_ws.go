package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// ── Timing constants ──────────────────────────────────────────────────────────

const (
	// cmdWSHeartbeatInterval: status heartbeat cadence (services, LAN IPs, firewall list).
	// Full handlePush pipeline runs at this rate. Events ride their own frames.
	cmdWSHeartbeatInterval = 30 * time.Second

	// cmdWSReadTimeout: maximum time to wait for any frame (message or server ping).
	// Server sends pings every 15 s; 4 missed = 60 s.
	cmdWSReadTimeout = 60 * time.Second

	// cmdWSEventFlushInterval: fixed flush cadence of the event queue. A fixed
	// window (not a debounce restarted by every event) bounds the latency at
	// 500 ms even under a continuous stream of events.
	cmdWSEventFlushInterval = 500 * time.Millisecond

	// cmdWSWriteTimeout bounds the write of one frame: a peer that stops
	// reading fails the session instead of blocking the writer forever.
	cmdWSWriteTimeout = 30 * time.Second

	// cmdWSSendTimeout is how long a producer waits for room in the outbound
	// queue (back-pressure) before the session is considered stuck.
	cmdWSSendTimeout = 10 * time.Second

	// cmdWSOutQueueSize: outbound frames buffered for the single writer.
	cmdWSOutQueueSize = 64

	// cmdWSConfigQueueSize: config frames buffered for the config worker. A
	// full queue blocks the read loop (back-pressure), never drops a frame.
	cmdWSConfigQueueSize = 16

	// Reconnect backoff: starts at 2 s, doubles after each failed attempt,
	// capped at 60 s, with ±50% jitter so a fleet does not reconnect in step
	// after a server restart. A session that stayed up cmdWSStableSession
	// resets it.
	cmdWSReconnectBase = 2 * time.Second
	cmdWSReconnectMax  = 60 * time.Second
	cmdWSStableSession = 60 * time.Second

	// fwCommandTimeout bounds a firewall rule command (list/add/delete/toggle):
	// the agent answers an error before the server's pushAndWait gives up (30 s).
	fwCommandTimeout = 25 * time.Second
	// fwCommandMaxInFlight bounds the firewall commands accepted and not yet
	// answered; beyond it a command is refused at once.
	fwCommandMaxInFlight = 8
)

// ── Message types ─────────────────────────────────────────────────────────────

// cmdHeartbeatMsg is the periodic status frame sent agent → server every 30 s.
// Does NOT include events — those are flushed through cmdEventsMsg.
type cmdHeartbeatMsg struct {
	Type           string                 `json:"type"` // always "heartbeat"
	Hostname       string                 `json:"hostname"`
	AgentVersion   string                 `json:"agentVersion"`
	OSInfo         OSInfo                 `json:"osInfo"`
	Services       []AgentDetectedService `json:"services,omitempty"`
	FirewallBanned []string               `json:"firewallBanned,omitempty"`
	FirewallName   string                 `json:"firewallName,omitempty"`
	LanIPs         []string               `json:"lanIPs,omitempty"`
	// Optional protocol features (update_status, sha256, tls_verify |
	// tls_unverified, cidr). Older servers ignore the field.
	Capabilities []string `json:"capabilities,omitempty"`
}

// cmdEventsMsg carries a batch of at most eventBatchMax auth events, flushed
// every cmdWSEventFlushInterval.
type cmdEventsMsg struct {
	Type   string         `json:"type"` // always "events"
	Events []AgentIpEvent `json:"events"`
	// Dropped counts the events lost since the previous frame because the
	// bounded queue was full (eventqueue.go). Older servers ignore the field.
	Dropped int `json:"dropped,omitempty"`
}

// cmdUpdateStatusMsg reports the progress of a self-update (agent → server),
// same envelope as cmdEventsMsg. Older servers ignore unknown frame types.
type cmdUpdateStatusMsg struct {
	Type          string `json:"type"` // always "update_status"
	TargetVersion string `json:"targetVersion"`
	Phase         string `json:"phase"` // downloading | verifying | installing | restarting | failed
	Error         string `json:"error,omitempty"`
}

const (
	updatePhaseDownloading = "downloading"
	updatePhaseVerifying   = "verifying"
	updatePhaseInstalling  = "installing"
	updatePhaseRestarting  = "restarting"
	updatePhaseFailed      = "failed"

	// updateStatusMaxError caps the error text sent to the server.
	updateStatusMaxError = 500
)

// cmdConfigMsg is the server's config response to a heartbeat.
type cmdConfigMsg struct {
	Type                string                        `json:"type"`                          // "config"
	PushIntervalSeconds int                           `json:"pushIntervalSeconds,omitempty"` // heartbeat cadence (currently fixed at 30 s)
	LatestVersion       string                        `json:"latestVersion,omitempty"`
	BanList             *banListDelta                 `json:"banList,omitempty"`
	Whitelist           []string                      `json:"whitelist,omitempty"`
	Services            map[string]AgentServiceConfig `json:"services,omitempty"`
	// RateLimits is a pointer so that an absent field (older servers, or the
	// server's enforcement switch is off) leaves the enforced limits
	// unchanged, while an explicit [] clears them.
	RateLimits *[]RateLimitRule `json:"rateLimits,omitempty"`
	Command    string           `json:"command,omitempty"`
	// FirewallBackend is the Windows backend preference (auto | wfp | netsh),
	// sent by W13+ servers to Windows agents only. A pointer: absent (older
	// servers, other platforms) leaves the current backend unchanged.
	FirewallBackend *string `json:"firewallBackend,omitempty"`
}

// ── Public entry point ────────────────────────────────────────────────────────

// cmdRuntime holds what outlives a WS session: the event queue (filled while
// disconnected too), the config worker's inbox, and what the queued commands
// act on (config, firewall backend).
type cmdRuntime struct {
	events *eventQueue
	config chan []byte
	cfg    *Config
	fw     FirewallManager
}

// runCmdWS replaces the old HTTP push loop with a persistent WebSocket.
// Events are flushed to the server within 500 ms of occurrence; the full
// heartbeat (services, LAN IPs, firewall state) is sent every 30 s.
func runCmdWS(cfg *Config, lw *LogWatcher, fw FirewallManager) {
	log.Printf("Obliguard Agent v%s starting (WS mode, uuid=%s server=%s)",
		cfg.AgentVersion, cfg.DeviceUUID, cfg.ServerURL)

	checkForUpdate(cfg)

	// Lift any ban already in the firewall that the ban-safety guard refuses.
	go purgeUnsafeBans(cfg, fw)

	rt := &cmdRuntime{
		events: newEventQueue(eventQueueCap),
		config: make(chan []byte, cmdWSConfigQueueSize),
		cfg:    cfg,
		fw:     fw,
	}
	if lw != nil {
		go pumpEvents(lw, rt.events)
	}
	go configWorker(cfg, lw, fw, rt.config)

	backoff := cmdWSReconnectBase
	for {
		start := time.Now()
		connected, err := cmdWSSession(cfg, fw, rt)
		if connected && time.Since(start) >= cmdWSStableSession {
			backoff = cmdWSReconnectBase
		}
		delay := jitterBackoff(backoff)
		if err == nil {
			log.Printf("Command WS: closed by the server — reconnecting in %s", delay.Round(100*time.Millisecond))
		} else {
			log.Printf("Command WS: %v — reconnecting in %s", err, delay.Round(100*time.Millisecond))
		}
		time.Sleep(delay)
		backoff = nextBackoff(backoff)
	}
}

// nextBackoff doubles d, capped at cmdWSReconnectMax.
func nextBackoff(d time.Duration) time.Duration {
	d *= 2
	if d > cmdWSReconnectMax || d <= 0 {
		d = cmdWSReconnectMax
	}
	return d
}

// jitterBackoff spreads d uniformly over [d/2, 3d/2), capped at cmdWSReconnectMax.
func jitterBackoff(d time.Duration) time.Duration {
	if d <= 0 {
		d = cmdWSReconnectBase
	}
	j := d/2 + time.Duration(rand.Int63n(int64(d)))
	if j > cmdWSReconnectMax {
		j = cmdWSReconnectMax
	}
	return j
}

// pumpEvents moves the LogWatcher's events into the bounded queue as soon as
// they are signalled, connected or not, so the LogWatcher buffer stays small
// and the queue alone decides what is kept.
func pumpEvents(lw *LogWatcher, q *eventQueue) {
	for range lw.FlushCh() {
		q.Push(lw.DrainEvents()...)
	}
}

// configWorker applies the config frames in arrival order, off the read loop
// (rate-limit rebuilds and saveConfig can take a while). One per process, so
// frames queued when a session drops are still applied.
func configWorker(cfg *Config, lw *LogWatcher, fw FirewallManager, in <-chan []byte) {
	for payload := range in {
		var msg cmdConfigMsg
		if err := json.Unmarshal(payload, &msg); err != nil {
			log.Printf("Command WS: malformed config: %v", err)
			continue
		}
		applyOGConfig(cfg, lw, fw, &msg)
	}
}

// ── Session ───────────────────────────────────────────────────────────────────

var (
	errCmdWSClosed       = errors.New("command channel closed")
	errCmdWSServerClosed = errors.New("closed by the server")
	errCmdWSBackpressure = errors.New("outbound queue full (writer stalled)")
)

// wsOutFrame is one frame for the writer; result (optional, buffered) gets
// the outcome of the write.
type wsOutFrame struct {
	opcode byte
	data   []byte
	result chan error
}

// cmdSession is one WS connection: a read loop, a single writer goroutine fed
// by a bounded queue, and the session loop (heartbeat, event flush).
type cmdSession struct {
	ws   *wsConn
	out  chan wsOutFrame
	done chan struct{}

	closeOnce sync.Once
	errMu     sync.Mutex
	err       error
}

func newCmdSession(ws *wsConn) *cmdSession {
	return &cmdSession{
		ws:   ws,
		out:  make(chan wsOutFrame, cmdWSOutQueueSize),
		done: make(chan struct{}),
	}
}

// fail ends the session; the first error is kept.
func (s *cmdSession) fail(err error) {
	s.errMu.Lock()
	if s.err == nil {
		s.err = err
	}
	s.errMu.Unlock()
	s.closeOnce.Do(func() { close(s.done) })
}

// Err returns the error that ended the session (nil while it runs).
func (s *cmdSession) Err() error {
	s.errMu.Lock()
	defer s.errMu.Unlock()
	return s.err
}

// send queues a frame for the writer. It waits up to cmdWSSendTimeout for
// room (back-pressure); a writer stalled that long fails the session.
func (s *cmdSession) send(opcode byte, data []byte, result chan error) error {
	select {
	case <-s.done:
		return errCmdWSClosed
	default:
	}
	t := time.NewTimer(cmdWSSendTimeout)
	defer t.Stop()
	select {
	case s.out <- wsOutFrame{opcode: opcode, data: data, result: result}:
		return nil
	case <-s.done:
		return errCmdWSClosed
	case <-t.C:
		s.fail(errCmdWSBackpressure)
		return errCmdWSBackpressure
	}
}

// sendSync queues a frame and waits until it has been written.
func (s *cmdSession) sendSync(opcode byte, data []byte) error {
	res := make(chan error, 1)
	if err := s.send(opcode, data, res); err != nil {
		return err
	}
	select {
	case err := <-res:
		return err
	case <-s.done:
		// The writer may have written it just before stopping.
		select {
		case err := <-res:
			return err
		default:
			return errCmdWSClosed
		}
	}
}

// sendJSON marshals v and queues it as a text frame.
func (s *cmdSession) sendJSON(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.send(0x1, data, nil)
}

// writeLoop is the only goroutine writing on the connection.
func (s *cmdSession) writeLoop() {
	for {
		select {
		case <-s.done:
			return
		case f := <-s.out:
			_ = s.ws.conn.SetWriteDeadline(time.Now().Add(cmdWSWriteTimeout))
			err := s.ws.WriteFrame(f.opcode, f.data)
			if f.result != nil {
				f.result <- err
			}
			if err != nil {
				s.fail(fmt.Errorf("write: %w", err))
				return
			}
		}
	}
}

// readLoop reads the server frames. It never runs a slow operation itself:
// config frames go to the config worker, firewall commands to their own
// goroutine with a timeout, queued commands to their runner.
func (s *cmdSession) readLoop(rt *cmdRuntime) {
	for {
		if err := s.ws.conn.SetReadDeadline(time.Now().Add(cmdWSReadTimeout)); err != nil {
			s.fail(fmt.Errorf("set read deadline: %w", err))
			return
		}
		op, payload, err := s.ws.ReadFrame()
		if err != nil {
			s.fail(fmt.Errorf("read: %w", err))
			return
		}
		switch op {
		case 0x8: // close
			if len(payload) >= 2 {
				log.Printf("Command WS: server closed the channel (code %d)", int(payload[0])<<8|int(payload[1]))
			}
			s.fail(errCmdWSServerClosed)
			return
		case 0x9: // ping → pong
			if err := s.send(0xA, payload, nil); err != nil {
				return
			}
		case 0xA: // pong — ignore
		case 0x1: // text — JSON from server
			if !s.dispatch(rt, payload) {
				return
			}
		}
	}
}

// dispatch routes a server text frame. It returns false when the session ended
// while a frame was waiting for room in the config queue.
func (s *cmdSession) dispatch(rt *cmdRuntime, payload []byte) bool {
	var env struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		log.Printf("Command WS: malformed JSON: %v", err)
		return true
	}

	switch env.Type {
	case "config":
		select {
		case rt.config <- payload:
		case <-s.done:
			return false
		}

	case "firewall_list", "firewall_add", "firewall_delete", "firewall_toggle":
		s.startFirewallCommand(env.Type, env.ID, payload)

	case "command":
		s.startQueuedCommand(rt, payload)
	}
	return true
}

func cmdWSSession(cfg *Config, fw FirewallManager, rt *cmdRuntime) (connected bool, err error) {
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
		// Certificate failures get an explicit hint instead of a silent loop.
		return false, fmt.Errorf("connect %s: %s", wsBase, tlsHint(err))
	}

	s := newCmdSession(ws)
	writerDone := make(chan struct{})
	readerDone := make(chan struct{})
	go func() { defer close(writerDone); s.writeLoop() }()
	go func() { defer close(readerDone); s.readLoop(rt) }()
	defer func() {
		s.fail(errCmdWSClosed)
		clearCurrentCmdWS(s)
		<-writerDone
		// Best-effort close frame, bounded: the writer is gone, nothing else writes.
		_ = ws.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		ws.Close()
		<-readerDone
	}()

	log.Printf("Command WS: connected to %s", wsBase)

	// Send the first heartbeat immediately — registers/updates the device record
	// in the DB and receives the current config + any offline-queued command.
	if err := sendOGHeartbeat(s, cfg, fw); err != nil {
		return false, fmt.Errorf("initial heartbeat: %w", err)
	}

	// Expose the session to the update goroutine (update_status frames), and
	// deliver a failure recorded while disconnected (e.g. msiexec exit code).
	setCurrentCmdWS(s)
	flushPendingUpdateStatus(s)

	hbTicker := time.NewTicker(cmdWSHeartbeatInterval)
	defer hbTicker.Stop()
	flushTicker := time.NewTicker(cmdWSEventFlushInterval)
	defer flushTicker.Stop()

	for {
		select {
		case <-s.done:
			return true, sessionResult(s.Err())

		// ── Event queue flush (fixed 500 ms window) ────────────────────────────
		case <-flushTicker.C:
			if err := flushEventQueue(s, rt.events); err != nil {
				return true, fmt.Errorf("events flush: %w", err)
			}

		// ── Periodic full heartbeat ────────────────────────────────────────────
		case <-hbTicker.C:
			if err := sendOGHeartbeat(s, cfg, fw); err != nil {
				return true, fmt.Errorf("heartbeat send: %w", err)
			}
		}
	}
}

// sessionResult maps the error that ended a session: a close frame from the
// server is a clean end (nil).
func sessionResult(err error) error {
	if errors.Is(err, errCmdWSServerClosed) {
		return nil
	}
	return err
}

// flushEventQueue sends the queued events in frames of at most eventBatchMax.
// It sends at most what was queued when it started, so a continuous stream
// cannot starve the heartbeat. A batch that cannot be written goes back in
// front of the queue (with its dropped count) for the next session.
func flushEventQueue(s *cmdSession, q *eventQueue) error {
	remaining := q.Len()
	for {
		dropped := q.TakeDropped()
		var batch []AgentIpEvent
		if remaining > 0 {
			batch = q.PopBatch(eventBatchMax)
			remaining -= len(batch)
		}
		if len(batch) == 0 {
			// Nothing to carry the count: keep it for the next frame.
			q.Requeue(nil, dropped)
			return nil
		}
		data, err := json.Marshal(cmdEventsMsg{Type: "events", Events: batch, Dropped: dropped})
		if err != nil {
			log.Printf("Command WS: events batch dropped (marshal: %v)", err)
			continue
		}
		if err := s.sendSync(0x1, data); err != nil {
			q.Requeue(batch, dropped)
			return err
		}
		if dropped > 0 {
			log.Printf("Command WS: event queue full — %d oldest event(s) dropped", dropped)
		}
	}
}

// ── Firewall rule commands ────────────────────────────────────────────────────

var (
	// fwCommandMu runs one rule command at a time: the backends shell out to
	// netsh / nft / iptables, which must not interleave edits.
	fwCommandMu sync.Mutex
	// fwCommandSlots bounds the commands waiting or running.
	fwCommandSlots = make(chan struct{}, fwCommandMaxInFlight)
)

// startFirewallCommand runs a firewall rule command off the read loop and
// answers within fwCommandTimeout: a command that has not finished by then
// gets an error response (the server is still waiting), and its late result
// is discarded.
func (s *cmdSession) startFirewallCommand(cmdType, id string, payload []byte) {
	select {
	case fwCommandSlots <- struct{}{}:
	default:
		_ = s.sendJSON(FwResponse{Type: "firewall_response", ID: id,
			Platform: DetectFirewallRuleManager().PlatformName(),
			Error:    "agent busy: too many firewall commands in progress"})
		return
	}
	go func() {
		// The slot is released when the command itself ends, not when its
		// answer is sent: a hung command keeps its slot, so hung commands
		// cannot pile up goroutines behind fwCommandMu (beyond the cap the
		// agent answers "busy" at once).
		release := func() { <-fwCommandSlots }
		if data := runFirewallCommand(cmdType, id, payload, fwCommandTimeout, s.done, release); data != nil {
			_ = s.send(0x1, data, nil)
		}
	}()
}

// runFirewallCommand executes one command and returns the response to send,
// or nil when stop closed first. On timeout it returns an error response; the
// command itself keeps running in the background (an exec cannot be undone
// halfway) and keeps fwCommandMu until it ends. done (optional) is called
// once the command has ended, whatever was returned.
func runFirewallCommand(cmdType, id string, payload []byte, timeout time.Duration, stop <-chan struct{}, done func()) []byte {
	frm := DetectFirewallRuleManager()
	reply := make(chan []byte, 1)
	go func() {
		if done != nil {
			defer done()
		}
		defer func() {
			if r := recover(); r != nil {
				log.Printf("Firewall command %s panicked: %v", cmdType, r)
				if data, err := json.Marshal(FwResponse{Type: "firewall_response", ID: id,
					Platform: frm.PlatformName(), Error: "agent internal error"}); err == nil {
					select {
					case reply <- data:
					default:
					}
				}
			}
		}()
		fwCommandMu.Lock()
		defer fwCommandMu.Unlock()
		handleFirewallCommand(frm, cmdType, id, payload, func(data []byte) {
			select {
			case reply <- data:
			default:
			}
		})
	}()

	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case data := <-reply:
		return data
	case <-t.C:
		log.Printf("Firewall command %s (id %s) timed out after %s", cmdType, id, timeout)
		data, _ := json.Marshal(FwResponse{Type: "firewall_response", ID: id, Platform: frm.PlatformName(),
			Error: fmt.Sprintf("agent: %s timed out after %s", cmdType, timeout)})
		return data
	case <-stop:
		return nil
	}
}

// ── Queued commands (W14-1) ───────────────────────────────────────────────────
//
// W14+ servers deliver the agent command queue as
//   {"type":"command","id":"42","command":"restart","payload":{...}}
// to agents advertising capCmdQueue. The agent answers
//   {"type":"command_ack","id":"42","status":"acked"}
// on receipt, then "succeeded" or "failed" with a small result object. Older
// servers never send the frame and still deliver an uninstall in the config
// frame (applyOGConfig), which keeps working.

// capCmdQueue tells the server this agent takes "command" frames and answers
// "command_ack" frames.
const capCmdQueue = "cmdqueue"

const (
	cmdAckAcked     = "acked"
	cmdAckSucceeded = "succeeded"
	cmdAckFailed    = "failed"

	// queuedCmdMemory bounds the ids remembered to answer a re-delivered
	// command without running it twice.
	queuedCmdMemory = 64
	// restartDelay leaves the final acknowledgement time to leave the socket.
	restartDelay = 500 * time.Millisecond
	// windowsAgentServiceName is the SCM name of the agent service
	// (service_windows.go windowsServiceName, kept literal: that file is
	// Windows-only).
	windowsAgentServiceName = "ObliguardAgent"
)

// cmdCommandMsg is a queued command (server → agent).
type cmdCommandMsg struct {
	Type    string          `json:"type"` // "command"
	ID      string          `json:"id"`
	Command string          `json:"command"` // uninstall | restart | firewall_resync
	Payload json.RawMessage `json:"payload,omitempty"`
}

// cmdAckMsg acknowledges a queued command, then reports its outcome.
type cmdAckMsg struct {
	Type   string         `json:"type"` // "command_ack"
	ID     string         `json:"id"`
	Status string         `json:"status"` // acked | succeeded | failed
	Result map[string]any `json:"result,omitempty"`
}

// firewallResyncPayload carries the full ban list the agent must enforce.
type firewallResyncPayload struct {
	Bans *[]string `json:"bans"`
}

// Hooks replaced by the tests (the real ones restart or remove the agent).
var (
	prepareRestartFn  = prepareRestart
	launchUninstallFn = launchUninstallScript
	exitProcessFn     = os.Exit
)

// queuedCmds runs one queued command at a time and remembers the final
// acknowledgement of the last ones (by id): a command delivered again (its
// acknowledgement was lost) is answered without running twice.
var queuedCmds struct {
	run   sync.Mutex
	mu    sync.Mutex
	state map[string]*cmdAckMsg // nil value: running
	order []string
}

// beginQueuedCommand registers id. It returns (nil, true) for a new command,
// (ack, false) for one already finished, (nil, false) for one still running.
func beginQueuedCommand(id string) (*cmdAckMsg, bool) {
	queuedCmds.mu.Lock()
	defer queuedCmds.mu.Unlock()
	if queuedCmds.state == nil {
		queuedCmds.state = make(map[string]*cmdAckMsg)
	}
	if final, seen := queuedCmds.state[id]; seen {
		return final, false
	}
	queuedCmds.state[id] = nil
	queuedCmds.order = append(queuedCmds.order, id)
	for len(queuedCmds.order) > queuedCmdMemory {
		delete(queuedCmds.state, queuedCmds.order[0])
		queuedCmds.order = queuedCmds.order[1:]
	}
	return nil, true
}

// finishQueuedCommand records the final acknowledgement of id.
func finishQueuedCommand(id string, ack *cmdAckMsg) {
	queuedCmds.mu.Lock()
	if _, ok := queuedCmds.state[id]; ok {
		queuedCmds.state[id] = ack
	}
	queuedCmds.mu.Unlock()
}

// startQueuedCommand handles a "command" frame off the read loop.
func (s *cmdSession) startQueuedCommand(rt *cmdRuntime, payload []byte) {
	var msg cmdCommandMsg
	if err := json.Unmarshal(payload, &msg); err != nil || msg.ID == "" || len(msg.ID) > 64 {
		log.Printf("Command WS: malformed command frame ignored")
		return
	}
	final, isNew := beginQueuedCommand(msg.ID)
	if !isNew {
		if final != nil {
			_ = s.sendJSON(final) // re-delivered: answer again, never run twice
		}
		return
	}
	go func() {
		queuedCmds.run.Lock()
		defer queuedCmds.run.Unlock()
		runQueuedCommand(s, rt.cfg, rt.fw, &msg)
	}()
}

// sendCommandAck sends an acknowledgement; final ones are remembered.
func sendCommandAck(s *cmdSession, id, status string, result map[string]any, wait bool) error {
	ack := &cmdAckMsg{Type: "command_ack", ID: id, Status: status, Result: result}
	if status != cmdAckAcked {
		finishQueuedCommand(id, ack)
	}
	data, err := json.Marshal(ack)
	if err != nil {
		return err
	}
	if wait {
		return s.sendSync(0x1, data)
	}
	return s.send(0x1, data, nil)
}

// runQueuedCommand executes one queued command and reports its outcome.
func runQueuedCommand(s *cmdSession, cfg *Config, fw FirewallManager, msg *cmdCommandMsg) {
	log.Printf("Command WS: queued command %s (id %s)", msg.Command, msg.ID)
	_ = sendCommandAck(s, msg.ID, cmdAckAcked, nil, false)

	fail := func(format string, args ...any) {
		text := fmt.Sprintf(format, args...)
		log.Printf("Command WS: %s (id %s) failed: %s", msg.Command, msg.ID, text)
		_ = sendCommandAck(s, msg.ID, cmdAckFailed, map[string]any{"error": truncateUTF8(text, updateStatusMaxError)}, false)
	}

	switch msg.Command {
	case "firewall_resync":
		var p firewallResyncPayload
		if len(msg.Payload) > 0 {
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				fail("malformed payload: %v", err)
				return
			}
		}
		if p.Bans == nil {
			fail("the command carries no ban list")
			return
		}
		res, err := resyncFirewall(cfg, fw, *p.Bans)
		if err != nil {
			fail("%v", err)
			return
		}
		result := res.result()
		if res.Errors > 0 {
			result["error"] = fmt.Sprintf("%d firewall operation(s) failed", res.Errors)
			_ = sendCommandAck(s, msg.ID, cmdAckFailed, result, false)
			return
		}
		_ = sendCommandAck(s, msg.ID, cmdAckSucceeded, result, false)

	case "restart":
		restart, err := prepareRestartFn()
		if err != nil {
			fail("restart: %v", err)
			return
		}
		_ = sendCommandAck(s, msg.ID, cmdAckSucceeded, map[string]any{"message": "agent restarting"}, true)
		log.Printf("Command WS: restarting the agent")
		time.Sleep(restartDelay)
		restart()

	case "uninstall":
		if err := launchUninstallFn(cfg); err != nil {
			fail("uninstall: %v", err)
			return
		}
		_ = sendCommandAck(s, msg.ID, cmdAckSucceeded, map[string]any{"message": "uninstall script launched"}, true)
		log.Printf("Uninstall: script launched, shutting down agent...")
		exitProcessFn(0)

	default:
		fail("unknown command %q", msg.Command)
	}
}

// launchUninstallScript starts the detached uninstall script of this OS
// (uninstall.go) without exiting: the caller acknowledges first.
func launchUninstallScript(cfg *Config) error {
	log.Printf("Uninstall command received — initiating self-removal...")
	switch runtime.GOOS {
	case "windows":
		return handleWindowsUninstall(cfg)
	case "linux":
		return handleLinuxUninstall()
	case "darwin":
		return handleDarwinUninstall()
	case "freebsd":
		return handleFreeBSDUninstall()
	default:
		return fmt.Errorf("unsupported platform %q", runtime.GOOS)
	}
}

// prepareRestart readies an agent restart through its service manager and
// returns the step that performs it (run after the acknowledgement).
//   - Windows: a detached PowerShell child asks the SCM to restart the
//     service (a clean stop, then a start), after a short pause;
//   - elsewhere: the process re-executes its own binary in place (same PID:
//     systemd, launchd and rc.d keep tracking it; plain rc.local too).
func prepareRestart() (func(), error) {
	if runtime.GOOS == "windows" {
		c := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
			"Start-Sleep -Seconds 2; Restart-Service -Name '"+windowsAgentServiceName+"' -Force")
		detachCmd(c)
		if err := c.Start(); err != nil {
			return nil, err
		}
		_ = c.Process.Release()
		return func() {}, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return func() { restartWithNewBinary(exe) }, nil
}

// banApplyResult counts the operations of one ban delta.
type banApplyResult struct {
	Desired, Added, Removed, Errors int
}

func (r banApplyResult) result() map[string]any {
	return map[string]any{"desired": r.Desired, "added": r.Added, "removed": r.Removed, "errors": r.Errors}
}

// resyncFirewall re-applies the full ban list sent by the server: the
// enforced set is read back from the backend, the missing entries are banned,
// the extra ones lifted (nothing is re-added twice: some backends append a
// rule per call). Entries the ban-safety guard refuses are never enforced.
// Pending deltas are superseded and the rate limits are re-applied by the
// next config frame.
func resyncFirewall(cfg *Config, fw FirewallManager, bans []string) (banApplyResult, error) {
	want := banSafetyFor(cfg.ServerURL).Filter(bans)

	fwApplyMu.Lock()
	defer fwApplyMu.Unlock()
	takeBanDelta() // superseded by the full list

	current, err := fw.GetBannedIPs()
	if err != nil {
		return banApplyResult{}, fmt.Errorf("read the enforced bans: %w", err)
	}
	have := make(map[string]bool, len(current))
	for _, k := range canonicalBanList(current) {
		have[k] = true
	}
	wanted := make(map[string]bool, len(want))
	var add, remove []string
	for _, k := range want {
		wanted[k] = true
		if !have[k] {
			add = append(add, k)
		}
	}
	for k := range have {
		if !wanted[k] {
			remove = append(remove, k)
		}
	}
	sort.Strings(remove)

	res := applyBanDeltaLocked(fw, add, remove)
	res.Desired = len(want)

	rateLimitState.mu.Lock()
	rateLimitState.applied = false
	rateLimitState.mu.Unlock()

	log.Printf("Firewall resync: %d enforced, +%d banned, -%d unbanned (errors: %d)", res.Desired, res.Added, res.Removed, res.Errors)
	return res, nil
}

// ── Config application ────────────────────────────────────────────────────────

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

	// Enrolment marker (config.json now wins over --url/--key) and the
	// Windows firewall backend switch, which migrates in the background.
	applyAgentConfigFrame(cfg, fw, msg.FirewallBackend)

	// Ban delta: handed to the firewall worker (Flush can be slow on Windows
	// with many rules). The add list goes through the ban-safety guard first
	// (bansafety.go): no self-ban, no ban of the server or gateway, no range
	// wider than the floors.
	if msg.BanList != nil && (len(msg.BanList.Add) > 0 || len(msg.BanList.Remove) > 0) {
		guard := banSafetyFor(cfg.ServerURL)
		queueBanDelta(fw, guard.Filter(msg.BanList.Add), canonicalBanList(msg.BanList.Remove))
	}

	// Per-IP rate limiting: only when the server sent the field (absent =
	// unchanged, [] = clear). See applyRateLimitsFrame.
	applyRateLimitsFrame(cfg, fw, msg.RateLimits)

	// Update log watcher service configs
	if lw != nil && len(msg.Services) > 0 {
		lw.UpdateConfigs(msg.Services)
		cfg.ServiceConfigs = msg.Services
		_ = saveConfig(cfg)
	}

	// Auto-update if newer version available. Runs in the background behind
	// the in-progress guard: the read loop keeps serving ban deltas and
	// firewall commands during the download.
	if msg.LatestVersion != "" {
		startUpdateIfNewer(cfg, msg.LatestVersion)
	}
}

// ── Firewall worker ───────────────────────────────────────────────────────────

// banDelta is the coalescing mailbox of the single firewall worker: the last
// operation requested for an entry wins (true = ban, false = unban). Config
// frames arriving faster than a slow Flush merge here instead of piling up
// goroutines on the backend.
var banDelta struct {
	mu     sync.Mutex
	ops    map[string]bool
	signal chan struct{}
	once   sync.Once
}

// queueBanDelta records a delta (adds already guard-filtered, both lists
// canonical) and wakes the worker, started on first use.
func queueBanDelta(fw FirewallManager, add, remove []string) {
	if len(add) == 0 && len(remove) == 0 {
		return
	}
	banDelta.mu.Lock()
	if banDelta.ops == nil {
		banDelta.ops = make(map[string]bool)
	}
	for _, k := range add {
		banDelta.ops[k] = true
	}
	for _, k := range remove {
		banDelta.ops[k] = false
	}
	banDelta.mu.Unlock()

	banDelta.once.Do(func() {
		banDelta.signal = make(chan struct{}, 1)
		go banWorker(fw)
	})
	select {
	case banDelta.signal <- struct{}{}:
	default: // a wake-up is already pending
	}
}

// takeBanDelta returns the pending operations, sorted (bans first), and
// empties the mailbox.
func takeBanDelta() (add, remove []string) {
	banDelta.mu.Lock()
	ops := banDelta.ops
	banDelta.ops = nil
	banDelta.mu.Unlock()
	for k, ban := range ops {
		if ban {
			add = append(add, k)
		} else {
			remove = append(remove, k)
		}
	}
	sort.Strings(add)
	sort.Strings(remove)
	return add, remove
}

// banWorker applies the pending deltas, one Flush per wake-up.
func banWorker(fw FirewallManager) {
	for range banDelta.signal {
		add, remove := takeBanDelta()
		if len(add) == 0 && len(remove) == 0 {
			continue
		}
		applyBanDelta(fw, add, remove)
	}
}

// applyBanDelta runs one delta against the backend, serialized with the
// unsafe-ban purge and the firewall resync.
func applyBanDelta(fw FirewallManager, add, remove []string) {
	fwApplyMu.Lock()
	defer fwApplyMu.Unlock()
	res := applyBanDeltaLocked(fw, add, remove)
	if res.Added > 0 || res.Removed > 0 || res.Errors > 0 {
		log.Printf("Firewall: +%d banned, -%d unbanned (errors: %d)", res.Added, res.Removed, res.Errors)
	}
}

// applyBanDeltaLocked bans add, lifts remove and flushes (fwApplyMu held).
// A failed flush counts as one error.
func applyBanDeltaLocked(fw FirewallManager, add, remove []string) banApplyResult {
	var res banApplyResult
	for _, ip := range add {
		if err := fw.BanIP(ip); err != nil {
			res.Errors++
		} else {
			res.Added++
		}
	}
	for _, ip := range remove {
		if err := fw.UnbanIP(ip); err != nil {
			res.Errors++
		} else {
			res.Removed++
		}
	}
	if err := fw.Flush(); err != nil {
		res.Errors++
		log.Printf("Firewall flush: %v", err)
	}
	return res
}

// fwApplyMu serializes ban-delta application and the unsafe-ban purge.
var fwApplyMu sync.Mutex

// purgeUnsafeBans lifts, once per process start, the bans already enforced
// that the ban-safety guard refuses (left by an older agent, or made unsafe by
// an address change). The server re-sends them as adds, which the guard then
// refuses (logged once).
func purgeUnsafeBans(cfg *Config, fw FirewallManager) {
	fwApplyMu.Lock()
	defer fwApplyMu.Unlock()
	current, err := fw.GetBannedIPs()
	if err != nil || len(current) == 0 {
		return
	}
	unsafe := banSafetyFor(cfg.ServerURL).Unsafe(current)
	if len(unsafe) == 0 {
		return
	}
	for _, k := range unsafe {
		_ = fw.UnbanIP(k)
	}
	if err := fw.Flush(); err != nil {
		log.Printf("Firewall flush: %v", err)
	}
	log.Printf("Ban safety: lifted %d unsafe ban(s) found in the firewall", len(unsafe))
}

// ── Rate limits ───────────────────────────────────────────────────────────────

// capRateLimit tells the server that the active backend enforces per-IP rate
// limits (nftables, iptables, ufw). Windows, pf and firewalld do not advertise
// it: the UI shows the limits as unsupported on those agents.
const capRateLimit = "ratelimit"

// rateLimitCapabilities lists the rate-limit feature of the active backend,
// appended to the heartbeat capabilities.
func rateLimitCapabilities(fw FirewallManager) []string {
	if fw.IsRateLimitSupported() {
		return []string{capRateLimit}
	}
	return nil
}

// rateLimitExempter is implemented by backends whose rate-limit escalation
// bans in the kernel (nftables, iptables, ufw): the addresses the ban-safety guard protects
// (server, own addresses, gateway) are kept out of rate limiting entirely.
type rateLimitExempter interface {
	SetRateLimitExempt(addrs []string)
}

// rateLimitState remembers the last rule set applied, so an unchanged set
// delivered with every heartbeat is not re-applied (re-applying rebuilds the
// chains and resets the per-IP meters).
var rateLimitState struct {
	mu              sync.Mutex
	applied         bool
	key             string
	unsupportedSeen bool
}

// applyRateLimitsFrame applies the rateLimits field of a config frame: nil
// (field absent) leaves the enforced limits unchanged, an empty list clears
// them, an identical set is skipped. A failed apply is retried on the next frame.
func applyRateLimitsFrame(cfg *Config, fw FirewallManager, rules *[]RateLimitRule) {
	if rules == nil {
		return
	}
	rateLimitState.mu.Lock()
	defer rateLimitState.mu.Unlock()

	if !fw.IsRateLimitSupported() {
		if len(*rules) > 0 && !rateLimitState.unsupportedSeen {
			rateLimitState.unsupportedSeen = true
			log.Printf("Firewall: %d rate limit rule(s) received but the %s backend cannot enforce them — ignored", len(*rules), fw.Name())
		}
		return
	}

	var exempt []string
	ex, canExempt := fw.(rateLimitExempter)
	if canExempt {
		exempt = rateLimitExemptAddrs(banSafetyFor(cfg.ServerURL))
	}
	key := rateLimitKey(*rules, exempt)
	if rateLimitState.applied && rateLimitState.key == key {
		return
	}
	if canExempt {
		ex.SetRateLimitExempt(exempt)
	}
	if err := fw.ApplyRateLimits(*rules); err != nil {
		rateLimitState.applied = false
		log.Printf("Firewall: apply rate limits: %v", err)
		return
	}
	rateLimitState.applied = true
	rateLimitState.key = key
	if len(*rules) == 0 {
		log.Printf("Firewall: rate limits cleared")
	} else {
		log.Printf("Firewall: applied %d rate limit rule(s)", len(*rules))
	}
}

// rateLimitKey identifies a rule set plus its exemptions (order-sensitive:
// the server resolves rules in a stable order).
func rateLimitKey(rules []RateLimitRule, exempt []string) string {
	data, err := json.Marshal(struct {
		Rules  []RateLimitRule `json:"r"`
		Exempt []string        `json:"e"`
	}{rules, exempt})
	if err != nil {
		return ""
	}
	return string(data)
}

// rateLimitExemptAddrs returns the IPv4 addresses the ban-safety guard
// protects (server, own interfaces, default gateways), sorted and unique.
// Loopback is left out (never rate limited: rules match inbound traffic).
func rateLimitExemptAddrs(g *banSafety) []string {
	g.mu.Lock()
	g.refreshLocked()
	seen := make(map[string]bool)
	var out []string
	for _, p := range g.protected {
		if !p.addr.Is4() || p.addr.IsLoopback() || p.addr.IsUnspecified() {
			continue
		}
		s := p.addr.String()
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	g.mu.Unlock()
	sort.Strings(out)
	return out
}

// ── Outgoing messages ─────────────────────────────────────────────────────────

// heartbeatCapabilities lists every optional protocol feature of this agent
// and its active backend (sent in each heartbeat).
func heartbeatCapabilities(fw FirewallManager) []string {
	caps := append(agentCapabilities(), firewallCapabilities(fw)...)
	caps = append(caps, firewallRuleCapabilities()...)
	caps = append(caps, rateLimitCapabilities(fw)...)
	return append(caps, capCmdQueue)
}

// sendOGHeartbeat sends the status heartbeat and waits until it is written.
func sendOGHeartbeat(s *cmdSession, cfg *Config, fw FirewallManager) error {
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
		Capabilities:   heartbeatCapabilities(fw),
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal heartbeat: %w", err)
	}
	return s.sendSync(0x1, data)
}

// ── Update status reporting ───────────────────────────────────────────────────

var (
	cmdWSMu      sync.Mutex
	cmdWSCurrent *cmdSession
	// pendingUpdateStatus holds the last "failed" report that could not be
	// sent (no session); delivered right after the next initial heartbeat.
	pendingUpdateStatus *cmdUpdateStatusMsg
)

func setCurrentCmdWS(s *cmdSession) {
	cmdWSMu.Lock()
	cmdWSCurrent = s
	cmdWSMu.Unlock()
}

func clearCurrentCmdWS(s *cmdSession) {
	cmdWSMu.Lock()
	if cmdWSCurrent == s {
		cmdWSCurrent = nil
	}
	cmdWSMu.Unlock()
}

func newUpdateStatusMsg(target, phase, errMsg string) *cmdUpdateStatusMsg {
	if len(errMsg) > updateStatusMaxError {
		// Cut on a rune boundary (x509 / OS messages may be localised).
		errMsg = truncateUTF8(errMsg, updateStatusMaxError)
	}
	return &cmdUpdateStatusMsg{Type: "update_status", TargetVersion: target, Phase: phase, Error: errMsg}
}

// queueUpdateStatus keeps a report for the next WS session.
func queueUpdateStatus(target, phase, errMsg string) {
	cmdWSMu.Lock()
	pendingUpdateStatus = newUpdateStatusMsg(target, phase, errMsg)
	cmdWSMu.Unlock()
}

// sendUpdateStatus reports an update step on the current WS session. Progress
// steps are best effort; a failure that cannot be sent now is queued.
func sendUpdateStatus(target, phase, errMsg string) {
	msg := newUpdateStatusMsg(target, phase, errMsg)
	cmdWSMu.Lock()
	s := cmdWSCurrent
	cmdWSMu.Unlock()
	if s != nil {
		if data, err := json.Marshal(msg); err == nil && s.sendSync(0x1, data) == nil {
			return
		}
	}
	if phase == updatePhaseFailed {
		cmdWSMu.Lock()
		pendingUpdateStatus = msg
		cmdWSMu.Unlock()
	}
}

// flushPendingUpdateStatus sends the queued report, if any, on s.
func flushPendingUpdateStatus(s *cmdSession) {
	cmdWSMu.Lock()
	msg := pendingUpdateStatus
	pendingUpdateStatus = nil
	cmdWSMu.Unlock()
	if msg == nil {
		return
	}
	data, err := json.Marshal(msg)
	if err == nil {
		err = s.sendSync(0x1, data)
	}
	if err != nil {
		cmdWSMu.Lock()
		if pendingUpdateStatus == nil {
			pendingUpdateStatus = msg
		}
		cmdWSMu.Unlock()
	}
}
