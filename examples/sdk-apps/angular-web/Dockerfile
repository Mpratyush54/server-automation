FROM nginx:alpine
COPY examples/sdk-apps/angular-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY examples/sdk-apps/angular-web/public /usr/share/nginx/html
# Inject API base at container start via envsubst-like sed
COPY examples/sdk-apps/angular-web/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENV API_BASE=
EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
