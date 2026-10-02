//go:build windows

package main

import (
	"log"
	"os"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// restartWithNewBinary on Windows stops the agent so the detached update script
// written by applyWindowsMSIUpdate() can install the MSI:
//
//  1. Old exe downloads and verifies the MSI in %PROGRAMDATA%\ObliguardAgent\update
//  2. Old exe writes obliguard-msi-update.bat next to it and launches it detached
//  3. Old exe calls restartWithNewBinary() → stop request through the SCM
//  4. The script waits for STOPPED, runs msiexec /i ... /quiet, captures the
//     exit code; on failure it records it and starts the previous service again
//  5. The script deletes the MSI and itself
//
// The stop goes through the SCM (not os.Exit): a process that exits without
// reporting SERVICE_STOPPED is a service failure, and the recovery actions of
// the MSI (restart on failure) would restart the old agent in the middle of
// msiexec. A stop requested through the SCM is a clean stop: no recovery action.
func restartWithNewBinary(_ string) {
	isService, err := svc.IsWindowsService()
	if err == nil && isService {
		if err := requestServiceStop(); err == nil {
			// The SCM stops the service (Execute returns, the process exits)
			// within seconds; exit anyway if it has not after a minute.
			time.Sleep(60 * time.Second)
			log.Printf("Auto-update: service still running 60 s after the stop request — exiting")
		} else {
			log.Printf("Auto-update: SCM stop request failed (%v) — exiting", err)
		}
	}
	os.Exit(0)
}

// requestServiceStop asks the SCM to stop the ObliguardAgent service (this
// process). Called from a worker goroutine; the SCM delivers the stop to
// agentSvc.Execute, which returns.
func requestServiceStop() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(windowsServiceName)
	if err != nil {
		return err
	}
	defer s.Close()
	_, err = s.Control(svc.Stop)
	return err
}
