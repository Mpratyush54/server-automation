#!/bin/sh
set -eu
API_BASE="${API_BASE:-}"
# Rewrite app.js fetch base if API_BASE is set
if [ -n "$API_BASE" ] && [ -f /usr/share/nginx/html/app.js ]; then
  sed -i "s|__API_BASE__|${API_BASE}|g" /usr/share/nginx/html/app.js
fi
exec nginx -g 'daemon off;'
