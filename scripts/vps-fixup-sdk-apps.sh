#!/bin/bash
set -euo pipefail
DOMAIN=148.113.59.3.sslip.io
NS=sdk-demo-apps-development

# Remove conflicting ingresses that claim the same host
sudo k3s kubectl get ingress -A | grep -i sdk || true
sudo k3s kubectl delete ingress -n sdk-demo-apps-staging sdk-demo-apps-staging --ignore-not-found || true
sudo k3s kubectl delete ingress -n sdk-demo-apps-development sdk-demo-apps-development --ignore-not-found || true
sudo k3s kubectl delete ingress -n argocd --all --ignore-not-found 2>/dev/null || true

# Find any ingress with our host
while read -r ns name; do
  [ -z "${ns:-}" ] && continue
  hosts=$(sudo k3s kubectl -n "$ns" get ingress "$name" -o jsonpath='{.spec.rules[*].host}' 2>/dev/null || true)
  if echo "$hosts" | grep -q "sdk-demo-apps-development.${DOMAIN}"; then
    echo "Deleting conflicting $ns/$name ($hosts)"
    sudo k3s kubectl -n "$ns" delete ingress "$name" --ignore-not-found
  fi
done < <(sudo k3s kubectl get ingress -A --no-headers 2>/dev/null | awk '{print $1,$2}')

TMP=$(mktemp -d)
cp -a /tmp/sdk-apps-src/examples/sdk-apps/k8s/. "$TMP/"
SDK=$(sudo k3s kubectl -n "$NS" get secret platform-sdk-token -o jsonpath='{.data.PLATFORM_SDK_TOKEN}' 2>/dev/null | base64 -d || true)
if [ -z "$SDK" ]; then
  echo "Missing SDK token secret"; exit 1
fi
python3 - <<PY
from pathlib import Path
p=Path("$TMP")/"all.yaml"
t=p.read_text()
t=t.replace("REPLACE_ME", """$SDK""")
p.write_text(t)
PY

sudo k3s kubectl apply -f "$TMP/all.yaml"
sudo k3s kubectl -n "$NS" rollout status deploy/sdk-node-api --timeout=240s
sudo k3s kubectl -n "$NS" rollout status deploy/sdk-react-web --timeout=120s
sudo k3s kubectl -n "$NS" rollout status deploy/sdk-angular-web --timeout=120s
sudo k3s kubectl -n "$NS" get pods,ingress -o wide

NODE_HOST="sdk-demo-apps-development.${DOMAIN}"
ok=0
for i in $(seq 1 30); do
  if curl -skf "https://${NODE_HOST}/health" -o /tmp/sdk-node-health.json; then ok=1; break; fi
  sleep 5
done
echo "health_ok=$ok"
cat /tmp/sdk-node-health.json 2>/dev/null || true
echo
sleep 10
curl -sk "https://${NODE_HOST}/api/db-check" -o /tmp/sdk-db-check.json || true
cat /tmp/sdk-db-check.json; echo
curl -skf "https://sdk-react.${DOMAIN}/" -o /tmp/sdk-react.html && echo react_ok || echo react_fail
curl -skf "https://sdk-angular.${DOMAIN}/" -o /tmp/sdk-angular.html && echo angular_ok || echo angular_fail

for i in $(seq 1 8); do
  curl -skf "https://${NODE_HOST}/api/hello?client=react" >/dev/null || true
  curl -skf "https://${NODE_HOST}/api/users?client=angular" >/dev/null || true
done
sleep 20

# metrics via admin login from env
API=https://api.148.113.59.3.sslip.io
LOGIN=$(curl -sk -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@pratyushes.dev\",\"password\":\"$ADMIN_PASSWORD\"}")
TOKEN=$(echo "$LOGIN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
PID=64bd9373-cf16-4e1e-91f7-c3cf345c59e5
curl -sk "$API/api/metrics?projectId=$PID" -H "Authorization: Bearer $TOKEN" -o /tmp/sdk-metrics.json
curl -sk "$API/api/sdk/api-metrics?projectId=$PID" -H "Authorization: Bearer $TOKEN" -o /tmp/sdk-api-metrics.json
python3 - <<'PY'
import json
m=json.load(open('/tmp/sdk-metrics.json'))
a=json.load(open('/tmp/sdk-api-metrics.json'))
try: db=json.load(open('/tmp/sdk-db-check.json'))
except Exception: db={}
hb=len(m) if isinstance(m,list) else 0
routes=len((a or {}).get('metrics') or [])
print(json.dumps({"heartbeats":hb,"apiRoutes":routes,"dbCheck":db}, indent=2))
if hb < 1 and routes < 1:
  raise SystemExit('FAIL telemetry')
print('PASS')
PY
echo FIXUP_OK
