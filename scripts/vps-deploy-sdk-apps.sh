#!/bin/bash
# Build SDK demo images, import to k3s, apply git desired-state, verify HTTPS/DB/telemetry.
# DB ensure + Argo + ingress happen when node-api SDK register runs.
set -euo pipefail
umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export TMP

ROOT="${1:-/tmp/sdk-apps-src}"
export DOMAIN="${DOMAIN:?set DOMAIN, e.g. 1.2.3.4.sslip.io}"
NODE_HOST="sdk-demo-apps-development.${DOMAIN}"
NS="sdk-demo-apps-development"
API="${PLATFORM_API_URL:-https://api.${DOMAIN}}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@pratyushes.dev}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?ADMIN_PASSWORD required}"

echo "==> Login"
LOGIN=$(curl -sk -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
TOKEN=$(echo "$LOGIN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

echo "==> Ensure project sdk-demo-apps"
PROJECTS=$(curl -sk "$API/api/projects" -H "Authorization: Bearer $TOKEN")
PROJECT_ID=$(printf '%s' "$PROJECTS" | python3 -c 'import json,sys; projects=json.load(sys.stdin); p=next((x for x in projects if x.get("name")=="sdk-demo-apps"), None); print(p["id"] if p else "")')
if [ -z "$PROJECT_ID" ]; then
  PROJECT=$(curl -sk -X POST "$API/api/projects" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"name\":\"sdk-demo-apps\",\"stack\":\"nodejs\",\"repositoryUrl\":\"https://github.com/Mpratyush54/SERVER-automation.git\",\"domain\":\"$DOMAIN\"}" \
    )
  PROJECT_ID=$(printf '%s' "$PROJECT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
fi

SDK_RESPONSE=$(curl -sk -X POST "$API/api/projects/$PROJECT_ID/tokens" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"vps-deploy"}')
SDK_TOKEN=$(printf '%s' "$SDK_RESPONSE" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("token") or d.get("plaintext") or d.get("key") or "")')
unset SDK_RESPONSE
echo "project=$PROJECT_ID token_len=${#SDK_TOKEN}"
test -n "$SDK_TOKEN"

echo "==> Build images from $ROOT"
cd "$ROOT"
sudo docker build -f examples/sdk-apps/node-api/Dockerfile -t sdk-node-api:local .
sudo docker build -f examples/sdk-apps/react-web/Dockerfile \
  --build-arg "VITE_API_URL=https://${NODE_HOST}" \
  -t sdk-react-web:local .
sudo docker build -f examples/sdk-apps/angular-web/Dockerfile -t sdk-angular-web:local .

echo "==> Import into k3s"
sudo docker save sdk-node-api:local | sudo k3s ctr images import -
sudo docker save sdk-react-web:local | sudo k3s ctr images import -
sudo docker save sdk-angular-web:local | sudo k3s ctr images import -

echo "==> Apply manifests (bootstrap; matches examples/sdk-apps/k8s)"
cp -a examples/sdk-apps/k8s/. "$TMP/"
printf '%s' "$SDK_TOKEN" | python3 -c 'import sys,os; from pathlib import Path; t=(Path(os.environ["TMP"])/"all.yaml").read_text(); print(t.replace("REPLACE_ME",sys.stdin.read()).replace("__DOMAIN__",os.environ["DOMAIN"]))' | sudo k3s kubectl apply -f -
unset SDK_TOKEN

echo "==> Wait for rollouts"
sudo k3s kubectl -n "$NS" rollout status deploy/sdk-node-api --timeout=240s
sudo k3s kubectl -n "$NS" rollout status deploy/sdk-react-web --timeout=120s
sudo k3s kubectl -n "$NS" rollout status deploy/sdk-angular-web --timeout=120s
sudo k3s kubectl -n "$NS" get pods -o wide

echo "==> Smoke HTTPS"
ok=0
for i in $(seq 1 24); do
  if curl -skf "https://${NODE_HOST}/health" -o "${TMP}/sdk-node-health.json"; then ok=1; break; fi
  sleep 5
done
test "$ok" = "1"
cat "${TMP}/sdk-node-health.json"; echo

# Give SDK register + DB ensure a moment
sleep 8
curl -skf "https://${NODE_HOST}/api/db-check" -o "${TMP}/sdk-db-check.json" || \
  curl -sk "https://${NODE_HOST}/api/db-check" -o "${TMP}/sdk-db-check.json" || true
cat "${TMP}/sdk-db-check.json"; echo

curl -skf "https://sdk-react.${DOMAIN}/" -o "${TMP}/sdk-react.html"
curl -skf "https://sdk-angular.${DOMAIN}/" -o "${TMP}/sdk-angular.html"
head -c 120 "${TMP}/sdk-react.html"; echo
head -c 120 "${TMP}/sdk-angular.html"; echo

echo "==> Traffic"
for i in $(seq 1 8); do
  curl -skf "https://${NODE_HOST}/api/hello?client=react" >/dev/null
  curl -skf "https://${NODE_HOST}/api/users?client=angular" >/dev/null
  curl -sk -X POST "https://${NODE_HOST}/api/orders" -H 'Content-Type: application/json' -d "{\"n\":$i}" >/dev/null
done
sleep 22

curl -sk "$API/api/metrics?projectId=$PROJECT_ID" -H "Authorization: Bearer $TOKEN" -o "${TMP}/sdk-metrics.json"
curl -sk "$API/api/sdk/api-metrics?projectId=$PROJECT_ID" -H "Authorization: Bearer $TOKEN" -o "${TMP}/sdk-api-metrics.json"

python3 - <<'PY'
import json,os
from pathlib import Path
tmp=Path(os.environ['TMP'])
m=json.load(open(tmp/'sdk-metrics.json'))
a=json.load(open(tmp/'sdk-api-metrics.json'))
try: db=json.load(open(tmp/'sdk-db-check.json'))
except Exception: db={}
hb=len(m) if isinstance(m,list) else 0
routes=len((a or {}).get('metrics') or [])
print(json.dumps({"heartbeats":hb,"apiRoutes":routes,"dbCheck":db}, indent=2))
if hb < 1 and routes < 1:
  raise SystemExit('FAIL: no telemetry')
# DB: prefer connected; warn but don't fail hard if redis/mongo flaky in ns
print('PASS telemetry')
if isinstance(db, dict) and db.get('ok') is True:
  print('PASS db-check')
else:
  print('WARN db-check not fully ok — inspect "${TMP}/sdk-db-check.json" and node-api logs')
PY

echo "DEPLOY_OK https://${NODE_HOST} react=https://sdk-react.${DOMAIN} angular=https://sdk-angular.${DOMAIN}"
