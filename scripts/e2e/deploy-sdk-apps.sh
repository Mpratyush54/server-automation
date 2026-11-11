#!/usr/bin/env bash
# Deploy examples/sdk-apps (Node API + React + Angular) to the e2e VM and check
# them end to end: HTTPS ingress, SDK register, per-engine database access from
# the project namespace (/api/db-check) and telemetry reaching the platform.
#
# Same flow as scripts/vps-deploy-sdk-apps.sh, but the images are built on the
# CI runner and streamed into k3s over SSH, and kubectl uses the SSH tunnel.
# Needs: KUBECONFIG, E2E_DOMAIN, PLATFORM_URL, ADMIN_EMAIL, E2E_TLS_MODE_FILE,
# E2E_PLATFORM_CA (when the platform uses its internal CA).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

DOMAIN="${E2E_DOMAIN:?}"
API="${PLATFORM_URL:?}"
NS="sdk-demo-apps-development"
NODE_HOST="sdk-demo-apps-development.${DOMAIN}"
TMP="$E2E_WORK/sdk-apps"
rm -rf "$TMP"; mkdir -p "$TMP"; chmod 700 "$TMP"
tls_mode="$(cat "${E2E_TLS_MODE_FILE:-/dev/null}" 2>/dev/null || echo public)"
curl_ca=()
if [[ "$tls_mode" == platform-ca ]]; then curl_ca=(--cacert "$E2E_PLATFORM_CA"); fi
c() { curl -fsS --max-time 30 "${curl_ca[@]}" "$@"; }

step() { echo "  -- $*"; }

step "login and project"
# Admins sign in with a second factor (#24): the helper completes the MFA challenge
# with the stored TOTP secret and prints the session token for capture (never echoed).
TOKEN=$(E2E_ADMIN_PASSWORD_FILE="${E2E_ADMIN_PASSWORD_FILE:-$E2E_WORK/admin-password}" node "$E2E_ROOT/scripts/e2e/checks/admin-token.mjs") \
  || die "admin login failed"
[[ -n "$TOKEN" ]] || die "admin login failed"
auth=(-H "Authorization: Bearer $TOKEN")
PROJECT_ID=$(c "${auth[@]}" "$API/api/projects" | jq -r '[.[] | select(.name=="sdk-demo-apps")][0].id // empty')
if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID=$(jq -n --arg d "$DOMAIN" '{name:"sdk-demo-apps",stack:"nodejs",repositoryUrl:"https://github.com/Mpratyush54/server-automation.git",domain:$d}' \
    | c -X POST "${auth[@]}" -H 'Content-Type: application/json' --data @- "$API/api/projects" | jq -r .id)
fi
[[ "$PROJECT_ID" =~ ^[A-Za-z0-9-]+$ ]] || die "could not create the sdk-demo-apps project"
(umask 077; c -X POST "${auth[@]}" -H 'Content-Type: application/json' -d '{"name":"e2e-sdk-apps"}' \
  "$API/api/projects/$PROJECT_ID/tokens" | jq -r '.token // .plaintext // .key // empty' > "$TMP/sdk-token")
[[ -s "$TMP/sdk-token" ]] || die "could not create an SDK token"

step "build images on the runner"
cd "$E2E_ROOT"
# Host network: the platform's host firewall drops forwarded traffic from
# docker0 when the harness runs on the VM itself (npm installs then hang).
docker build --network host -q -f examples/sdk-apps/node-api/Dockerfile -t sdk-node-api:local . >/dev/null
docker build --network host -q -f examples/sdk-apps/react-web/Dockerfile --build-arg "VITE_API_URL=https://${NODE_HOST}" -t sdk-react-web:local . >/dev/null
docker build --network host -q -f examples/sdk-apps/angular-web/Dockerfile -t sdk-angular-web:local . >/dev/null

step "import images into k3s"
for img in sdk-node-api sdk-react-web sdk-angular-web; do
  docker save "$img:local" | vm_ssh 'sudo k3s ctr images import - >/dev/null'
done

step "apply manifests"
# The cluster issuer the platform itself uses (Let's Encrypt or its internal CA fallback).
issuer=$(kubectl -n platform get ingress -o jsonpath='{range .items[*]}{.metadata.annotations.cert-manager\.io/cluster-issuer}{"\n"}{end}' 2>/dev/null | grep -m1 . || true)
[[ "$issuer" =~ ^[a-z0-9-]+$ ]] || issuer=letsencrypt-prod
# GITOPS=0: Argo CD would otherwise sync the placeholder manifests from the
# default branch over this deployment. node-api starts at 0 replicas so the
# CA trust patch below lands before its first start (SDK register).
SDK_TOKEN_FILE="$TMP/sdk-token" ISSUER="$issuer" DOMAIN="$DOMAIN" API="$API" python3 - "$E2E_ROOT/examples/sdk-apps/k8s/all.yaml" > "$TMP/all.yaml" <<'PY'
import os, sys
text = open(sys.argv[1], encoding="utf-8").read()
token = open(os.environ["SDK_TOKEN_FILE"], encoding="utf-8").read().strip()
text = text.replace('"REPLACE_ME"', '"' + token + '"').replace("https://api.__DOMAIN__", os.environ["API"])
text = text.replace("__DOMAIN__", os.environ["DOMAIN"]).replace("cluster-issuer: letsencrypt-prod", "cluster-issuer: " + os.environ["ISSUER"])
marker = '            - name: PORT\n              value: "4100"\n'
assert marker in text, "node-api env block not found"
text = text.replace(marker, marker + '            - name: GITOPS\n              value: "0"\n', 1)
head, sep, rest = text.partition("  name: sdk-node-api\n")
assert sep, "node-api deployment not found"
rest = rest.replace("  replicas: 1\n", "  replicas: 0\n", 1)
sys.stdout.write(head + sep + rest)
PY
chmod 600 "$TMP/all.yaml"
kubectl apply -f "$TMP/all.yaml" >/dev/null
rm -f "$TMP/all.yaml"
if [[ "$tls_mode" == platform-ca ]]; then
  kubectl -n "$NS" create configmap platform-ca --from-file=ca.crt="$E2E_PLATFORM_CA" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl -n "$NS" patch deployment sdk-node-api --type=strategic -p '{"spec":{"template":{"spec":{"volumes":[{"name":"platform-ca","configMap":{"name":"platform-ca"}}],"containers":[{"name":"api","env":[{"name":"NODE_EXTRA_CA_CERTS","value":"/etc/platform-ca/ca.crt"}],"volumeMounts":[{"name":"platform-ca","mountPath":"/etc/platform-ca","readOnly":true}]}]}}}}' >/dev/null
