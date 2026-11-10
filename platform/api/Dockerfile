# syntax=docker/dockerfile:1
# Node 22 LTS, pinned in every FROM (literal tags so Dependabot can bump them).

# ── build: full dependency tree (incl. devDependencies) + tsc ───────────────
FROM node:26.12.1-alpine3.24 AS build
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
FROM node:26.12.1-alpine3.24 AS deps
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      echo "WARN: no package-lock.json, falling back to npm install" >&2; \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
    && npm cache clean --force

# ── runtime: non-root, compiled output + prod deps only ─────────────────────
FROM node:26.12.1-alpine3.24 AS runtime
ENV NODE_ENV=production
# Apply Alpine security fixes released after the base image was built, and
# drop npm/npx/corepack: the runtime only runs `node` (server and migrate
# Job), and npm's bundled dependencies were the image's only HIGH findings.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
# Application files stay root-owned, i.e. read-only for the app user.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
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
