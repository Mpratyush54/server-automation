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
