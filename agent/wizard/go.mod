// Isolated module for the offline install wizards (Windows GUI + Linux CLI).
//
// Kept OUT of the main agent module (github.com/obliguard/agent) on purpose:
//   - The Windows wizard pulls in the lxn/walk GUI toolkit, which we don't want
//     bloating the agent binary or its go.sum.
//   - Each wizard //go:embed's a build artifact (the MSI / the linux agent
//     binary) that only exists at wizard-build time — keeping this a separate
//     module means `go build ./...` of the agent stays green without them.
//
// Build via agent/build-wizard.bat (Windows) / build-wizard-linux.bat. Those
// scripts copy the embed artifact in, run `go mod tidy` (to populate go.sum),
// then build the matching sub-package.
module obliguard-installer-wizard

go 1.22

require github.com/lxn/walk v0.0.0-20210112085537-c389da54e794

require (
	github.com/lxn/win v0.0.0-20210218163916-a377121e959e // indirect
	gopkg.in/Knetic/govaluate.v3 v3.0.0 // indirect
)
