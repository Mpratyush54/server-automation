#!/bin/sh
set -eu
html=/usr/share/nginx/html
API_BASE="${API_BASE:-}"
case "$API_BASE" in *'"'*|*'\'*|*'<'*) echo "API_BASE contains invalid characters" >&2; exit 1 ;; esac
# Runtime config read by the app (src/app/api-base.ts).
printf 'window.__APP_CONFIG__ = { apiBase: "%s" };\n' "$API_BASE" > "$html/app-config.js"
# Browser RUM config (RUM_FARO_ENDPOINT / RUM_BROWSER_TOKEN / RUM_SAMPLING_RATIO).
RUM_CONFIG_PATH="$html/rum-config.json" /usr/local/bin/rum-config.sh
exec nginx -g 'daemon off;'
