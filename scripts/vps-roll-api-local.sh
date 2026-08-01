#!/bin/bash
set -euo pipefail

API_LOCAL="platform-api:local-20260801141244"
API_TAG="ghcr.io/mpratyush54/platform-api:local-fix"

# Suspend auto-update so it doesn't yank our image back to GHCR latest
sudo k3s kubectl -n platform patch cronjob platform-auto-update --type merge -p '{"spec":{"suspend":true}}' 2>/dev/null || true

# Retag + import into containerd under a stable name
sudo docker tag "${API_LOCAL}" "${API_TAG}"
sudo docker save "${API_TAG}" | sudo k3s ctr images import -

# Force deployment onto the local-fix image
sudo k3s kubectl -n platform set image deploy/platform-api api="${API_TAG}"
cat >/tmp/api-pull-policy-patch.json <<'EOF'
[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"}]
EOF
sudo k3s kubectl -n platform patch deploy platform-api --type=json --patch-file=/tmp/api-pull-policy-patch.json

sudo k3s kubectl -n platform rollout status deploy/platform-api --timeout=120s
echo "API image:"
sudo k3s kubectl -n platform get deploy platform-api -o jsonpath='{.spec.template.spec.containers[0].image}{" pullPolicy="}{.spec.template.spec.containers[0].imagePullPolicy}{"\n"}'
sudo k3s kubectl -n platform get pods -l app=platform-api -o wide
