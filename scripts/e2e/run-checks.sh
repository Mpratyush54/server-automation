#!/usr/bin/env bash
# Functional and security regression suite against the provisioned e2e VM.
# Runs on the CI runner: HTTP checks go over the public sslip.io domain (as a
# user would), cluster checks use kubectl through an SSH tunnel to the VM's
# Kubernetes API, host checks run over SSH.
#
# Prints one PASS/FAIL/SKIP line per check. Full output of every check goes to
# $E2E_WORK/checks (redacted into the artifact by collect.sh). Results are
# appended to $E2E_ARTIFACTS/results.jsonl. Exits 1 if any check failed.
#
#   E2E_PROFILE   minimal | full (Argo CD, Grafana, Portainer only on full)
#   E2E_ONLY      optional space-separated list of check names to run
set -uo pipefail
source "$(dirname "$0")/lib.sh"

: "${E2E_PROFILE:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export E2E_DOMAIN; E2E_DOMAIN="$(state_get DOMAIN)"
[[ -n "$E2E_DOMAIN" ]] || die "no VM recorded"
export PLATFORM_URL="https://api.${E2E_DOMAIN}"
export PROJECT_DOMAIN="$E2E_DOMAIN"
export ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-admin@example.com}"
export E2E_ADMIN_PASSWORD_FILE="$E2E_WORK/admin-password"
export E2E_PLATFORM_CA="$E2E_WORK/platform-ca.pem"
export E2E_TLS_MODE_FILE="$E2E_WORK/tls-mode"
CHECK_DIR="$E2E_WORK/checks"
mkdir -p "$CHECK_DIR"
: > "$E2E_ARTIFACTS/results.jsonl"
failed=0

# --- Kubernetes API through SSH ------------------------------------------------
kport=16443
mapfile -t sshopts < <(ssh_opts)
ssh "${sshopts[@]}" -o ExitOnForwardFailure=yes -N -L "127.0.0.1:${kport}:127.0.0.1:6443" "ubuntu@$(state_get VM_IP)" &
tunnel=$!
trap 'kill $tunnel 2>/dev/null' EXIT
(umask 077; vm_ssh 'sudo cat /etc/rancher/k3s/k3s.yaml' | sed "s#server: https://[^ ]*#server: https://127.0.0.1:${kport}#" > "$E2E_WORK/kubeconfig")
export KUBECONFIG="$E2E_WORK/kubeconfig"
for _ in $(seq 1 15); do kubectl get --raw /readyz >/dev/null 2>&1 && break; sleep 2; done
kubectl -n cert-manager get secret platform-ca -o jsonpath='{.data.ca\.crt}' 2>/dev/null | base64 -d > "$E2E_PLATFORM_CA" 2>/dev/null || true

# check NAME CMD...: run one check with a 15-minute cap.
check() {
  local name=$1 start secs status; shift
  if [[ -n "${E2E_ONLY:-}" && " $E2E_ONLY " != *" $name "* ]]; then return 0; fi
  start=$(date +%s)
  if timeout 900 "$@" > "$CHECK_DIR/$name.log" 2>&1; then status=pass; else status=fail; failed=1; fi
  secs=$(( $(date +%s) - start ))
  printf '%-4s %-28s %4ss\n' "${status^^}" "$name" "$secs"
  printf '{"name":"%s","status":"%s","seconds":%s}\n' "$name" "$status" "$secs" >> "$E2E_ARTIFACTS/results.jsonl"
}
skip() {
  printf 'SKIP %-28s (%s)\n' "$1" "$2"
  printf '{"name":"%s","status":"skip","seconds":0,"reason":"%s"}\n' "$1" "$2" >> "$E2E_ARTIFACTS/results.jsonl"
}
full_only() { # full_only NAME CMD...
  if [[ "$E2E_PROFILE" == full ]]; then check "$@"; else skip "$1" "not installed by the $E2E_PROFILE profile"; fi
}

N=(node)
tls_hosts=("$E2E_DOMAIN" "api.$E2E_DOMAIN")
if [[ "$E2E_PROFILE" == full ]]; then tls_hosts+=("portainer.$E2E_DOMAIN"); fi

echo "== checks (profile $E2E_PROFILE)"
check tls-validity "${N[@]}" "$HERE/checks/tls.mjs" "$E2E_PLATFORM_CA" "$E2E_TLS_MODE_FILE" "${tls_hosts[@]}"
if [[ "$(cat "$E2E_TLS_MODE_FILE" 2>/dev/null)" == platform-ca ]]; then
  # Let's Encrypt was unavailable and the platform fell back to its own CA:
  # trust it explicitly (verification stays on).
  export NODE_EXTRA_CA_CERTS="$E2E_PLATFORM_CA"
  echo "     note: certificates come from the platform's internal CA (Let's Encrypt fallback)"
fi
check api-health            "${N[@]}" "$HERE/checks/api.mjs" health
check admin-login           "${N[@]}" "$HERE/checks/api.mjs" login
check security-unauth       "${N[@]}" "$HERE/checks/security.mjs" unauth
check security-headers      "${N[@]}" "$HERE/checks/security.mjs" headers
check sdk-register-logs-metrics "${N[@]}" "$E2E_ROOT/scripts/e2e-sdk-live.mjs"
check db-credentials-issue  "${N[@]}" "$HERE/checks/db-credentials.mjs" fetch "$E2E_WORK/db-credentials.json"
for engine in postgres mongo redis; do
  if [[ -s "$E2E_WORK/db-credentials.json" ]]; then
    check "db-$engine" "${N[@]}" "$HERE/checks/db-credentials.mjs" verify "$engine" "$E2E_WORK/db-credentials.json"
  else
    check "db-$engine" false
  fi
done
check sdk-apps-deploy       bash "$HERE/deploy-sdk-apps.sh"
check sso-oidc-discovery    "${N[@]}" "$HERE/checks/sso.mjs" discovery
full_only sso-grafana       "${N[@]}" "$HERE/checks/sso.mjs" grafana
full_only sso-argocd        "${N[@]}" "$HERE/checks/sso.mjs" argocd
full_only sso-portainer     "${N[@]}" "$HERE/checks/sso.mjs" portainer
full_only argocd-sync       bash "$HERE/argocd-sync.sh"
check tenant-isolation      bash -c 'cd "$1/platform/api" && node scripts/test-namespace-isolation.mjs' _ "$E2E_ROOT"
check backup-restore        bash -c 'source "$1/lib.sh" && vm_ssh "sudo bash -s" < "$1/remote/backup-smoke.sh"' _ "$HERE"

npass=$(grep -c "\"status\":\"pass\"" "$E2E_ARTIFACTS/results.jsonl" || true)
nfail=$(grep -c "\"status\":\"fail\"" "$E2E_ARTIFACTS/results.jsonl" || true)
nskip=$(grep -c "\"status\":\"skip\"" "$E2E_ARTIFACTS/results.jsonl" || true)
echo "== $npass passed, $nfail failed, $nskip skipped"
exit $failed
