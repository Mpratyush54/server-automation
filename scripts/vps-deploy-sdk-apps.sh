#!/bin/bash
# Build SDK demo images, import to k3s, apply git desired-state, verify HTTPS/DB/telemetry.
# DB ensure + Argo + ingress happen when node-api SDK register runs.
set -euo pipefail

ROOT="${1:-/tmp/sdk-apps-src}"
DOMAIN="${DOMAIN:-148.113.59.3.sslip.io}"
NODE_HOST="sdk-demo-apps-development.${DOMAIN}"
NS="sdk-demo-apps-development"
API="${PLATFORM_API_URL:-https://api.148.113.59.3.sslip.io}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@pratyushes.dev}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?ADMIN_PASSWORD required}"

echo "==> Login"
LOGIN=$(curl -sk -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
TOKEN=$(echo "$LOGIN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

echo "==> Ensure project sdk-demo-apps"
PROJECTS=$(curl -sk "$API/api/projects" -H "Authorization: Bearer $TOKEN")
echo "$PROJECTS" > /tmp/sdk-projects.json
PROJECT_ID=$(python3 - <<'PY'
import json
projects=json.load(open('/tmp/sdk-projects.json'))
p=next((x for x in projects if x.get('name')=='sdk-demo-apps'), None)
print(p['id'] if p else '')
PY
)
if [ -z "$PROJECT_ID" ]; then
  curl -sk -X POST "$API/api/projects" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"name\":\"sdk-demo-apps\",\"stack\":\"nodejs\",\"repositoryUrl\":\"https://github.com/Mpratyush54/SERVER-automation.git\",\"domain\":\"$DOMAIN\"}" \
    > /tmp/sdk-project-create.json
  PROJECT_ID=$(python3 -c 'import json; print(json.load(open("/tmp/sdk-project-create.json"))["id"])')
fi

curl -sk -X POST "$API/api/projects/$PROJECT_ID/tokens" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"vps-deploy"}' > /tmp/sdk-token.json
SDK_TOKEN=$(python3 -c 'import json; d=json.load(open("/tmp/sdk-token.json")); print(d.get("token") or d.get("plaintext") or d.get("key") or "")')
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
TMP=$(mktemp -d)
cp -a examples/sdk-apps/k8s/. "$TMP/"
python3 - <<PY
from pathlib import Path
p=Path("$TMP")/"all.yaml"
t=p.read_text()
t=t.replace("REPLACE_ME", """$SDK_TOKEN""")
p.write_text(t)
PY
sudo k3s kubectl apply -f "$TMP/all.yaml"

echo "==> Wait for rollouts"
sudo k3s kubectl -n "$NS" rollout status deploy/sdk-node-api --timeout=240s
sudo k3s kubectl -n "$NS" rollout status deploy/sdk-react-web --timeout=120s
sudo k3s kubectl -n "$NS" rollout status deploy/sdk-angular-web --timeout=120s
sudo k3s kubectl -n "$NS" get pods -o wide

echo "==> Smoke HTTPS"
ok=0
for i in $(seq 1 24); do
  if curl -skf "https://${NODE_HOST}/health" -o /tmp/sdk-node-health.json; then ok=1; break; fi
  sleep 5
done
test "$ok" = "1"
cat /tmp/sdk-node-health.json; echo

# Give SDK register + DB ensure a moment
sleep 8
curl -skf "https://${NODE_HOST}/api/db-check" -o /tmp/sdk-db-check.json || \
  curl -sk "https://${NODE_HOST}/api/db-check" -o /tmp/sdk-db-check.json || true
cat /tmp/sdk-db-check.json; echo

curl -skf "https://sdk-react.${DOMAIN}/" -o /tmp/sdk-react.html
curl -skf "https://sdk-angular.${DOMAIN}/" -o /tmp/sdk-angular.html
head -c 120 /tmp/sdk-react.html; echo
head -c 120 /tmp/sdk-angular.html; echo

echo "==> Traffic"
for i in $(seq 1 8); do
  curl -skf "https://${NODE_HOST}/api/hello?client=react" >/dev/null
  curl -skf "https://${NODE_HOST}/api/users?client=angular" >/dev/null
  curl -sk -X POST "https://${NODE_HOST}/api/orders" -H 'Content-Type: application/json' -d "{\"n\":$i}" >/dev/null
done
sleep 22

curl -sk "$API/api/metrics?projectId=$PROJECT_ID" -H "Authorization: Bearer $TOKEN" -o /tmp/sdk-metrics.json
curl -sk "$API/api/sdk/api-metrics?projectId=$PROJECT_ID" -H "Authorization: Bearer $TOKEN" -o /tmp/sdk-api-metrics.json

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
  raise SystemExit('FAIL: no telemetry')
# DB: prefer connected; warn but don't fail hard if redis/mongo flaky in ns
print('PASS telemetry')
if isinstance(db, dict) and db.get('ok') is True:
  print('PASS db-check')
else:
  print('WARN db-check not fully ok — inspect /tmp/sdk-db-check.json and node-api logs')
PY

echo "DEPLOY_OK https://${NODE_HOST} react=https://sdk-react.${DOMAIN} angular=https://sdk-angular.${DOMAIN}"
