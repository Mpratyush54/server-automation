package docker

import (
	"fmt"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func IsInstalled() bool {
	return shell.Exists("docker")
}

func Install() error {
	color.Cyan("\n  ■ Installing Docker CE...")

	if state.IsDone("docker") && IsInstalled() {
		color.Green("  ✓ Docker already installed")
		return nil
	}

	if IsInstalled() {
		color.Green("  ✓ Docker already installed")
		_ = state.MarkDone("docker")
		return nil
	}

	// get.docker.com handles new Ubuntu codenames better than a hard-coded apt list.
	if err := shell.RunBash("curl -fsSL https://get.docker.com | sh"); err != nil {
		return fmt.Errorf("docker install failed: %w", err)
	}

	_ = shell.RunBash(`usermod -aG docker "${SUDO_USER:-root}" || true`)
	_ = shell.RunBash("systemctl enable --now docker")

	color.Green("  ✓ Docker CE installed")
	return state.MarkDone("docker")
}

func WaitReady() error {
	color.Cyan("  ■ Waiting for Docker to be ready...")
	return shell.RunBash("while ! docker info >/dev/null 2>&1; do sleep 2; done")
}
