#!/usr/bin/env bash
# =============================================================================
#  Platform — Server bootstrap (compatibility wrapper)
#
#  Preferred install (no repo clone, no on-server build):
#    curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash
#    sudo platformctl provision
#
#  This script installs platformctl (if needed) and runs `platformctl provision`.
#  To force the old bash installer: PLATFORM_BOOTSTRAP_LEGACY=1 sudo ./bootstrap.sh
# =============================================================================
set -euo pipefail

REPO="${PLATFORMCTL_REPO:-Mpratyush54/SERVER-automation}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${PLATFORM_BOOTSTRAP_LEGACY:-}" == "1" ]]; then
  if [[ -f "$SCRIPT_DIR/bootstrap-legacy.sh" ]]; then
    echo "[Platform] Running legacy bootstrap.sh ..."
    exec bash "$SCRIPT_DIR/bootstrap-legacy.sh" "$@"
  fi
  echo "[Platform] bootstrap-legacy.sh not found" >&2
  exit 1
fi

echo "[Platform] Deprecated: cloning this repo / running bootstrap.sh is no longer required."
echo "[Platform] Installing platformctl and provisioning from pre-built GHCR images..."
echo ""

if ! command -v platformctl >/dev/null 2>&1; then
  INSTALL_URL="https://github.com/${REPO}/releases/latest/download/install.sh"
  # Fallback to raw script in the repo when a release is not published yet.
  RAW_URL="https://raw.githubusercontent.com/${REPO}/master/scripts/install.sh"
  if curl -fsSL "$INSTALL_URL" -o /tmp/platformctl-install.sh 2>/dev/null; then
    bash /tmp/platformctl-install.sh
  elif curl -fsSL "$RAW_URL" -o /tmp/platformctl-install.sh 2>/dev/null; then
    echo "[Platform] No GitHub Release asset yet — using scripts/install.sh from master."
    echo "[Platform] If download of the binary fails, build locally or wait for a v* release."
    bash /tmp/platformctl-install.sh
  else
    echo "[Platform] Could not download install.sh." >&2
    echo "[Platform] Build from source: cd platformctl && go build -o platformctl . && sudo mv platformctl /usr/local/bin/" >&2
    exit 1
  fi
fi

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo -E platformctl provision "$@"
fi
exec platformctl provision "$@"
