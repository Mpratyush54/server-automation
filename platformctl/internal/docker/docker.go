package docker

import (
	"fmt"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

func IsInstalled() bool {
	return shell.Exists("docker")
}

func Install() error {
	color.Cyan("\n  ■ Installing Docker CE...")

	if IsInstalled() {
		color.Green("  ✓ Docker already installed")
		return nil
	}

	cmds := []string{
		"apt-get update -qq",
		"apt-get install -y -qq ca-certificates curl",
		"install -m 0755 -d /etc/apt/keyrings",
		"curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
		"chmod a+r /etc/apt/keyrings/docker.asc",
		`echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null`,
		"apt-get update -qq",
		"apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
	}

	for _, c := range cmds {
		if err := shell.RunBash(c); err != nil {
			return fmt.Errorf("docker install failed at: %s: %w", c, err)
		}
	}

	color.Green("  ✓ Docker CE installed")
	return nil
}

func WaitReady() error {
	color.Cyan("  ■ Waiting for Docker to be ready...")
	return shell.RunBash("while ! docker info >/dev/null 2>&1; do sleep 2; done")
}
