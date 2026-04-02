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
