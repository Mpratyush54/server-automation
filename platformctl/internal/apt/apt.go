package apt

import (
	"fmt"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func InstallPrereqs() error {
	if state.IsDone("prereqs") {
		color.Green("  ✓ Prerequisites already installed")
		return nil
	}
	color.Cyan("\n  ■ Installing system prerequisites...")
	if err := shell.RunBash(`
		export DEBIAN_FRONTEND=noninteractive
		apt-get update -qq
		apt-get install -y -qq \
		  curl wget jq unzip gnupg ca-certificates \
		  apt-transport-https openssl python3 apache2-utils \
		  netcat-openbsd || apt-get install -y -qq \
		  curl wget jq unzip gnupg ca-certificates \
		  apt-transport-https openssl python3 apache2-utils
	`); err != nil {
		return fmt.Errorf("apt prerequisites failed: %w", err)
	}
	color.Green("  ✓ Prerequisites installed")
	return state.MarkDone("prereqs")
}

// LonghornPrereqsScript prepares this node for Longhorn's iSCSI volumes.
const LonghornPrereqsScript = `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
pkgs="open-iscsi nfs-common util-linux dmsetup"
# Wait for the dpkg lock: host hardening may run apt-get at the same time.
apt="apt-get -o DPkg::Lock::Timeout=300"
$apt install -y -qq $pkgs || { $apt update -qq && $apt install -y -qq $pkgs; }
systemctl enable --now iscsid
modprobe iscsi_tcp
mkdir -p /etc/modules-load.d
printf 'iscsi_tcp\n' > /etc/modules-load.d/longhorn.conf
if command -v multipathd >/dev/null 2>&1; then
  mkdir -p /etc/multipath/conf.d
  cat > /etc/multipath/conf.d/longhorn.conf <<'EOF'
blacklist {
  device {
    vendor "IET"
    product "VIRTUAL-DISK"
  }
}
EOF
  if systemctl is-active --quiet multipathd; then
    systemctl reload multipathd || true
  fi
fi
`

// InstallLonghornPrereqs installs Longhorn's node prerequisites (ha profile).
// Every node that runs Longhorn needs them, including nodes joined later.
func InstallLonghornPrereqs() error {
	if state.IsDone("longhorn-prereqs") {
		return nil
	}
	color.Cyan("  Installing Longhorn node prerequisites...")
	if err := shell.RunBash(LonghornPrereqsScript); err != nil {
		return fmt.Errorf("Longhorn prerequisites: %w", err)
	}
	return state.MarkDone("longhorn-prereqs")
}

// OfflinePackages are the packages an offline join installs from the bundle:
// the Longhorn prerequisites, the host hardening packages and the commands
// preflight requires. scripts/build-bundle.sh downloads their dependency
// closure (TestBundleScriptPackageList keeps both lists equal).
const OfflinePackages = "open-iscsi nfs-common util-linux dmsetup unattended-upgrades fail2ban chrony nftables curl openssl"

// OfflinePackagesScript installs OfflinePackages from the offline bundle
// without contacting any mirror. Each PACKAGE_ROOT/ubuntu-<release>/<arch>
// directory is a flat apt repository (the .deb files apt downloaded and
// verified against the signed Ubuntu archive at bundle build time, plus their
// Packages index); bundle.Install checked every file against the bundle's
// SHA256SUMS. apt uses only that repository (the system's sources and lists
// are not read or changed), so it resolves dependencies against what is
// installed: packages already installed are left alone, and a library is
// upgraded only when a new package needs a newer version. The transaction is
// simulated first and refused when it would remove anything other than
// systemd-timesyncd (chrony replaces it, as hardening does online).
//
// Environment: PACKAGE_ROOT and OFFLINE_PACKAGES (required), OS_RELEASE
// (default /etc/os-release).
const OfflinePackagesScript = `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
. "${OS_RELEASE:-/etc/os-release}"
arch=$(dpkg --print-architecture)
repo="$PACKAGE_ROOT/$ID-$VERSION_ID/$arch"
if [ ! -s "$repo/Packages" ]; then
  echo "the offline bundle has no packages for $ID $VERSION_ID ($arch) in $repo; offline join supports Ubuntu 22.04 and 24.04" >&2
  exit 1
fi
wanted=()
for package in $OFFLINE_PACKAGES; do
  if [ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != "install ok installed" ]; then
    wanted+=("$package")
  fi
done
if [ "${#wanted[@]}" -eq 0 ]; then
  echo "  offline packages: already installed"
  exit 0
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chmod 0755 "$tmp"
mkdir -p "$tmp/lists/partial" "$tmp/sources.list.d"
echo "deb [trusted=yes] file:$repo ./" > "$tmp/sources.list"
apt=(apt-get -o DPkg::Lock::Timeout=300
  -o "Dir::Etc::SourceList=$tmp/sources.list" -o "Dir::Etc::SourceParts=$tmp/sources.list.d"
  -o "Dir::State::Lists=$tmp/lists" -o Dir::Cache::pkgcache= -o Dir::Cache::srcpkgcache=)
"${apt[@]}" update -qq
if ! plan=$("${apt[@]}" -s install "${wanted[@]}" 2>&1); then
  printf 'cannot install %s from the offline bundle alone:\n%s\n' "${wanted[*]}" "$plan" >&2
  exit 1
fi
removals=$(awk '$1 == "Remv" && $2 != "systemd-timesyncd" {print $2}' <<<"$plan")
if [ -n "$removals" ]; then
  echo "refusing the offline package install: it would remove $(echo $removals)" >&2
  exit 1
fi
echo "  offline packages: installing ${wanted[*]}"
"${apt[@]}" install -y -qq "${wanted[@]}"
`

// InstallOfflinePackages installs OfflinePackages from the bundle's package
// repositories under root (see OfflinePackagesScript). There is no download
// fallback.
func InstallOfflinePackages(root string) error {
	color.Cyan("  Installing node packages from the offline bundle...")
	env := map[string]string{"PACKAGE_ROOT": root, "OFFLINE_PACKAGES": OfflinePackages}
	if err := shell.RunBashEnv(OfflinePackagesScript, env); err != nil {
		return fmt.Errorf("offline packages: %w", err)
	}
	return nil
}
