# syntax=docker/dockerfile:1
# Build from repo root:
#   docker build -f examples/sdk-apps/node-api/Dockerfile -t sdk-node-api:local .

FROM node:26.12.1-alpine3.24 AS sdk
WORKDIR /src
COPY sdk-node/package*.json ./sdk-node/
# Reproducible install when a lockfile is committed; fall back until it is.
RUN cd sdk-node && if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      echo "WARN: no package-lock.json, falling back to npm install" >&2; \
      npm install --no-audit --no-fund; \
    fi
COPY sdk-node ./sdk-node
RUN cd sdk-node && npm run build && npm prune --omit=dev

FROM node:26.12.1-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
COPY --from=sdk /src/sdk-node /sdk-node
COPY examples/sdk-apps/node-api/package.json ./
# package.json is rewritten to point at the in-image SDK, so a lockfile (which
# would reference ../../../sdk-node) cannot be used with `npm ci` here.
RUN npm pkg set dependencies.@mpratyush54/sdk-node=file:/sdk-node \
  && npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force
COPY examples/sdk-apps/node-api/src ./src
# Built-in "node" user (numeric for Kubernetes runAsNonRoot).
USER 1000:1000
ENV PORT=4100
EXPOSE 4100
CMD ["node", "src/index.js"]
