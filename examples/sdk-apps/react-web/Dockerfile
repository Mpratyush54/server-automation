# syntax=docker/dockerfile:1
# Build from repo root:
#   docker build -f examples/sdk-apps/react-web/Dockerfile --build-arg VITE_API_URL=https://... -t sdk-react-web:local .
FROM node:22.23.4-alpine3.24 AS build
WORKDIR /app
COPY examples/sdk-apps/react-web/package*.json ./
# Reproducible install when a lockfile is committed; fall back until it is.
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      echo "WARN: no package-lock.json, falling back to npm install" >&2; \
      npm install --no-audit --no-fund; \
    fi
COPY examples/sdk-apps/react-web/ ./
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build
# The runtime runs nginx as an unprivileged user, which cannot bind :80.
RUN sed -i -E 's/^([[:space:]]*)listen[[:space:]]+80;/\1listen 8080;/' nginx.conf \
    && grep -q 'listen 8080;' nginx.conf

# Runtime: nginx as UID 101, listening on 8080.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24
COPY --from=build /app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
