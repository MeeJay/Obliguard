#!/usr/bin/env bash
# build.sh — Build all Obliguard agent binaries for distribution.
#
# Usage:
#   ./build.sh              # version read from agent/VERSION file
#   ./build.sh 1.6.0        # explicit version override
#
# Output binaries land in dist/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Determine version ─────────────────────────────────────────────────────────
if [[ $# -ge 1 ]]; then
  VERSION="$1"
elif [[ -f "VERSION" ]]; then
  VERSION="$(cat VERSION | tr -d '[:space:]')"
else
  echo "ERROR: no version argument and no VERSION file found." >&2
  exit 1
fi

if [[ -z "$VERSION" ]]; then
  echo "ERROR: version is empty." >&2
  exit 1
fi

LDFLAGS="-X main.agentVersion=${VERSION}"

echo "Building Obliguard Agent v${VERSION}..."
mkdir -p dist

# ── Cross-compile ─────────────────────────────────────────────────────────────
GOOS=linux  GOARCH=amd64 go build -ldflags="$LDFLAGS" -o dist/obliguard-agent-linux-amd64  . && echo "  ✓ linux/amd64"
GOOS=linux  GOARCH=arm64 go build -ldflags="$LDFLAGS" -o dist/obliguard-agent-linux-arm64  . && echo "  ✓ linux/arm64"
GOOS=darwin GOARCH=amd64 go build -ldflags="$LDFLAGS" -o dist/obliguard-agent-darwin-amd64 . && echo "  ✓ darwin/amd64"
GOOS=darwin GOARCH=arm64 go build -ldflags="$LDFLAGS" -o dist/obliguard-agent-darwin-arm64 . && echo "  ✓ darwin/arm64"
GOOS=windows GOARCH=amd64 go build -ldflags="$LDFLAGS" -o dist/obliguard-agent.exe        . && echo "  ✓ windows/amd64"

echo ""
echo "Done. All binaries built with agentVersion=${VERSION}"
echo "Note: MSI (dist/obliguard-agent.msi) must be built separately via WiX."
