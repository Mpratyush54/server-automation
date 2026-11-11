#!/bin/sh
# Writes /rum-config.json (the browser telemetry block) from env at container start.
# RUM_FARO_ENDPOINT: Faro receiver, e.g. https://otel.<DOMAIN>/collect
# RUM_BROWSER_TOKEN: public browser ingest token (plat_ingest_web_...) from GET /api/sdk/config
# RUM_SAMPLING_RATIO: 0..1 (default 1)
# RUM_REPLAY_ENDPOINT: session replay API base (telemetry.replayEndpoint, e.g. https://<DOMAIN>/api/sdk/replay);
#   optional, replay stays off without it (#40)
# Without both values RUM stays off and the SDK never downloads Faro.
set -eu
out="${RUM_CONFIG_PATH:-/usr/share/nginx/html/rum-config.json}"
endpoint="${RUM_FARO_ENDPOINT:-}"
token="${RUM_BROWSER_TOKEN:-}"
ratio="${RUM_SAMPLING_RATIO:-1}"
replay="${RUM_REPLAY_ENDPOINT:-}"
case "$ratio" in 0|1|1.0|0.[0-9]|0.[0-9][0-9]|0.[0-9][0-9][0-9]) ;; *) ratio=1 ;; esac
case "$endpoint$token$replay" in *'"'*|*'\'*) echo "rum-config: refusing quotes/backslashes in RUM_* values" >&2; endpoint=''; token=''; replay='' ;; esac
case "$replay" in https://*|http://*|'') ;; *) echo "rum-config: RUM_REPLAY_ENDPOINT must be an http(s) URL" >&2; replay='' ;; esac
if [ -n "$endpoint" ] && [ -n "$token" ]; then
  if [ -n "$replay" ]; then
    printf '{"enabled":true,"faroEndpoint":"%s","browserToken":"%s","samplingRatio":%s,"replayEndpoint":"%s"}\n' "$endpoint" "$token" "$ratio" "$replay" > "$out"
  else
    printf '{"enabled":true,"faroEndpoint":"%s","browserToken":"%s","samplingRatio":%s}\n' "$endpoint" "$token" "$ratio" > "$out"
  fi
else
  printf '{"enabled":false}\n' > "$out"
fi
# RUM_ERRORS_ENDPOINT: optional RUM error mirror (telemetry.errorsEndpoint, e.g. https://<DOMAIN>/api/errors/rum).
#   Faro exceptions are also sent there so they show up in error tracking; ignored while RUM is off.
errors="${RUM_ERRORS_ENDPOINT:-}"
case "$errors" in *'"'*|*'\'*) echo "rum-config: refusing quotes/backslashes in RUM_ERRORS_ENDPOINT" >&2; errors='' ;; esac
case "$errors" in https://*|http://*|'') ;; *) echo "rum-config: RUM_ERRORS_ENDPOINT must be an http(s) URL" >&2; errors='' ;; esac
if [ -n "$errors" ] && [ -n "$endpoint" ] && [ -n "$token" ]; then
  json="$(cat "$out")"
  printf '%s,"errorsEndpoint":"%s"}\n' "${json%\}}" "$errors" > "$out"
fi
