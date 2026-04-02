#!/usr/bin/env bash
set -euo pipefail

# Build Obliguard Agent for Linux + FreeBSD.
# Runs on a Linux host — called remotely via SSH from 000-RegularUpdate.bat.

cd "$(dirname "$0")"
VERSION=$(cat VERSION 2>/dev/null || echo "0.0.0")

echo "Building Obliguard Agent v${VERSION} for Linux + FreeBSD..."

export CGO_ENABLED=0
mkdir -p dist

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

echo "Done. Binaries:"
ls -lh dist/obliguard-agent-linux-* dist/obliguard-agent-freebsd-*
