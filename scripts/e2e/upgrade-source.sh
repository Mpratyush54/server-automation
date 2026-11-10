#!/usr/bin/env bash
# Fetch and checksum the SOURCE release binary, never the candidate binary.
# Run before allocating a VM; old releases without upgrade are an explicit skip.
set -euo pipefail
: "${E2E_WORK:?}" "${GITHUB_REPOSITORY:?}"
mkdir -p "$E2E_WORK/source"
supported=false
if [[ -n "${UPGRADE_FROM:-}" ]]; then
  [[ "$UPGRADE_FROM" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || exit 1
  asset="platformctl_${UPGRADE_FROM#v}_linux_amd64.tar.gz"
  gh release download "$UPGRADE_FROM" -R "$GITHUB_REPOSITORY" -p "$asset" -p checksums.txt -D "$E2E_WORK/source" --clobber
  (
    cd "$E2E_WORK/source"
    awk -v asset="$asset" '$2 == asset || $2 == "*" asset' checksums.txt | sha256sum -c -
    tar -xzf "$asset" platformctl
    chmod +x platformctl
    ./platformctl --help > help.txt
  )
  if grep -Eq '^[[:space:]]+upgrade([[:space:]]|$)' "$E2E_WORK/source/help.txt"; then
    supported=true
  else
    msg="Upgrade skipped: $UPGRADE_FROM predates platformctl upgrade. Install a newer source release to test this path."
    echo "::notice title=Upgrade skipped::$msg"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "$msg" >> "$GITHUB_STEP_SUMMARY"; fi
  fi
fi
echo "supported=$supported" >> "${GITHUB_OUTPUT:-/dev/stdout}"
