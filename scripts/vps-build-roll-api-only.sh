#!/bin/bash
set -euo pipefail
TAG="local-$(date +%Y%m%d%H%M%S)"
API_IMG="ghcr.io/mpratyush54/platform-api:${TAG}"

sudo k3s kubectl -n platform patch cronjob platform-auto-update --type merge -p '{"spec":{"suspend":true}}' 2>/dev/null || true

rm -rf /tmp/platform-api-build
mkdir -p /tmp/platform-api-build
tar -xf /tmp/tmp-api-src.tar -C /tmp/platform-api-build

echo "Building ${API_IMG}..."
sudo docker build -t "${API_IMG}" /tmp/platform-api-build
sudo docker save "${API_IMG}" | sudo k3s ctr images import -

sudo k3s kubectl -n platform set image deploy/platform-api api="${API_IMG}"
cat >/tmp/pull-policy.json <<'EOF'
[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"}]
EOF
sudo k3s kubectl -n platform patch deploy platform-api --type=json --patch-file=/tmp/pull-policy.json

sudo k3s kubectl -n platform rollout status deploy/platform-api --timeout=180s
sudo k3s kubectl -n platform get pods -o wide | grep -E 'NAME|platform-api' || true
echo "DEPLOYED ${API_IMG}"
