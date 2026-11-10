# syntax=docker/dockerfile:1
# Build from repo root:
#   docker build -f examples/sdk-apps/angular-web/Dockerfile -t sdk-angular-web:local .
# Runs nginx as UID 101 on port 8080. Runtime env: API_BASE, and optionally
# RUM_FARO_ENDPOINT, RUM_BROWSER_TOKEN, RUM_SAMPLING_RATIO for browser RUM.
FROM node:22.23.4-alpine3.24 AS build
# The demo consumes the SDK from this repo (file:../../../sdk-angular), built first;
# .npmrc install-links=true installs it as a packed copy.
WORKDIR /src/sdk-angular
COPY sdk-angular/package*.json ./
RUN npm ci --no-audit --no-fund
COPY sdk-angular/ ./
RUN npm run build
WORKDIR /src/examples/sdk-apps/angular-web
COPY examples/sdk-apps/angular-web/package*.json examples/sdk-apps/angular-web/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY examples/sdk-apps/angular-web/ ./
ENV NG_CLI_ANALYTICS=false
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24
USER root
COPY examples/sdk-apps/angular-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/examples/sdk-apps/angular-web/dist /usr/share/nginx/html
COPY --chmod=0755 examples/sdk-apps/angular-web/docker-entrypoint.sh /docker-entrypoint.sh
COPY --chmod=0755 examples/sdk-apps/angular-web/rum-config.sh /usr/local/bin/rum-config.sh
# The entrypoint rewrites app-config.js and rum-config.json as the nginx user.
RUN touch /usr/share/nginx/html/rum-config.json \
    && chown 101:101 /usr/share/nginx/html/app-config.js /usr/share/nginx/html/rum-config.json \
    && sed -i -E 's/^([[:space:]]*)listen[[:space:]]+80;/\1listen 8080;/' /etc/nginx/conf.d/default.conf \
    && grep -q 'listen 8080;' /etc/nginx/conf.d/default.conf
USER 101
ENV API_BASE=
EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint.sh"]
