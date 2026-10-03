# ---- Build stage ----
FROM node:24-alpine AS builder
WORKDIR /app

# Root package.json for workspace resolution, and the root lockfile so every
# image build installs the same dependency tree (no semver drift)
COPY package.json package-lock.json ./

# Shared source (needed by Vite alias @obliview/shared → ../shared/src)
# Also needs its own package.json for workspace linking
COPY shared/ ./shared/

# Install client dependencies via workspace
COPY client/package.json ./client/
RUN npm install --workspace=client --no-audit --no-fund

# Build client (copy remaining source)
COPY client/ ./client/
RUN cd client && npm run build

# ---- Production stage ----
# Static files only: no Node.js, no node_modules, no build toolchain.
FROM nginx:alpine AS production

# Run nginx unprivileged (as the image's `nginx` user, uid 101):
#   - the master process no longer starts as root, so the `user` directive is
#     dropped and the pid file moves to /tmp;
#   - the temp/cache paths (/var/cache/nginx) become owned by nginx;
#   - nginx keeps listening on port 80 (client/nginx.conf, compose maps
#     LISTEN_PORT:80) through the cap_net_bind_service file capability on the
#     binary, the only privilege it keeps (Docker's default capability set
#     includes it).
#   setcap comes from libcap-setcap (Alpine 3.16+; libcap before), removed
#   again right after use.
RUN { apk add --no-cache --virtual .setcap libcap-setcap || apk add --no-cache --virtual .setcap libcap; } \
    && setcap 'cap_net_bind_service=+ep' /usr/sbin/nginx \
    && apk del .setcap \
    && sed -i -e '/^user /d' -e 's#^pid .*#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
    && chown -R nginx:nginx /var/cache/nginx

COPY --from=builder /app/client/dist/ /usr/share/nginx/html/
COPY client/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

USER nginx

# nginx itself (the SPA shell), with the image's busybox wget: no curl in the
# image. 127.0.0.1, not localhost: nginx listens on IPv4 only here (the IPv6
# listen helper of the base image does not rewrite a customised default.conf).
# /health is not used on purpose: it is proxied to the server, so a database
# hiccup would mark this container unhealthy too (the server has its own
# /health check, and compose starts the client once the server is healthy).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
