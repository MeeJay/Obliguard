//go:build windows

package main

import (
	"fmt"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// lastWinSecRecordId tracks the highest Security event RecordId processed.
// Atomic so the poller goroutine and the initialiser don't race.
var lastWinSecRecordId int64

// startPlatformEventLogWatcher initialises the Windows Security Event Log
// cursor and starts a goroutine that polls for new auth events every 15 s.
// Called once from mainLoop; events are injected directly into the LogWatcher.
func startPlatformEventLogWatcher(lw *LogWatcher) {
	// Prime the cursor to the current latest RecordId so we only report
	// events that occur AFTER the agent starts — avoids a flood of historical
	// failures on first run.
	initWindowsEventCursor()

	go func() {
		log.Printf("Windows Security Event Log watcher started (EventID 4625/4624)")
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			for _, e := range pollWindowsSecurityEvents() {
				lw.addEvent(e)
			}
		}
	}()
}

// initWindowsEventCursor queries the single most recent relevant event to
// set the cursor, so the first real poll only returns events newer than now.
func initWindowsEventCursor() {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		`try { $e = Get-WinEvent -FilterHashtable @{LogName='Security';Id=4625,4624} -MaxEvents 1 -EA SilentlyContinue; if ($e) { $e.RecordId } else { 0 } } catch { 0 }`,
	).Output()
	if err != nil {
		return
	}
	id, _ := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if id > 0 {
		atomic.StoreInt64(&lastWinSecRecordId, id)
		log.Printf("Windows Event Log cursor initialised at RecordId %d", id)
	}
}

// pollWindowsSecurityEvents fetches Security events (4625 = failed logon,
// 4624 type 10 = successful RDP) newer than the stored cursor.
func pollWindowsSecurityEvents() []AgentIpEvent {
	lastId := atomic.LoadInt64(&lastWinSecRecordId)

	// PowerShell script: query Security log for events newer than lastId.
	// 4625  — failed logon (any type): captures RDP, SMB, network logons.
	// 4624  — successful logon, type 10 only (RemoteInteractive = RDP).
	// Skips loopback addresses and machine accounts (ending with $).
	script := fmt.Sprintf(`
$lastId = [int64]%d
$out = @()
try {
    $evts = Get-WinEvent -FilterHashtable @{LogName='Security';Id=4625,4624} -MaxEvents 500 -ErrorAction SilentlyContinue |
            Where-Object { $_.RecordId -gt $lastId }
    foreach ($e in $evts) {
        $x = [xml]$e.ToXml()
        $d = @{}
        $x.Event.EventData.Data | ForEach-Object { if ($_.Name) { $d[$_.Name] = $_.'#text' } }
        $ip    = $d['IpAddress']
        $user  = $d['TargetUserName']
        $ltype = $d['LogonType']
        if (-not $ip -or $ip -eq '-' -or $ip -eq '::1' -or $ip -eq '127.0.0.1') { continue }
        # Skip machine accounts (end with $) — they are normal domain traffic
        if ($user -and $user.EndsWith('$')) { continue }
        # 4624: only RemoteInteractive (type 10)
        if ($e.Id -eq 4624 -and $ltype -ne '10') { continue }
        $out += "$($e.RecordId)|$($e.Id)|$ip|$user"
    }
} catch {}
$out | Sort-Object { [int64]($_ -split '\|')[0] }
`, lastId)

	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil || len(strings.TrimSpace(string(out))) == 0 {
		return nil
	}

	var events []AgentIpEvent
	var maxId int64 = lastId

	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 4)
		if len(parts) < 4 {
			continue
		}
		recordId, _ := strconv.ParseInt(parts[0], 10, 64)
		eventId := parts[1]
		ip := strings.TrimSpace(parts[2])
		username := strings.TrimSpace(parts[3])

		if recordId > maxId {
			maxId = recordId
		}

		evType := "auth_failure"
		if eventId == "4624" {
			evType = "auth_success"
		}
		rawLog := fmt.Sprintf("EventID:%s Account Name: %s Source Network Address: %s", eventId, username, ip)
		events = append(events, makeEvent(ip, username, "rdp", evType, rawLog))
	}

	if maxId > lastId {
		atomic.StoreInt64(&lastWinSecRecordId, maxId)
	}
	return events
}
