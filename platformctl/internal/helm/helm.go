package helm

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

func IsInstalled() bool {
	return shell.Exists("helm")
}

// installedMajorOK reports whether the helm on PATH is the pinned major version.
func installedMajorOK() bool {
	out, err := shell.Output("helm", "version", "--short")
	if err != nil {
		return false
	}
	want := strings.SplitN(versions.HelmVersion, ".", 2)[0] // "v3"
	return strings.HasPrefix(strings.TrimSpace(out), want+".")
}

// Install puts the pinned Helm release on PATH. Charts are referenced with
// --repo / oci:// (see versions.Chart.Ref), so no `helm repo add/update` is run.
func Install() error {
	color.Cyan("\n  ■ Installing Helm %s...", versions.HelmVersion)

	if IsInstalled() && installedMajorOK() {
		color.Green("  ✓ Helm already installed")
		return state.MarkDone("helm")
	}

	// Official release tarball, pinned — not the get-helm-3 script from main.
	script := fmt.Sprintf(`
		set -euo pipefail
		case "$(uname -m)" in
		  x86_64|amd64) arch=amd64 ;;
		  aarch64|arm64) arch=arm64 ;;
		  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
		esac
		tmp="$(mktemp -d)"
		trap 'rm -rf "$tmp"' EXIT
		curl -fsSL --retry 3 "https://get.helm.sh/helm-%[1]s-linux-${arch}.tar.gz" -o "$tmp/helm.tgz"
		tar -xzf "$tmp/helm.tgz" -C "$tmp"
		install -m 0755 "$tmp/linux-${arch}/helm" /usr/local/bin/helm
		helm version --short
	`, versions.HelmVersion)
	if err := shell.RunBash(script); err != nil {
		return fmt.Errorf("helm install failed: %w", err)
	}
	color.Green("  ✓ Helm installed")
	return state.MarkDone("helm")
}

// pullFn is swapped in tests.
var pullFn = pullChart

// PrefetchCharts downloads every pinned chart tarball into
// versions.ChartCacheDir in parallel. Once cached, Chart.Ref() resolves to the
// local file, so each later `helm upgrade --install` skips the network.
// Failures are returned but are not fatal: Ref() falls back to the remote.
func PrefetchCharts(concurrency int) map[string]error {
	if concurrency < 1 {
		concurrency = 1
	}
	_ = os.MkdirAll(versions.ChartCacheDir, 0755)

	var (
		mu   sync.Mutex
		errs = map[string]error{}
		wg   sync.WaitGroup
		sem  = make(chan struct{}, concurrency)
	)
	for _, c := range versions.All() {
		if _, err := os.Stat(c.CacheFile()); err == nil {
			continue
		}
		wg.Add(1)
		go func(c versions.Chart) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := pullFn(c); err != nil {
				mu.Lock()
				errs[c.Name] = err
				mu.Unlock()
			}
		}(c)
	}
	wg.Wait()
	return errs
}

func pullChart(c versions.Chart) error {
	tmp, err := os.MkdirTemp("", "platformctl-chart-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	out, err := shell.OutputBash(fmt.Sprintf("helm pull %s -d %s", c.PullArgs(), tmp))
	if err != nil {
		return fmt.Errorf("helm pull %s: %v: %s", c.Name, err, out)
	}
	matches, _ := filepath.Glob(filepath.Join(tmp, "*.tgz"))
	if len(matches) != 1 {
		return fmt.Errorf("helm pull %s: expected one tarball, got %d", c.Name, len(matches))
	}
	return moveFile(matches[0], c.CacheFile())
}

func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	tmp := dst + ".partial"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}
