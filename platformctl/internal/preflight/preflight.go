package preflight

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

type Result struct {
	Passed bool
	Errors []string
}

func Check() *Result {
	r := &Result{Passed: true}

	if runtime.GOOS != "linux" {
		r.Errors = append(r.Errors, "platformctl requires Linux (detected: "+runtime.GOOS+")")
		r.Passed = false
		return r
	}

	isRoot := os.Geteuid() == 0
	if !isRoot && !shell.HasSudo() {
		r.Errors = append(r.Errors, "must be run as root or have sudo access")
		r.Passed = false
	}

	checkRAM(r)
	checkDisk(r)
	checkPorts(r)
	checkCmds(r)
	// Hostname FQDN is advisory only — bare-IP / sslip.io installs are valid.

	return r
}

func PrintResult(r *Result) {
	if r.Passed {
		color.Green("  ✓ Pre-flight checks passed")
		return
	}
	color.Red("  ✗ Pre-flight checks failed:")
	for _, err := range r.Errors {
		color.Red("    - %s", err)
	}
}

func checkRAM(r *Result) {
	out, err := shell.Output("awk", "/MemTotal/{printf \"%d\", $2/1024/1024}", "/proc/meminfo")
	if err != nil {
		return
	}
	gb, _ := strconv.Atoi(strings.TrimSpace(out))
	if gb < 4 {
		r.Errors = append(r.Errors, fmt.Sprintf("insufficient RAM: %dGB (minimum 4GB)", gb))
		r.Passed = false
	}
}

func checkDisk(r *Result) {
	out, err := shell.Output("df", "--output=avail", "/")
	if err != nil {
		return
	}
	lines := strings.Split(out, "\n")
	if len(lines) < 2 {
		return
	}
	kb, _ := strconv.ParseInt(strings.TrimSpace(lines[1]), 10, 64)
	gb := kb / (1024 * 1024)
	if gb < 40 {
		r.Errors = append(r.Errors, fmt.Sprintf("insufficient disk space: %dGB available (minimum 40GB)", gb))
		r.Passed = false
	}
}

func checkPorts(r *Result) {
	// Resume-friendly: ports owned by our own stack (k3s / ingress-nginx) are OK.
	ports := []int{80, 443, 6443}
	for _, port := range ports {
		out, _ := shell.Output("ss", "-tlnp", fmt.Sprintf("sport = :%d", port))
		if !strings.Contains(out, fmt.Sprintf(":%d", port)) {
			continue
		}
		if portOwnedByPlatform(out, port) {
			color.Yellow("  · port %d in use by platform stack (ok for resume)", port)
			continue
		}
		r.Errors = append(r.Errors, fmt.Sprintf("port %d is already in use", port))
		r.Passed = false
	}
}

// portOwnedByPlatform returns true when ss output shows k3s, kube-apiserver,
// or ingress-nginx holding the port (normal on re-provision / resume).
func portOwnedByPlatform(ssOut string, port int) bool {
	lower := strings.ToLower(ssOut)
	owners := []string{
		"k3s",
		"kube-apiserver",
		"kubelet",
		"nginx",
		"ingress-nginx",
		"traefik",
	}
	for _, o := range owners {
		if strings.Contains(lower, o) {
			return true
		}
	}
	// ss may omit process names without elevated privileges — treat API port as
	// ours when k3s is already installed (resume after interrupted provision).
	if port == 6443 && (shell.Exists("k3s") || shell.FileExists("/etc/rancher/k3s/k3s.yaml")) {
		return true
	}
	return false
}

func checkCmds(r *Result) {
	required := []string{"curl", "openssl"}
	for _, cmd := range required {
		if !shell.Exists(cmd) {
			r.Errors = append(r.Errors, fmt.Sprintf("missing required command: %s", cmd))
			r.Passed = false
		}
	}
}
