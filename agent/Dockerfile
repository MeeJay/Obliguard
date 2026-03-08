# ---- Build stage ----
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Download dependencies first (layer cache)
COPY go.mod go.sum ./
RUN go mod download

# Build Linux amd64 binary
COPY . .
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64
RUN go build -ldflags="-s -w" -o obliguard-agent .

# ---- Production stage ----
FROM alpine:latest

# ca-certificates for HTTPS
RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=builder /app/obliguard-agent .

ENTRYPOINT ["/app/obliguard-agent"]
