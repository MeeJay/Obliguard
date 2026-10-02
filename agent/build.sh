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

# ── Build manifest (dist/manifest.json) ───────────────────────────────────────
# The server advertises an update only to the os-arch whose artifact embeds the
# served version (agent/VERSION) and sends each file's SHA-256 on download.
# write_manifest <version> <file>... merges these artifacts into
# dist/manifest.json, keeping the entries of artifacts built elsewhere.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

write_manifest() {
  local version="$1"; shift
  local manifest="dist/manifest.json" tmp="dist/.manifest.json.tmp" entries="" name line f
  if [ -f "$manifest" ]; then
    while IFS= read -r line; do
      name="$(printf '%s\n' "$line" | sed -n 's/^    "\([^"]*\)": {.*$/\1/p')"
      [ -n "$name" ] || continue
      for f in "$@"; do
        if [ "$(basename "$f")" = "$name" ]; then continue 2; fi
      done
      entries="${entries}${line%,}"$'\n'
    done < "$manifest"
  fi
  for f in "$@"; do
    [ -f "$f" ] || continue
    entries="${entries}    \"$(basename "$f")\": {\"sha256\": \"$(sha256_of "$f")\", \"size\": $(wc -c < "$f" | tr -d ' '), \"version\": \"${version}\"}"$'\n'
  done
  {
    printf '{\n  "version": "%s",\n  "artifacts": {\n' "$version"
    printf '%s' "$entries" | sed '/^$/d' | sort | sed '$!s/$/,/'
    printf '  }\n}\n'
  } > "$tmp"
  mv "$tmp" "$manifest"
  echo "Manifest: $manifest"
}

# ── Cross-compile ─────────────────────────────────────────────────────────────
GOOS=linux  GOARCH=amd64 go build -ldflags="$LDFLAGS" -o dist/obliguard-agent-linux-amd64  . && echo "  ✓ linux/amd64"
GOOS=linux  GOARCH=arm64 go build -ldflags="$LDFLAGS" -o dist/obliguard-agent-linux-arm64  . && echo "  ✓ linux/arm64"
GOOS=darwin GOARCH=amd64 go build -ldflags="$LDFLAGS" -o dist/obliguard-agent-darwin-amd64 . && echo "  ✓ darwin/amd64"
GOOS=darwin GOARCH=arm64 go build -ldflags="$LDFLAGS" -o dist/obliguard-agent-darwin-arm64 . && echo "  ✓ darwin/arm64"
GOOS=windows GOARCH=amd64 go build -ldflags="$LDFLAGS" -o dist/obliguard-agent.exe        . && echo "  ✓ windows/amd64"

write_manifest "$VERSION" \
  dist/obliguard-agent-linux-amd64 dist/obliguard-agent-linux-arm64 \
  dist/obliguard-agent-darwin-amd64 dist/obliguard-agent-darwin-arm64 \
  dist/obliguard-agent.exe

echo ""
echo "Done. All binaries built with agentVersion=${VERSION}"
echo "Note: MSI (dist/obliguard-agent.msi) must be built separately via WiX."
