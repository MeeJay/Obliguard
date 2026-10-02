#!/usr/bin/env bash
# =============================================================================
# Obliguard Agent — Native macOS build (CGO_ENABLED=1)
#
# Why native? gopsutil's cpu.Percent(percpu=true) calls host_processor_info
# (Mach API) which requires CGO. Cross-compiled binaries skip this and fall
# back to `top`, which only gives overall CPU % — no per-core bars in the UI.
#
# This script must be run ON a Mac (Apple Silicon or Intel). It builds BOTH
# architectures: the native arch via CGO, and the other arch via clang -arch.
#
# Usage (run from the agent/ directory, or anywhere — it self-locates):
#   bash agent/build-mac.sh
#   # or from inside agent/:
#   bash build-mac.sh
#
# After running, copy both binaries to the Windows/Unraid build host at:
#   agent/dist/obliguard-agent-darwin-arm64
#   agent/dist/obliguard-agent-darwin-amd64
# Then run 000-RegularUpdate.bat (or 00-A2-docker-agent-push.bat) to rebuild.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Architecture detection ────────────────────────────────────────────────────

NATIVE_GOARCH="$(go env GOARCH 2>/dev/null || uname -m | sed 's/x86_64/amd64/')"
case "$NATIVE_GOARCH" in
  arm64) CROSS_GOARCH="amd64"; CROSS_CLANG_ARCH="x86_64" ;;
  amd64) CROSS_GOARCH="arm64"; CROSS_CLANG_ARCH="arm64"  ;;
  *)
    echo "ERROR: Unsupported Go architecture: $NATIVE_GOARCH" >&2
    echo "       Run this script on an Apple Silicon (arm64) or Intel (amd64) Mac." >&2
    exit 1
    ;;
esac

# ── Version ───────────────────────────────────────────────────────────────────

VERSION=""
if [ -f "VERSION" ]; then
  VERSION="$(tr -d '[:space:]' < VERSION)"
fi
if [ -z "$VERSION" ] || [ "$VERSION" = "dev" ]; then
  echo "WARNING: Could not read a release version from agent/VERSION, using 'dev'."
  echo "         Run 00-A0-bump-agent.bat first to set the version."
  VERSION="dev"
fi

OUT_DIR="dist"
mkdir -p "$OUT_DIR"

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

BUILT=()

# ── Build native arch (full CGO) ──────────────────────────────────────────────

echo "Building Obliguard Agent $VERSION for darwin/$NATIVE_GOARCH (native, CGO_ENABLED=1)..."
CGO_ENABLED=1 GOOS=darwin GOARCH="$NATIVE_GOARCH" \
  go build \
    -ldflags="-s -w -X main.agentVersion=$VERSION" \
    -o "$OUT_DIR/obliguard-agent-darwin-$NATIVE_GOARCH" \
    .
echo "  → $OUT_DIR/obliguard-agent-darwin-$NATIVE_GOARCH"
BUILT+=("$OUT_DIR/obliguard-agent-darwin-$NATIVE_GOARCH")

# ── Build cross arch (clang -arch) ────────────────────────────────────────────

echo ""
echo "Building Obliguard Agent $VERSION for darwin/$CROSS_GOARCH (cross, clang -arch $CROSS_CLANG_ARCH)..."
if CGO_ENABLED=1 GOOS=darwin GOARCH="$CROSS_GOARCH" \
     CGO_CFLAGS="-arch $CROSS_CLANG_ARCH" \
     CGO_LDFLAGS="-arch $CROSS_CLANG_ARCH" \
     go build \
       -ldflags="-s -w -X main.agentVersion=$VERSION" \
       -o "$OUT_DIR/obliguard-agent-darwin-$CROSS_GOARCH" \
       . 2>&1; then
  echo "  → $OUT_DIR/obliguard-agent-darwin-$CROSS_GOARCH"
  BUILT+=("$OUT_DIR/obliguard-agent-darwin-$CROSS_GOARCH")
else
  echo "  WARNING: Cross-compilation to darwin/$CROSS_GOARCH failed — skipping."
  echo "           (The native $NATIVE_GOARCH binary was built successfully.)"
fi

# ── Manifest ──────────────────────────────────────────────────────────────────
# A 'dev' build is never recorded: the server would not advertise it anyway.

if [ "$VERSION" != "dev" ]; then
  write_manifest "$VERSION" "${BUILT[@]}"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Built binaries:"
ls -lh "$OUT_DIR"/obliguard-agent-darwin-* 2>/dev/null || true
echo ""
echo "Next steps:"
echo "  1. The .bat script (00-A3-build-mac-agent.bat) retrieves both binaries automatically."
echo "  2. Run 000-RegularUpdate.bat (or 00-A2-docker-agent-push.bat) to rebuild"
echo "     the Docker image — the Dockerfile's last 'COPY agent/dist/' picks up"
echo "     both darwin binaries."
