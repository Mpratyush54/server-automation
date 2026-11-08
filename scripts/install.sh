#!/usr/bin/env bash
# Install platformctl from GitHub Releases, falling back to the GHCR copy of
# the release when GitHub Releases is unavailable.
# Usage:
#   curl -fsSL https://github.com/Mpratyush54/server-automation/releases/latest/download/install.sh | bash
#   PLATFORMCTL_VERSION=v0.1.4 curl -fsSL .../install.sh | bash
# If GitHub Releases itself is down, fetch this script from the repository:
#   curl -fsSL https://raw.githubusercontent.com/Mpratyush54/server-automation/master/platformctl/install.sh | bash
#
# Requires bash (Ubuntu's /bin/sh is dash and cannot run this script).
if [ -z "${BASH_VERSION:-}" ]; then
  echo "error: please run with bash, not sh:" >&2
  echo "  curl -fsSL .../install.sh | bash" >&2
  exit 1
fi
set -euo pipefail
umask 077

# GitHub API is case-sensitive; repo is lowercase "server-automation"
REPO="${PLATFORMCTL_REPO:-Mpratyush54/server-automation}"
# OCI artifact pushed by the release workflow: checksums.txt + linux tarballs.
GHCR_REPO="${PLATFORMCTL_GHCR_REPO:-mpratyush54/platformctl}"
INSTALL_DIR="${PLATFORMCTL_INSTALL_DIR:-/usr/local/bin}"
VERSION="${PLATFORMCTL_VERSION:-latest}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *)
    echo "unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

case "$os" in
  linux|darwin) ;;
  *)
    echo "unsupported OS: $os (Windows: download the zip from GitHub Releases)" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Sets $asset and downloads it plus checksums.txt into $tmp. Returns non-zero
# on any failure so the caller can try the mirror.
download_github() {
  local api release_json tag_name
  if [[ "$VERSION" == "latest" ]]; then
    api="https://api.github.com/repos/${REPO}/releases/latest"
  else
    local tag="$VERSION"
    [[ "$tag" == v* ]] || tag="v${tag}"
    api="https://api.github.com/repos/${REPO}/releases/tags/${tag}"
  fi
  echo "Resolving platformctl release ($VERSION)..."
  release_json="$(curl -fsSL --retry 2 "$api")" || { echo "failed to query $api" >&2; return 1; }
  tag_name="$(printf '%s' "$release_json" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
  [[ -n "$tag_name" ]] || { echo "could not resolve release tag from $api" >&2; return 1; }
  asset="platformctl_${tag_name#v}_${os}_${arch}.tar.gz"
  local base="https://github.com/${REPO}/releases/download/${tag_name}"
  echo "Downloading $base/$asset ..."
  curl -fsSL --retry 2 "$base/$asset" -o "$tmp/$asset" &&
    curl -fsSL --retry 2 "$base/checksums.txt" -o "$tmp/checksums.txt"
}

# ghcr_fetch <manifest-json> <file>: download one layer by its title, verify its digest.
ghcr_fetch() {
  local digest
  # Only the layers array (the config object also has a digest), one layer per line.
  digest="$(printf '%s' "$1" | tr -d '\n\r ' | sed -e 's/.*"layers":\[//' -e 's/\].*//' -e 's/},{/}\n{/g' |
    grep "\"org.opencontainers.image.title\":\"$2\"" | grep -o 'sha256:[a-f0-9]\{64\}' | head -1)"
  [[ -n "$digest" ]] || { echo "$2 not found in ghcr.io/${GHCR_REPO}" >&2; return 1; }
  curl -fsSL --retry 3 -H "Authorization: Bearer $ghcr_token" \
    "https://ghcr.io/v2/${GHCR_REPO}/blobs/${digest}" -o "$tmp/$2" || return 1
  [[ "sha256:$(sha256 "$tmp/$2")" == "$digest" ]] || { echo "digest mismatch for $2" >&2; return 1; }
}

download_ghcr() {
  [[ "$os" == linux ]] || { echo "the GHCR mirror only carries Linux builds" >&2; return 1; }
  local ref="latest" manifest ver
  if [[ "$VERSION" != "latest" ]]; then ref="${VERSION#v}"; fi
  echo "Falling back to ghcr.io/${GHCR_REPO}:${ref} ..."
  ghcr_token="$(curl -fsSL --retry 3 "https://ghcr.io/token?scope=repository:${GHCR_REPO}:pull" |
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  [[ -n "$ghcr_token" ]] || { echo "could not get a GHCR token" >&2; return 1; }
  manifest="$(curl -fsSL --retry 3 -H "Authorization: Bearer $ghcr_token" \
    -H "Accept: application/vnd.oci.image.manifest.v1+json" \
    "https://ghcr.io/v2/${GHCR_REPO}/manifests/${ref}")" || return 1
  ghcr_fetch "$manifest" checksums.txt || return 1
  # The version is in the tarball names listed in checksums.txt.
  ver="$(grep -o "platformctl_[^ ]*_linux_${arch}\.tar\.gz" "$tmp/checksums.txt" | head -1 |
    sed -e 's/^platformctl_//' -e "s/_linux_${arch}\.tar\.gz$//")"
  [[ -n "$ver" ]] || { echo "no linux/${arch} build in the GHCR mirror" >&2; return 1; }
  asset="platformctl_${ver}_linux_${arch}.tar.gz"
  ghcr_fetch "$manifest" "$asset"
}

asset=""
if ! download_github; then
  echo "GitHub Releases unavailable; trying the GHCR mirror" >&2
  rm -f "$tmp"/*
  download_ghcr || {
    echo "could not download platformctl from GitHub Releases or ghcr.io/${GHCR_REPO}" >&2
    echo "hint: set PLATFORMCTL_VERSION=v0.1.4 or PLATFORMCTL_REPO=Mpratyush54/server-automation" >&2
    exit 1
  }
fi

# Select exactly this asset, then verify before parsing the archive.
expected="$(awk -v asset="$asset" '$2 == asset {print $1}' "$tmp/checksums.txt")"
[[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "missing or invalid checksum for $asset" >&2; exit 1; }
[[ "$(sha256 "$tmp/$asset")" == "$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')" ]] || { echo "checksum mismatch for $asset" >&2; exit 1; }
tar -xzf "$tmp/$asset" -C "$tmp"

if [[ ! -f "$tmp/platformctl" ]]; then
  echo "archive did not contain platformctl binary" >&2
  exit 1
fi

chmod +x "$tmp/platformctl"

dest="${INSTALL_DIR}/platformctl"
if [[ -w "$INSTALL_DIR" ]]; then
  mv "$tmp/platformctl" "$dest"
elif command -v sudo >/dev/null 2>&1; then
  sudo mv "$tmp/platformctl" "$dest"
else
  echo "cannot write to $INSTALL_DIR (need root or sudo)" >&2
  exit 1
fi

echo "Installed platformctl to $dest"
"$dest" version
echo ""
echo "Next:"
echo "  sudo platformctl provision"
