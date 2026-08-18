#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Installing platform/api dependencies"
(cd platform/api && npm ci)

echo "==> Installing platform/portal dependencies"
(cd platform/portal && npm ci)

echo "==> Installing platform/mcp-server dependencies"
if [ -f platform/mcp-server/package-lock.json ]; then
  (cd platform/mcp-server && npm ci)
else
  (cd platform/mcp-server && npm install)
fi

echo "==> Downloading platformctl Go modules"
(cd platformctl && go mod download)

echo "==> Cloud install complete"
