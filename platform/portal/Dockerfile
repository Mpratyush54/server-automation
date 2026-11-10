# syntax=docker/dockerfile:1
# Build JS on the native builder arch. Angular/esbuild crashes under QEMU
# (linux/arm64 on amd64 runners → "Illegal instruction" / deadlock).
# The dist output is arch-independent; only the runtime image is multi-arch.
FROM --platform=$BUILDPLATFORM node:22.23.4-alpine3.24 AS builder
WORKDIR /app
COPY package*.json ./
# Reproducible install when a lockfile is committed; fall back until it is.
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      echo "WARN: no package-lock.json, falling back to npm install" >&2; \
      npm install --no-audit --no-fund; \
    fi
COPY . .
RUN npm run build
# The runtime runs nginx as an unprivileged user, which cannot bind :80.
RUN sed -i -E 's/^([[:space:]]*)listen[[:space:]]+80;/\1listen 8080;/' nginx.conf \
    && grep -q 'listen 8080;' nginx.conf

# Runtime: nginx as UID 101, listening on 8080.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24
# Apply Alpine security fixes released after the base image was built
# (Trivy gates releases on fixable CRITICAL vulnerabilities).
USER root
RUN apk upgrade --no-cache
COPY --from=builder /app/dist/portal/browser /usr/share/nginx/html
COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf
USER 101
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
