#!/bin/sh
# Writes /rum-config.json (the browser telemetry block) from env at container start.
# RUM_FARO_ENDPOINT: Faro receiver, e.g. https://otel.<DOMAIN>/collect
# RUM_BROWSER_TOKEN: public browser ingest token (plat_ingest_web_...) from GET /api/sdk/config
# RUM_SAMPLING_RATIO: 0..1 (default 1)
# RUM_HEATMAP_ENDPOINT: optional heatmap ingest, e.g. https://<DOMAIN>/api/sdk/heatmap/events
# RUM_HEATMAP_TOKEN: optional browser-kind SDK token (sdk_live_...) for heatmaps; default RUM_BROWSER_TOKEN
# Without RUM_FARO_ENDPOINT and RUM_BROWSER_TOKEN RUM stays off and the SDK never downloads Faro.
set -eu
out="${RUM_CONFIG_PATH:-/usr/share/nginx/html/rum-config.json}"
endpoint="${RUM_FARO_ENDPOINT:-}"
token="${RUM_BROWSER_TOKEN:-}"
ratio="${RUM_SAMPLING_RATIO:-1}"
hm_endpoint="${RUM_HEATMAP_ENDPOINT:-}"
hm_token="${RUM_HEATMAP_TOKEN:-}"
case "$ratio" in 0|1|1.0|0.[0-9]|0.[0-9][0-9]|0.[0-9][0-9][0-9]) ;; *) ratio=1 ;; esac
case "$endpoint$token" in *'"'*|*'\'*) echo "rum-config: refusing quotes/backslashes in RUM_* values" >&2; endpoint=''; token='' ;; esac
case "$hm_endpoint$hm_token" in *'"'*|*'\'*) echo "rum-config: refusing quotes/backslashes in RUM_HEATMAP_* values" >&2; hm_endpoint=''; hm_token='' ;; esac
heatmaps=''
if [ -n "$hm_endpoint" ]; then
  heatmaps=",\"heatmapsEndpoint\":\"$hm_endpoint\""
  if [ -n "$hm_token" ]; then heatmaps="$heatmaps,\"heatmapsToken\":\"$hm_token\""; fi
fi
if [ -n "$endpoint" ] && [ -n "$token" ]; then
  printf '{"enabled":true,"faroEndpoint":"%s","browserToken":"%s","samplingRatio":%s%s}\n' "$endpoint" "$token" "$ratio" "$heatmaps" > "$out"
else
  printf '{"enabled":false}\n' > "$out"
fi
