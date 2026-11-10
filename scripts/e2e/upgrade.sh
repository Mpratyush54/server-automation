#!/usr/bin/env bash
# Orchestrate seed/verify/upgrade using the existing SSH and TLS helpers.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  apply)
    : "${UPGRADE_TO:?}"
    [[ "$UPGRADE_TO" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid target tag"
    mkdir -p "$E2E_WORK/checks"
    start=$(date +%s)
    rc=0
    vm_ssh "sudo platformctl upgrade --to '$UPGRADE_TO' --yes" > "$E2E_WORK/checks/upgrade.log" 2>&1 || rc=$?
    status=ok; [[ $rc -eq 0 ]] || status=failed
    phase upgrade "$status" "$(( $(date +%s) - start ))"
    exit "$rc"
    ;;
  seed|verify)
    export E2E_DOMAIN; E2E_DOMAIN="$(state_get DOMAIN)"
    export PLATFORM_URL="https://api.$E2E_DOMAIN"
    export ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-admin@example.com}"
    export E2E_ADMIN_PASSWORD_FILE="$E2E_WORK/admin-password"
    vm_ssh 'sudo kubectl -n cert-manager get secret platform-ca -o jsonpath="{.data.ca\.crt}"' | base64 -d > "$E2E_WORK/platform-ca.pem"
    node "$HERE/checks/tls.mjs" "$E2E_WORK/platform-ca.pem" "$E2E_WORK/tls-mode" "api.$E2E_DOMAIN"
    if [[ "$(cat "$E2E_WORK/tls-mode")" == platform-ca ]]; then export NODE_EXTRA_CA_CERTS="$E2E_WORK/platform-ca.pem"; fi
    mkdir -p "$E2E_WORK/checks"
    status=pass
    node "$HERE/checks/upgrade-seed.mjs" "$1" "$E2E_WORK/upgrade-seed.json" > "$E2E_WORK/checks/upgrade-$1.log" 2>&1 || status=fail
    printf '{"name":"upgrade-%s","status":"%s","seconds":0}\n' "$1" "$status" >> "$E2E_ARTIFACTS/results.jsonl"
    [[ "$status" == pass ]]
    ;;
  *) die "usage: upgrade.sh seed|apply|verify" ;;
esac
