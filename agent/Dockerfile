# ---- Build stage ----
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Download dependencies first (layer cache)
COPY go.mod go.sum ./
RUN go mod download

# Build Linux amd64 binary
COPY . .
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64
# AGENT_VERSION is passed by the build script (--build-arg AGENT_VERSION=x.y.z)
# so the binary embeds the correct version string instead of the Go default "dev".
ARG AGENT_VERSION=dev
RUN go build -ldflags="-s -w -X main.agentVersion=${AGENT_VERSION}" -o obliguard-agent .

# ---- Production stage ----
FROM alpine:latest

# ca-certificates for HTTPS
RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=builder /app/obliguard-agent .

ENTRYPOINT ["/app/obliguard-agent"]
