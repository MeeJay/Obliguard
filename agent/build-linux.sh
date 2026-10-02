#!/usr/bin/env bash
set -euo pipefail

# Build Obliguard Agent for Linux + FreeBSD.
# Runs on a Linux host — called remotely via SSH from 000-RegularUpdate.bat.

cd "$(dirname "$0")"
VERSION=$(cat VERSION 2>/dev/null || echo "0.0.0")

echo "Building Obliguard Agent v${VERSION} for Linux + FreeBSD..."

export CGO_ENABLED=0
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

echo "  [1/3] linux/amd64..."
GOOS=linux GOARCH=amd64 go build \
  -ldflags="-s -w -X main.agentVersion=${VERSION}" \
  -o dist/obliguard-agent-linux-amd64 .

echo "  [2/3] linux/arm64..."
GOOS=linux GOARCH=arm64 go build \
  -ldflags="-s -w -X main.agentVersion=${VERSION}" \
  -o dist/obliguard-agent-linux-arm64 .

echo "  [3/3] freebsd/amd64..."
GOOS=freebsd GOARCH=amd64 go build \
  -ldflags="-s -w -X main.agentVersion=${VERSION}" \
  -o dist/obliguard-agent-freebsd-amd64 .

write_manifest "$VERSION" \
  dist/obliguard-agent-linux-amd64 dist/obliguard-agent-linux-arm64 dist/obliguard-agent-freebsd-amd64

echo "Done. Binaries:"
ls -lh dist/obliguard-agent-linux-* dist/obliguard-agent-freebsd-*
