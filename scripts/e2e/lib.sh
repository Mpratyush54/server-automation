# shellcheck shell=bash
# Shared helpers for the e2e scripts (sourced, not executed).
#
# E2E_WORK is a private directory (keys, kubeconfig, admin password, raw logs).
# It is never uploaded. E2E_ARTIFACTS holds only redacted files and is uploaded
# as the workflow artifact.

: "${E2E_WORK:?E2E_WORK must point to a private work directory}"
E2E_ARTIFACTS="${E2E_ARTIFACTS:-$E2E_WORK/artifacts}"
E2E_STATE="$E2E_WORK/state.env"
# shellcheck disable=SC2034 # used by the scripts that source this file
E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_HOST_ALIAS="platform-e2e-vm"
mkdir -p "$E2E_WORK" "$E2E_ARTIFACTS"
export E2E_WORK E2E_ARTIFACTS
chmod 700 "$E2E_WORK"

log() { printf '[e2e] %s\n' "$*"; }
die() { printf '[e2e] ERROR: %s\n' "$*" >&2; exit 1; }

# state_set KEY VALUE: remember a value across steps (values are plain tokens).
state_set() {
  [[ "$1" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "bad state key: $1"
  [[ "$2" =~ ^[A-Za-z0-9._:/@-]*$ ]] || die "refusing unsafe value for $1"
  touch "$E2E_STATE"
  grep -v "^$1=" "$E2E_STATE" > "$E2E_STATE.tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$E2E_STATE.tmp"
  mv "$E2E_STATE.tmp" "$E2E_STATE"
}

# state_get KEY: print a remembered value (empty if unset).
state_get() {
  [[ -f "$E2E_STATE" ]] || return 0
  sed -n "s/^$1=//p" "$E2E_STATE" | tail -n 1
}

# phase NAME STATUS SECONDS: record a workflow phase for the job summary.
phase() {
  printf '{"phase":"%s","status":"%s","seconds":%s}\n' "$1" "$2" "$3" >> "$E2E_ARTIFACTS/phases.jsonl"
}

ssh_opts() {
  printf '%s\n' -i "$E2E_WORK/id_ed25519" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$E2E_WORK/known_hosts" \
    -o HostKeyAlias="$E2E_HOST_ALIAS" -o ConnectTimeout=15 -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=6 -o LogLevel=ERROR
}

# vm_ssh CMD...: run a command on the VM as the default ubuntu user.
vm_ssh() {
  local ip opts
  ip="$(state_get VM_IP)"
  [[ -n "$ip" ]] || die "no VM address recorded"
  mapfile -t opts < <(ssh_opts)
  ssh "${opts[@]}" "ubuntu@$ip" "$@"
}

# vm_scp SRC DEST_ON_VM
vm_scp() {
  local ip opts
  ip="$(state_get VM_IP)"
  [[ -n "$ip" ]] || die "no VM address recorded"
  mapfile -t opts < <(ssh_opts)
  scp -q "${opts[@]}" "$1" "ubuntu@$ip:$2"
}

admin_password() { cat "$E2E_WORK/admin-password"; }

# The VM's address and domain must not be echoed into public logs.
mask() { if [[ -n "${GITHUB_ACTIONS:-}" && -n "$1" ]]; then echo "::add-mask::$1"; fi; }
