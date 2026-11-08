#!/usr/bin/env bash
# Install platformctl from GitHub Releases.
# Usage:
#   curl -fsSL https://github.com/Mpratyush54/server-automation/releases/latest/download/install.sh | bash
#   PLATFORMCTL_VERSION=v0.1.4 curl -fsSL .../install.sh | bash
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

if [[ "$VERSION" == "latest" ]]; then
  api="https://api.github.com/repos/${REPO}/releases/latest"
else
  tag="$VERSION"
  [[ "$tag" == v* ]] || tag="v${tag}"
  api="https://api.github.com/repos/${REPO}/releases/tags/${tag}"
fi

echo "Resolving platformctl release ($VERSION)..."
release_json="$(curl -fsSL "$api")" || {
  echo "failed to query $api" >&2
  echo "hint: set PLATFORMCTL_VERSION=v0.1.4 or PLATFORMCTL_REPO=Mpratyush54/server-automation" >&2
  exit 1
}
tag_name="$(printf '%s' "$release_json" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
if [[ -z "$tag_name" ]]; then
  echo "could not resolve release tag from $api" >&2
  exit 1
fi

ver="${tag_name#v}"
asset="platformctl_${ver}_${os}_${arch}.tar.gz"
url="https://github.com/${REPO}/releases/download/${tag_name}/${asset}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $url ..."
curl -fsSL "$url" -o "$tmp/$asset"
curl -fsSL "https://github.com/${REPO}/releases/download/${tag_name}/checksums.txt" -o "$tmp/checksums.txt"
# Select exactly this asset, then verify before parsing the archive.
expected="$(awk -v asset="$asset" '$2 == asset {print $1}' "$tmp/checksums.txt")"
[[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "missing or invalid checksum for $asset" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
fi
[[ "$actual" == "$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')" ]] || { echo "checksum mismatch for $asset" >&2; exit 1; }
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
