# syntax=docker/dockerfile:1
# Build from repo root:
#   docker build -f examples/sdk-apps/angular-web/Dockerfile -t sdk-angular-web:local .
# Runs nginx as UID 101 on port 8080.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24
USER root
COPY examples/sdk-apps/angular-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY examples/sdk-apps/angular-web/public /usr/share/nginx/html
# Inject API base at container start via envsubst-like sed
COPY examples/sdk-apps/angular-web/docker-entrypoint.sh /docker-entrypoint.sh
# The entrypoint runs `sed -i` on app.js as the nginx user, which needs write
# access to the file and its directory (sed -i writes a temp file + rename).
RUN chmod 0755 /docker-entrypoint.sh \
    && chown 101:101 /usr/share/nginx/html /usr/share/nginx/html/app.js \
    && sed -i -E 's/^([[:space:]]*)listen[[:space:]]+80;/\1listen 8080;/' /etc/nginx/conf.d/default.conf \
    && grep -q 'listen 8080;' /etc/nginx/conf.d/default.conf
USER 101
ENV API_BASE=
EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint.sh"]
