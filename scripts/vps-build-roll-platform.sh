#!/bin/bash
set -euo pipefail

TAG="local-$(date +%Y%m%d%H%M%S)"
API_IMG="platform-api:${TAG}"
PORTAL_IMG="platform-portal:${TAG}"

rm -rf /tmp/platform-api-build /tmp/platform-portal-build
mkdir -p /tmp/platform-api-build /tmp/platform-portal-build
tar -xf /tmp/tmp-api-src.tar -C /tmp/platform-api-build
tar -xf /tmp/tmp-portal-src.tar -C /tmp/platform-portal-build

echo "Building ${API_IMG}..."
sudo docker build -t "${API_IMG}" /tmp/platform-api-build

echo "Building ${PORTAL_IMG}..."
sudo docker build -t "${PORTAL_IMG}" /tmp/platform-portal-build

# Import into k3s (containerd) so pods can pull local images
sudo docker save "${API_IMG}" | sudo k3s ctr images import -
sudo docker save "${PORTAL_IMG}" | sudo k3s ctr images import -

sudo k3s kubectl -n platform set image deploy/platform-api api="${API_IMG}"
sudo k3s kubectl -n platform set image deploy/platform-portal portal="${PORTAL_IMG}"
sudo k3s kubectl -n platform patch deploy platform-api --type='json' -p='[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"}]'
sudo k3s kubectl -n platform patch deploy platform-portal --type='json' -p='[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"}]'

sudo k3s kubectl -n platform rollout status deploy/platform-api --timeout=180s
sudo k3s kubectl -n platform rollout status deploy/platform-portal --timeout=180s
sudo k3s kubectl -n platform get pods -o wide
echo "DEPLOYED ${API_IMG} ${PORTAL_IMG}"