fi
kubectl -n "$NS" scale deployment sdk-node-api --replicas=1 >/dev/null

step "browser telemetry secret (sdk-demo-rum)"
# Faro/replay/heatmaps/errors endpoints and tokens for the web demos; read as
# RUM_* env at container start, so it must exist before the restart below.
E2E_ADMIN_TOKEN="$TOKEN" PROJECT_ID="$PROJECT_ID" SDK_TOKEN_FILE="$TMP/sdk-token" \
  node "$E2E_ROOT/scripts/e2e/sdk-demo-rum.mjs" || die "could not write the sdk-demo-rum secret"

step "restart deployments on the new images"
# The tags stay :local, so apply alone leaves existing pods on the previous
# build; a restart makes them pick up the images imported above.
kubectl -n "$NS" rollout restart deploy/sdk-node-api deploy/sdk-react-web deploy/sdk-angular-web >/dev/null

step "wait for rollouts"
kubectl -n "$NS" rollout status deploy/sdk-node-api --timeout=300s >/dev/null
kubectl -n "$NS" rollout status deploy/sdk-react-web --timeout=180s >/dev/null
kubectl -n "$NS" rollout status deploy/sdk-angular-web --timeout=180s >/dev/null

step "TLS certificates"
# Until cert-manager issues them, ingress serves its self-signed default
# certificate and the HTTPS checks below fail (flaky right after apply).
if ! kubectl -n "$NS" wait certificate --all --for=condition=Ready --timeout=300s >/dev/null 2>&1; then
  echo "     WARN: certificates not Ready after 300s:"
  kubectl -n "$NS" get certificate 2>&1 | sed 's/^/       /' || true
fi

step "HTTPS health"
# https_ok URL: retry for up to 3 minutes (certificate hand-over, ingress reload).
https_ok() {
  local _
  for _ in $(seq 1 36); do
    if c "$1" -o /dev/null 2>/dev/null; then return 0; fi
    sleep 5
  done
  c "$1" -o /dev/null # final attempt shows the error
}
https_ok "https://${NODE_HOST}/health" || die "node-api is not reachable over HTTPS"
https_ok "https://sdk-react.${DOMAIN}/" || die "react-web is not reachable over HTTPS"
https_ok "https://sdk-angular.${DOMAIN}/" || die "angular-web is not reachable over HTTPS"

step "databases from the project namespace (postgres, mongo, redis)"
db_ok=0
for _ in $(seq 1 24); do
  if curl -sS --max-time 30 "${curl_ca[@]}" "https://${NODE_HOST}/api/db-check" -o "$TMP/db-check.json" \
     && jq -e '.ok == true and .postgres.ok == true and .mongo.ok == true and .redis.ok == true' "$TMP/db-check.json" >/dev/null; then
    db_ok=1; break
  fi
  sleep 5
done
for e in postgres mongo redis; do
  printf '     %s: %s\n' "$e" "$(jq -r --arg e "$e" 'if .[$e].ok == true then "ok" else "FAIL" end' "$TMP/db-check.json" 2>/dev/null || echo FAIL)"
done
[[ $db_ok -eq 1 ]] || die "db-check did not report every engine healthy"

step "traffic and telemetry"
for i in $(seq 1 8); do
  c "https://${NODE_HOST}/api/hello?client=react" -o /dev/null || true
  c "https://${NODE_HOST}/api/users?client=angular" -o /dev/null || true
  c -X POST "https://${NODE_HOST}/api/orders" -H 'Content-Type: application/json' -d "{\"n\":$i}" -o /dev/null || true
done
tele=0
for _ in $(seq 1 12); do
  sleep 10
  hb=$(c "${auth[@]}" "$API/api/metrics?projectId=$PROJECT_ID" | jq 'if type=="array" then length else 0 end' 2>/dev/null || echo 0)
  routes=$(c "${auth[@]}" "$API/api/sdk/api-metrics?projectId=$PROJECT_ID" | jq '(.metrics // []) | length' 2>/dev/null || echo 0)
  if [[ "${hb:-0}" -ge 1 || "${routes:-0}" -ge 1 ]]; then tele=1; break; fi
done
echo "     heartbeats=${hb:-0} api-routes=${routes:-0}"
[[ $tele -eq 1 ]] || die "no heartbeats/API metrics from the deployed node-api"
rm -f "$TMP/sdk-token"
echo "  sdk-apps deployed and verified"
