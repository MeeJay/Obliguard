# ---- Node.js build stage (server + shared) ----
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json ./
COPY shared/ ./shared/
RUN cd shared && npm install && npm run build

COPY server/package.json ./server/
RUN cd server && npm install

COPY server/tsconfig.json server/knexfile.ts ./server/
COPY server/src/ ./server/src/
RUN cd server && npm run build

# ---- Go cross-compilation stage (Windows + Linux agent binaries) ----
FROM golang:1.22-alpine AS go-agent-builder
WORKDIR /build

# Download dependencies first (layer cache)
COPY agent/go.mod agent/go.sum* ./
RUN go mod download 2>/dev/null || true

COPY agent/ ./
RUN go mod tidy

# All platforms — version injected from VERSION file (single source of truth).
# agent/main.go uses `var agentVersion = "dev"` overridden here via -X ldflags.
RUN VERSION=$(cat VERSION) && \
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
        go build -ldflags="-s -w -X main.agentVersion=${VERSION}" -o dist/obliguard-agent.exe . && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
        go build -ldflags="-s -w -X main.agentVersion=${VERSION}" -o dist/obliguard-agent-linux-amd64 . && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
        go build -ldflags="-s -w -X main.agentVersion=${VERSION}" -o dist/obliguard-agent-linux-arm64 . && \
    CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 \
        go build -ldflags="-s -w -X main.agentVersion=${VERSION}" -o dist/obliguard-agent-darwin-amd64 . && \
    CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 \
        go build -ldflags="-s -w -X main.agentVersion=${VERSION}" -o dist/obliguard-agent-darwin-arm64 .

# ---- Production stage ----
FROM node:24-alpine AS production
WORKDIR /app

RUN apk add --no-cache openssh-client

COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/shared/dist/ ./shared/dist/

COPY --from=builder /app/server/package.json ./server/
COPY package.json ./
RUN cd server && npm install --omit=dev

COPY --from=builder /app/server/dist/ ./server/dist/

# Agent installer scripts + VERSION file (used by GET /api/agent/version)
COPY agent/installer/ ./agent/installer/
COPY agent/VERSION ./agent/

# Agent binaries from Go cross-compilation
RUN mkdir -p ./agent/dist
COPY --from=go-agent-builder /build/dist/obliguard-agent.exe            ./agent/dist/
COPY --from=go-agent-builder /build/dist/obliguard-agent-linux-amd64   ./agent/dist/
COPY --from=go-agent-builder /build/dist/obliguard-agent-linux-arm64   ./agent/dist/
COPY --from=go-agent-builder /build/dist/obliguard-agent-darwin-amd64  ./agent/dist/
COPY --from=go-agent-builder /build/dist/obliguard-agent-darwin-arm64  ./agent/dist/

# Pre-built Windows MSI (build on Windows: cd agent && build-msi.bat)
# If absent, the /api/agent/installer/windows.msi endpoint returns 404.
COPY agent/dist/ ./agent/dist/

# Obli.tools VERSION file (read by GET /api/agent/desktop-version to drive the update banner).
# obli.tools/ is a Windows junction in sibling repos — Docker cannot follow junctions when
# building the context tarball, so we inject the version via a build ARG instead of COPY.
ARG OBLTOOLS_VER=0.0.0
RUN mkdir -p ./obli.tools && printf '%s' "${OBLTOOLS_VER}" > ./obli.tools/VERSION

# Obli.tools release binaries (build on Windows: obli.tools/build-windows.ps1 → dist/ObliTools.exe)
#                              (build on macOS:   obli.tools/build-mac.sh      → dist/ObliTools-*.dmg/zip)
# obli.tools/ is a junction — Docker cannot follow it. The bat file stages the files into
# _oblitools_dist_stage/ (a real directory) before building so COPY works.
# If no binaries were built yet only a .keep placeholder is present → /downloads returns 404.
RUN mkdir -p ./obli.tools/dist
COPY _oblitools_dist_stage/ ./obli.tools/dist/

COPY server/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE ${PORT:-3001}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD sh -c "wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3001}/health || exit 1"

WORKDIR /app/server
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
