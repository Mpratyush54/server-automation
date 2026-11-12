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
