#!/usr/bin/env bash
# Install platformctl from GitHub Releases.
# Usage:
#   curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | sh
#   PLATFORMCTL_VERSION=v1.2.3 curl -fsSL .../install.sh | sh
set -euo pipefail

REPO="${PLATFORMCTL_REPO:-Mpratyush54/SERVER-automation}"
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
  # Accept v1.2.3 or 1.2.3
  tag="$VERSION"
  [[ "$tag" == v* ]] || tag="v${tag}"
  api="https://api.github.com/repos/${REPO}/releases/tags/${tag}"
fi

echo "Resolving platformctl release ($VERSION)..."
release_json="$(curl -fsSL "$api")"
tag_name="$(printf '%s' "$release_json" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
if [[ -z "$tag_name" ]]; then
  echo "could not resolve release tag" >&2
  exit 1
fi

# GoReleaser version is usually without leading v
ver="${tag_name#v}"
asset="platformctl_${ver}_${os}_${arch}.tar.gz"
url="https://github.com/${REPO}/releases/download/${tag_name}/${asset}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $url ..."
curl -fsSL "$url" -o "$tmp/$asset"
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
