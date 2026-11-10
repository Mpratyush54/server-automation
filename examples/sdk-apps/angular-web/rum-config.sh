#!/bin/sh
# Writes /rum-config.json (the browser telemetry block) from env at container start.
# RUM_FARO_ENDPOINT: Faro receiver, e.g. https://otel.<DOMAIN>/collect
# RUM_BROWSER_TOKEN: public browser ingest token (plat_ingest_web_...) from GET /api/sdk/config
# RUM_SAMPLING_RATIO: 0..1 (default 1)
# Without both values RUM stays off and the SDK never downloads Faro.
set -eu
out="${RUM_CONFIG_PATH:-/usr/share/nginx/html/rum-config.json}"
endpoint="${RUM_FARO_ENDPOINT:-}"
token="${RUM_BROWSER_TOKEN:-}"
ratio="${RUM_SAMPLING_RATIO:-1}"
case "$ratio" in 0|1|1.0|0.[0-9]|0.[0-9][0-9]|0.[0-9][0-9][0-9]) ;; *) ratio=1 ;; esac
case "$endpoint$token" in *'"'*|*'\'*) echo "rum-config: refusing quotes/backslashes in RUM_* values" >&2; endpoint=''; token='' ;; esac
if [ -n "$endpoint" ] && [ -n "$token" ]; then
  printf '{"enabled":true,"faroEndpoint":"%s","browserToken":"%s","samplingRatio":%s}\n' "$endpoint" "$token" "$ratio" > "$out"
else
  printf '{"enabled":false}\n' > "$out"
fi
