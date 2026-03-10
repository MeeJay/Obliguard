package main

import (
	"regexp"
	"strings"
)

var uuidRe = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var zeroUUID = "00000000-0000-0000-0000-000000000000"

// normaliseUUID lowercases and validates a UUID string.
// Returns "" if the string is not a valid UUID or is the all-zeros sentinel.
func normaliseUUID(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == zeroUUID || !uuidRe.MatchString(s) {
		return ""
	}
	return s
}

// getMachineUUID returns a stable hardware UUID for this machine.
// Calls the platform-specific readMachineUUID() and returns "" if the
// platform doesn't support it or the result is invalid.
func getMachineUUID() string {
	return readMachineUUID()
}
