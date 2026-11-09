#!/usr/bin/env bash
# Copy platformctl to the e2e VM and run a non-interactive provision.
#
#   PLATFORMCTL_BIN   linux/amd64 platformctl binary to test (required)
#   E2E_PROFILE       minimal | full
#   E2E_IMAGE_TAG     platform-api / platform-portal image tag
#   E2E_STACK         PLATFORM_STACK channel or version (optional)
#   E2E_ADMIN_EMAIL   default admin@example.com (reserved domain: no ACME contact)
#
# The console output contains the admin password, so it is written to the
# private work dir only; collect.sh publishes a redacted copy.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

: "${PLATFORMCTL_BIN:?}" "${E2E_PROFILE:?}" "${E2E_IMAGE_TAG:?}"
domain="$(state_get DOMAIN)"
[[ -n "$domain" ]] || die "no VM recorded; run aws-vm.sh launch first"
email="${E2E_ADMIN_EMAIL:-admin@example.com}"
for v in "$E2E_PROFILE" "$E2E_IMAGE_TAG" "${E2E_STACK:-}" "$email" "$domain"; do
  [[ "$v" =~ ^[A-Za-z0-9@._-]*$ ]] || die "unsafe provision parameter"
done

vm_scp "$PLATFORMCTL_BIN" /tmp/platformctl
vm_ssh 'sudo install -m 0755 /tmp/platformctl /usr/local/bin/platformctl && rm -f /tmp/platformctl && platformctl version' \
  | sed -n '1p' | sed 's/^/[e2e] platformctl: /'

# Settings travel over SSH stdin into a root-only file, never on a command line.
{
  echo "DOMAIN=$domain"
  echo "ADMIN_EMAIL=$email"
  echo "ADMIN_PASSWORD=$(admin_password)"
  echo "PLATFORM_IMAGE_TAG=$E2E_IMAGE_TAG"
  echo "PLATFORM_PROFILE=$E2E_PROFILE"
  if [[ -n "${E2E_STACK:-}" ]]; then echo "PLATFORM_STACK=$E2E_STACK"; fi
  echo "NON_INTERACTIVE=true"
} | vm_ssh 'sudo sh -c "umask 077; cat > /root/platform-e2e.env"'

log "provisioning profile=$E2E_PROFILE images=$E2E_IMAGE_TAG stack=${E2E_STACK:-default}"
start=$(date +%s)
rc=0
vm_ssh 'sudo bash -c '\''set -a; . /root/platform-e2e.env; set +a; exec platformctl provision --auto --profile "$PLATFORM_PROFILE"'\''' \
  > "$E2E_WORK/provision-console.log" 2>&1 || rc=$?
secs=$(( $(date +%s) - start ))
status=ok
[[ $rc -eq 0 ]] || status=failed
phase provision "$status" "$secs"

vm_ssh 'cat /var/log/platformctl/timings.json' > "$E2E_ARTIFACTS/timings.json" 2>/dev/null || rm -f "$E2E_ARTIFACTS/timings.json"
vm_ssh 'cat /var/log/platformctl/timings.txt' > "$E2E_ARTIFACTS/timings.txt" 2>/dev/null || rm -f "$E2E_ARTIFACTS/timings.txt"
if [[ -s "$E2E_ARTIFACTS/timings.txt" ]]; then cat "$E2E_ARTIFACTS/timings.txt"; fi

if [[ $rc -ne 0 ]]; then
  log "provision FAILED after ${secs}s (exit $rc); last lines (redacted):"
  python3 "$(dirname "$0")/redact.py" --secret-file "$E2E_WORK/admin-password" --stdout "$E2E_WORK/provision-console.log" | tail -n 40
  exit 1
fi
log "provision ok in ${secs}s"
