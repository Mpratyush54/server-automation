#!/usr/bin/env bash
# Mirror the pinned k3s release to GHCR (versions.K3sMirror) as an OCI artifact
# with three files: k3s (amd64), k3s-arm64 and install.sh. platformctl installs
# from it when get.k3s.io / GitHub Releases is unavailable.
#
# Usage: scripts/mirror-k3s.sh charts.json   (output of `platformctl charts --json`)
# Requires: curl, jq, sha256sum, oras (logged in to ghcr.io with write access).
# Downloads from github.com send $GITHUB_TOKEN when set.
set -euo pipefail

cfg="${1:?usage: $0 charts.json}"
version="$(jq -er .k3s "$cfg")"
ref="$(jq -er .k3sMirror "$cfg"):${version//+/-}"

if oras manifest fetch "$ref" >/dev/null 2>&1; then
  echo "present  $ref"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

fetch() { # fetch <url> <file>
  local auth=()
  if [[ -n "${GITHUB_TOKEN:-}" && "$1" == https://github.com/* ]]; then
    auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  fi
  curl -fsSL --retry 6 --retry-delay 10 --retry-all-errors "${auth[@]}" -o "$2" "$1"
}

base="https://github.com/k3s-io/k3s/releases/download/${version//+/%2B}"
for f in k3s k3s-arm64 sha256sum-amd64.txt sha256sum-arm64.txt; do
  fetch "$base/$f" "$f"
done
# Verify the binaries against the release checksums.
grep -h -E '  (k3s|k3s-arm64)$' sha256sum-amd64.txt sha256sum-arm64.txt | sha256sum -c -

# The install script for this exact release (get.k3s.io serves the latest one).
fetch "https://raw.githubusercontent.com/k3s-io/k3s/${version//+/%2B}/install.sh" install.sh \
  || fetch "https://get.k3s.io" install.sh
head -1 install.sh | grep -q '^#!/bin/sh' || { echo "install.sh does not look like a shell script" >&2; exit 1; }

oras push "$ref" --artifact-type application/vnd.platform.k3s.v1 \
  k3s:application/octet-stream k3s-arm64:application/octet-stream install.sh:text/x-shellscript
echo "mirrored $ref"
