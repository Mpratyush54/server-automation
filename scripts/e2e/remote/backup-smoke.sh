#!/usr/bin/env bash
# Runs ON the e2e VM as root (ssh ... 'sudo bash -s' < backup-smoke.sh).
# Encrypted backup to a local file:// target, then the automated restore test
# (decrypts the newest backup and restores Postgres into a disposable database).
# The age identity exists only in this shell's memory.
#
# MinIO is left out: it needs the `mc` client, which a fresh server lacks.
set -euo pipefail
umask 077
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml DEBIAN_FRONTEND=noninteractive

if ! command -v sqlite3 >/dev/null || ! command -v jq >/dev/null; then
  apt-get update -qq >/dev/null
  apt-get install -y -qq sqlite3 jq >/dev/null
fi

# Overridable so unit tests never touch host paths.
target=${E2E_BACKUP_TARGET:-file:///var/lib/platform/e2e-backups}
cfg=${E2E_BACKUP_CONFIG:-/root/e2e-backup.json}
rm -f "$cfg"
identity=$(platformctl backup init --backup-config "$cfg" --target "$target" \
  --components config,postgres,mongo,redis,k3s 2>/dev/null | grep -m1 '^AGE-SECRET-KEY-' || true)
[[ -n "$identity" ]] || { echo "backup init did not produce an identity" >&2; exit 1; }
echo "  backup configured (file target, components config,postgres,mongo,redis,k3s)"

out=$(platformctl backup --all --backup-config "$cfg")
id=$(printf '%s\n' "$out" | grep -E '^[0-9A-Za-z._-]+$' | tail -n 1 || true)
[[ -n "$id" ]] || { echo "backup --all printed no backup ID" >&2; exit 1; }
echo "  encrypted backup created"
listing=$(platformctl backup list --backup-config "$cfg")
[[ "$listing" == *"$id"* ]] || { echo "backup not listed" >&2; exit 1; }
echo "  backup listed as complete"

printf '%s\n' "$identity" | platformctl backup restore-test --backup-config "$cfg" --from "$id"
unset identity
echo "  restore test passed"
