# syntax=docker/dockerfile:1
# Node 22 LTS, pinned in every FROM (literal tags so Dependabot can bump them).

# ── build: full dependency tree (incl. devDependencies) + tsc ───────────────
FROM node:22.23.4-alpine3.24 AS build
WORKDIR /app
COPY package*.json ./
# Reproducible install when a lockfile is committed; fall back until it is.
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      echo "WARN: no package-lock.json, falling back to npm install" >&2; \
      npm install --no-audit --no-fund; \
    fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── deps: production dependencies only ──────────────────────────────────────
FROM node:22.23.4-alpine3.24 AS deps
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      echo "WARN: no package-lock.json, falling back to npm install" >&2; \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
    && npm cache clean --force

# ── kubectl: pinned, checksum-verified client for agent/MCP commands ────────
# platform_run_command shells out to kubectl (argv only, guarded by
# command-guard.ts). The version tracks the k3s minor the installer pins
# (platformctl/internal/versions K3sVersion; a Go test keeps them in step).
# Bump the version and both checksums together, from
# https://dl.k8s.io/release/<version>/bin/linux/<arch>/kubectl.sha256
FROM node:22.23.4-alpine3.24 AS kubectl
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.37.2
ARG KUBECTL_SHA256_AMD64=c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4
ARG KUBECTL_SHA256_ARM64=fcc16f63186659d9722014b7e02d5fdd2d4e669cb8c0ab66365d7d3b8ba03509
RUN set -eu; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) sum="$KUBECTL_SHA256_AMD64" ;; \
      arm64) sum="$KUBECTL_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    wget -q -O /tmp/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"; \
    echo "${sum}  /tmp/kubectl" | sha256sum -c -; \
    install -m 0755 /tmp/kubectl /usr/local/bin/kubectl; \
    /usr/local/bin/kubectl version --client >/dev/null

# ── runtime: non-root, compiled output + prod deps only ─────────────────────
FROM node:22.23.4-alpine3.24 AS runtime
ENV NODE_ENV=production
# Apply Alpine security fixes released after the base image was built, and
# drop npm/npx/corepack: the runtime only runs `node` (server and migrate
# Job), and npm's bundled dependencies were the image's only HIGH findings.
# postgresql18-client: pg_dump/pg_restore for database backups, restores and the
# backups taken before a project is deleted (lib/database-service.ts spawns
# them). Its major must be >= the server's (CNPGPostgresImage, 18.x; a unit
# test keeps them in step); newer clients also dump older servers.
RUN apk upgrade --no-cache \
  && apk add --no-cache postgresql18-client \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=kubectl /usr/local/bin/kubectl /usr/local/bin/kubectl
WORKDIR /app
# Application files stay root-owned, i.e. read-only for the app user.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
# source-map 0.6.1 is already pinned in the immutable lockfile (dev tree).
# Preserve it in production for error symbolication without changing the lockfile.
COPY --from=build /app/node_modules/source-map ./node_modules/source-map
COPY --from=build /app/dist ./dist
# Served by GET /api/openapi.json (read relative to dist/routes).
COPY openapi.yaml openapi.json ./
# Scratch dirs the API writes under process.cwd() (storage, uploads, tmp).
RUN mkdir -p storage uploads tmp && chown node:node storage uploads tmp
# UID/GID of the image's built-in "node" user. Numeric so Kubernetes
# runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1
# Run node directly (not via npm) so SIGTERM reaches the server process.
CMD ["node", "dist/server.js"]
