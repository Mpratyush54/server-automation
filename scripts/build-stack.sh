#!/usr/bin/env bash
# Build (and optionally push) the platform stack: one OCI artifact on GHCR that
# carries everything a server needs besides platformctl and the platform's own
# API/portal images: every third-party image (databases, MinIO, Grafana,
# Prometheus, Loki, Argo CD, ingress-nginx, cert-manager, Portainer, ...), every
# pinned Helm chart, and k3s (binary, install script, airgap images).
#
#   ghcr.io/mpratyush54/platform-stack:<stack-version>-<arch>
#
# Each file is its own layer, so `platformctl provision` downloads them in
# parallel; k3s imports the image tarballs directly at start-up. The stack is
# versioned independently of platformctl releases; servers record the digest
# they installed.
#
# Usage: scripts/build-stack.sh <stack-version> <arch>
# Environment:
#   PUSH=1        push to $STACK_REPO (requires `oras login ghcr.io`)
#   CHANNEL       also tag <channel>-<arch> (e.g. stable) after pushing
#   STACK_REPO    default ghcr.io/mpratyush54/platform-stack
#   OUT_DIR       where the layer files are written (default <repo>/dist/stack-<arch>)
#   IMAGE_GROUPS  image tarballs to split into (default 4)
# Requires: everything build-bundle.sh needs, plus oras when PUSH=1.
# Downloads from github.com send $GITHUB_TOKEN when set.
set -euo pipefail

die() { echo "build-stack: error: $*" >&2; exit 1; }
log() { echo "build-stack: $*" >&2; }

[[ $# -eq 2 ]] || die "usage: $0 <stack-version> <arch>"
STACK_VERSION="$1"
ARCH="$2"
[[ "$STACK_VERSION" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(-[0-9]+)?$ ]] || die "stack version must look like 2026.11.08 or 2026.11.08-2"
case "$ARCH" in amd64|arm64) ;; *) die "unsupported arch '$ARCH'" ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_REPO="${STACK_REPO:-ghcr.io/mpratyush54/platform-stack}"
OUT_DIR="${OUT_DIR:-$ROOT/dist/stack-$ARCH}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. Images, charts and k3s airgap images (shared with the offline bundle).
STAGE_ONLY="$WORK/stage" IMAGE_GROUPS="${IMAGE_GROUPS:-4}" "$ROOT/scripts/build-bundle.sh" "stack-$STACK_VERSION" "$ARCH"
manifest="$WORK/stage/manifest.json"
k3s_version="$(jq -er .k3s "$manifest")"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp "$WORK/stage/k3s/"*.tar.zst "$WORK/stage/images/"*.tar.zst "$OUT_DIR/"
for f in "$WORK/stage/charts/"*.tgz; do cp "$f" "$OUT_DIR/chart-${f##*/}"; done

# 2. The k3s binary and the install script of that exact release.
fetch() { # fetch <url> <file>
  local auth=()
  if [[ -n "${GITHUB_TOKEN:-}" && "$1" == https://github.com/* ]]; then
    auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  fi
  curl -fsSL --retry 6 --retry-delay 10 --retry-all-errors "${auth[@]}" -o "$2" "$1"
}
tag_enc="${k3s_version//+/%2B}"
bin="k3s"; [[ "$ARCH" == arm64 ]] && bin="k3s-arm64"
fetch "https://github.com/k3s-io/k3s/releases/download/$tag_enc/$bin" "$OUT_DIR/k3s"
fetch "https://github.com/k3s-io/k3s/releases/download/$tag_enc/sha256sum-$ARCH.txt" "$WORK/k3s.sums"
want="$(awk -v f="$bin" '$2 == f {print $1}' "$WORK/k3s.sums")"
[[ "$(sha256sum "$OUT_DIR/k3s" | cut -d' ' -f1)" == "$want" ]] || die "k3s binary checksum mismatch"
fetch "https://raw.githubusercontent.com/k3s-io/k3s/$tag_enc/install.sh" "$OUT_DIR/k3s-install.sh"
head -1 "$OUT_DIR/k3s-install.sh" | grep -q '^#!/bin/sh' || die "k3s install.sh does not look like a shell script"

# 3. stack.json: what is in this stack.
jq --arg stack "$STACK_VERSION" '{stackVersion: $stack, arch, k3s, created, charts, images}' "$manifest" >"$OUT_DIR/stack.json"
log "stack $STACK_VERSION/$ARCH: $(ls "$OUT_DIR" | wc -l) files, $(du -sh "$OUT_DIR" | cut -f1)"

# 4. Push: one artifact, one layer per file.
if [[ "${PUSH:-}" == 1 ]]; then
  ref="$STACK_REPO:$STACK_VERSION-$ARCH"
  (cd "$OUT_DIR" && oras push "$ref" --artifact-type application/vnd.platform.stack.v1 \
    --annotation "org.opencontainers.image.version=$STACK_VERSION" \
    $(ls | sed 's/$/:application\/octet-stream/'))
  if [[ -n "${CHANNEL:-}" ]]; then
    oras tag "$ref" "$CHANNEL-$ARCH"
    log "tagged $STACK_REPO:$CHANNEL-$ARCH"
  fi
  log "pushed $ref"
fi
