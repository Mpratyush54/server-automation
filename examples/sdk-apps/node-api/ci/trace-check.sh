#!/usr/bin/env bash
# Runs the SDK demo image against a stub Cairn API + OTLP collector (otlp-stub.mjs)
# and passes only when the app exports a trace: an HTTP request must reach
# POST /v1/traces within 60 s. Needs docker, node and openssl.
#   examples/sdk-apps/node-api/ci/trace-check.sh [image]   (default sdk-node-api:ci)
set -euo pipefail
IMAGE="${1:-sdk-node-api:ci}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT=8443
NAME="sdk-demo-trace-$$"
WORK="$(mktemp -d)"
STUB=""
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [[ -n "$STUB" ]]; then kill "$STUB" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# The SDK only exports to https collectors: a throwaway CA-less certificate,
# trusted inside the container through NODE_EXTRA_CA_CERTS.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
chmod 644 "$WORK/cert.pem"
node "$HERE/otlp-stub.mjs" "$WORK" "$PORT" > "$WORK/stub.log" 2>&1 &
STUB=$!
for _ in $(seq 1 20); do grep -q 'stub listening' "$WORK/stub.log" && break; sleep 0.5; done

docker run -d --name "$NAME" --network host \
  -v "$WORK/cert.pem:/etc/ci-ca.pem:ro" -e NODE_EXTRA_CA_CERTS=/etc/ci-ca.pem \
  -e PLATFORM_URL="https://localhost:$PORT" -e PLATFORM_SDK_TOKEN=ci-sdk-token \
  -e PROJECT_DOMAIN=example.com -e GITOPS=0 -e PORT=4100 "$IMAGE" >/dev/null

fail() {
  echo "trace check FAILED: $1" >&2
  echo "--- stub requests" >&2; cat "$WORK/stub.log" >&2
  echo "--- app logs" >&2; docker logs "$NAME" 2>&1 | tail -n 40 >&2
  exit 1
}
up=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null http://127.0.0.1:4100/health 2>/dev/null; then up=1; break; fi
  sleep 1
done
[[ $up -eq 1 ]] || fail "the demo did not answer on :4100 within 60 s"
for i in $(seq 1 5); do curl -fsS -o /dev/null "http://127.0.0.1:4100/api/hello?client=ci-$i" || true; done
for _ in $(seq 1 60); do
  if grep -q '^OTLP /v1/traces [1-9]' "$WORK/stub.log"; then
    echo "trace check passed: $(grep -c '^OTLP /v1/traces' "$WORK/stub.log") trace export(s) received"
    exit 0
  fi
  sleep 1
done
fail "no POST /v1/traces within 60 s"
