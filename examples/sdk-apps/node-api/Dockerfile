# syntax=docker/dockerfile:1
# Build from repo root:
#   docker build -f examples/sdk-apps/node-api/Dockerfile -t sdk-node-api:local .

FROM node:22.23.4-alpine3.24 AS sdk
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
# Pack the SDK the way npm publishes it. Installing the tarball copies it into
# /app/node_modules, so its optional OpenTelemetry peers resolve from the app's
# node_modules, exactly as for a user who installs it from the registry. (A
# `file:` directory dependency is a symlink: Node resolves the SDK's requires
# from its real path and never finds the app's OpenTelemetry packages.)
RUN cd sdk-node && npm run build && npm pack --pack-destination /src

FROM node:22.23.4-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
COPY --from=sdk /src/mpratyush54-sdk-node-*.tgz /tmp/sdk/
COPY examples/sdk-apps/node-api/package.json ./
# package.json is rewritten to point at the packed SDK, so a lockfile (which
# would reference ../../../sdk-node) cannot be used with `npm ci` here.
# The last two checks fail the build if the SDK is a symlink again or cannot
# see the app's OpenTelemetry packages.
RUN npm pkg set "dependencies.@mpratyush54/sdk-node=file:$(ls /tmp/sdk/*.tgz)" \
  && npm install --omit=dev --no-audit --no-fund \
  && test ! -L node_modules/@mpratyush54/sdk-node \
  && node -e "require.resolve('@opentelemetry/sdk-node', { paths: [require.resolve('@mpratyush54/sdk-node')] })" \
  && rm -rf /tmp/sdk && npm cache clean --force
COPY examples/sdk-apps/node-api/src ./src
# Built-in "node" user (numeric for Kubernetes runAsNonRoot).
USER 1000:1000
ENV PORT=4100
EXPOSE 4100
CMD ["node", "src/index.js"]
