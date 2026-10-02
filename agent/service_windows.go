//go:build windows

package main

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// windowsServiceName is the SCM name registered by the MSI (product.wxs).
const windowsServiceName = "ObliguardAgent"

type agentSvc struct {
	urlFlag *string
	keyFlag *string
}

// Execute implements svc.Handler — called by the Windows SCM when the service starts.
func (s *agentSvc) Execute(_ []string, r <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	// In service mode, stderr goes to NUL — redirect log to a file so it's readable.
	// Log file: C:\ProgramData\ObliguardAgent\agent.log
	logPath := filepath.Join(configDir, "agent.log")
	if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644); err == nil {
		log.SetOutput(f)
	}

	status <- svc.Status{State: svc.StartPending}

	cfg := setupConfig(*s.urlFlag, *s.keyFlag)

	// Make sure the SCM restarts the agent if it ever dies (MSI installs
	// before this version registered no recovery actions).
	ensureRecoveryActions()

	// A previous self-update whose msiexec failed left its exit code behind
	// (update script, main.go): report it as update_status "failed" once the
	// command channel is up.
	loadUpdateFailureMarker()

	// Signal SERVICE_RUNNING — the MSI (ServiceControl Wait="yes") unblocks here.
	status <- svc.Status{
		State:   svc.Running,
		Accepts: svc.AcceptStop | svc.AcceptShutdown,
	}

	// Run main loop in background goroutine
	go mainLoop(cfg)

	// Wait for stop/shutdown command from SCM
	for {
		c := <-r
		switch c.Cmd {
		case svc.Stop, svc.Shutdown:
			log.Printf("Obliguard Agent stopping...")
			status <- svc.Status{State: svc.StopPending}
			return false, 0
		case svc.Interrogate:
			status <- c.CurrentStatus
		}
	}
}

// runAsService detects Windows service mode and runs the SCM handler.
// Returns true if running as a service (caller should not continue).
func runAsService(urlFlag, keyFlag *string) bool {
	isService, err := svc.IsWindowsService()
	if err != nil {
		log.Fatalf("Failed to detect service mode: %v", err)
	}
	if !isService {
		return false
	}
	if err := svc.Run(windowsServiceName, &agentSvc{urlFlag, keyFlag}); err != nil {
		log.Fatalf("Service run failed: %v", err)
	}
	return true
}

// ensureRecoveryActions sets the SCM failure actions of the service: restart
// after 1 minute on the first, second and subsequent failures, failure count
// reset after one day. Re-applied at every start, so installs upgraded from a
// version without recovery actions get them too. A stop requested through the
// SCM (self-update, restart_windows.go) is a clean stop and does not trigger
// them.
func ensureRecoveryActions() {
	m, err := mgr.Connect()
	if err != nil {
		log.Printf("Service recovery: SCM connect failed: %v", err)
		return
	}
	defer m.Disconnect()
	s, err := m.OpenService(windowsServiceName)
	if err != nil {
		log.Printf("Service recovery: open service failed: %v", err)
		return
	}
	defer s.Close()
	actions := []mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: time.Minute},
		{Type: mgr.ServiceRestart, Delay: time.Minute},
		{Type: mgr.ServiceRestart, Delay: time.Minute},
	}
	if err := s.SetRecoveryActions(actions, uint32((24 * time.Hour).Seconds())); err != nil {
		log.Printf("Service recovery: set failure actions failed: %v", err)
	}
}
