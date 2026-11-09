#!/usr/bin/env bash
# Gather logs from the e2e VM and the runner into $E2E_ARTIFACTS, redacted.
# Safe to run after any failure (also when the VM never came up).
set -uo pipefail
source "$(dirname "$0")/lib.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
raw="$E2E_WORK/raw"
rm -rf "$raw"; mkdir -p "$raw"

if [[ -n "$(state_get VM_IP)" ]]; then
  # Secret values to scrub: everything secret-looking in the installer's .env.
  (umask 077; timeout 60 bash -c 'source "$1/lib.sh"; vm_ssh "sudo cat /etc/platform/.env"' _ "$HERE" > "$E2E_WORK/platform.env" 2>/dev/null || true)
  if timeout 600 bash -c 'source "$1/lib.sh"; vm_ssh "sudo bash -s" < "$1/remote/collect.sh"' _ "$HERE" > "$raw/vm.tgz" 2>/dev/null; then
    mkdir -p "$raw/vm" && tar -xzf "$raw/vm.tgz" -C "$raw/vm" 2>/dev/null
  else
    log "could not collect logs from the VM"
  fi
  rm -f "$raw/vm.tgz"
fi
[[ -f "$E2E_WORK/provision-console.log" ]] && cp "$E2E_WORK/provision-console.log" "$raw/"
[[ -d "$E2E_WORK/checks" ]] && cp -R "$E2E_WORK/checks" "$raw/"

python3 "$HERE/redact.py" --env-file "$E2E_WORK/platform.env" --secret-file "$E2E_WORK/admin-password" \
  --json-secrets "$E2E_WORK/db-credentials.json" --out "$E2E_ARTIFACTS/logs" "$raw"/* 2>/dev/null || true
rm -rf "$raw" "$E2E_WORK/platform.env"
log "artifacts collected ($(du -sh "$E2E_ARTIFACTS" 2>/dev/null | cut -f1))"
exit 0
