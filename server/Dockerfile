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

# ---- Offline install wizard builder ----
# Cross-compiles the self-contained "offline" install wizards from the prebuilt
# agent artifacts already in agent/dist (the MSI + the linux binary), embedding
# them via //go:embed. The server then appends the per-key OBLI_CFG tail-blob at
# download time. Best-effort + NON-FATAL: if a wizard can't be built (e.g. the
# MSI/linux binary isn't in the context, or no network for the walk GUI dep) it's
# simply omitted, the download endpoint returns 404, and the rest of the image
# build is unaffected.
FROM golang:1.22-alpine AS wizard-builder
RUN apk add --no-cache git
WORKDIR /w
COPY agent/wizard/ ./
COPY agent/dist/ ./dist-src/
RUN mkdir -p /out && { \
      cp dist-src/obliguard-agent-linux-amd64 ./linux/obliguard-agent 2>/dev/null && \
      GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/obliguard-installer-wizard-linux-amd64 ./linux && \
      echo "[wizard] linux OK" ; } || echo "[wizard] linux skipped"
RUN { \
      cp dist-src/obliguard-agent.msi ./windows/obliguard-agent.msi 2>/dev/null && \
      go mod download all && \
      ( cd windows && go run github.com/akavel/rsrc@latest -manifest obliguard-installer-wizard.exe.manifest -o rsrc_windows.syso ) && \
      GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w -H windowsgui" -o /out/obliguard-installer-wizard.exe ./windows && \
      echo "[wizard] windows OK" ; } || echo "[wizard] windows skipped"

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

# All agent binaries are built and code-signed locally (Windows, Linux, macOS, FreeBSD).
RUN mkdir -p ./agent/dist
COPY agent/dist/ ./agent/dist/

# Offline install wizards, cross-built from the artifacts above during this image
# build (best-effort — absent if the wizard-builder stage couldn't produce them).
COPY --from=wizard-builder /out/ ./agent/dist/

# Obli.tools VERSION file — injected via build ARG (obli.tools/ is a Windows junction,
# Docker cannot follow it when building the context tarball).
ARG OBLTOOLS_VER=0.0.0
RUN mkdir -p ./obli.tools && printf '%s' "${OBLTOOLS_VER}" > ./obli.tools/VERSION

# Obli.tools release binaries (staged into _oblitools_dist_stage/ by the bat file).
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
