#!/bin/bash
set -euo pipefail
TAG="local-$(date +%Y%m%d%H%M%S)"
PORTAL_IMG="platform-portal:${TAG}"
rm -rf /tmp/platform-portal-build
mkdir -p /tmp/platform-portal-build
tar -xf /tmp/tmp-portal-src.tar -C /tmp/platform-portal-build
echo "Building ${PORTAL_IMG}..."
# Use host network in case Docker bridge DNS is flaky for npm registry
sudo docker build --network=host -t "${PORTAL_IMG}" /tmp/platform-portal-build
sudo docker save "${PORTAL_IMG}" | sudo k3s ctr images import -
sudo k3s kubectl -n platform set image deploy/platform-portal portal="${PORTAL_IMG}"
sudo k3s kubectl -n platform patch deploy platform-portal --type=json -p='[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"}]'
sudo k3s kubectl -n platform rollout status deploy/platform-portal --timeout=180s
sudo k3s kubectl -n platform get pods -l app=platform-portal -o wide
echo "DEPLOYED ${PORTAL_IMG}"
