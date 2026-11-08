package helm

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

func withHelmPull(t *testing.T, fn func(args, dir string) (string, error)) {
	t.Helper()
	orig := helmPull
	helmPull = fn
	t.Cleanup(func() { helmPull = orig })
}

func writeTarball(dir string) error {
	return os.WriteFile(filepath.Join(dir, "chart.tgz"), []byte("tgz"), 0o644)
}

// Regression: during a GitHub Releases outage every classic chart download
// failed and provision stopped. The GHCR mirror must be used instead.
func TestPullChartFallsBackToGHCRMirror(t *testing.T) {
	c := versions.Get("argo-cd")
	var calls []string
	withHelmPull(t, func(args, dir string) (string, error) {
		calls = append(calls, args)
		if strings.Contains(args, "--repo") {
			return "504 Gateway Timeout", errors.New("exit status 1")
		}
		return "", writeTarball(dir)
	})
	err := pullChart(c)
	if len(calls) != 2 || !strings.HasPrefix(calls[1], versions.ChartMirror+"/argo-cd --version "+c.Version) {
		t.Fatalf("expected upstream then mirror pull, got %q", calls)
	}
	// The move into /var/lib/platform/charts may fail on a dev machine; the
	// fallback itself must not error before that point.
	if err != nil && !strings.Contains(err.Error(), filepath.Base(c.CacheFile())) && !errors.Is(err, os.ErrNotExist) && !errors.Is(err, os.ErrPermission) {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPullChartUsesUpstreamWhenItWorks(t *testing.T) {
	c := versions.Get("argo-cd")
	var calls []string
	withHelmPull(t, func(args, dir string) (string, error) {
		calls = append(calls, args)
		return "", writeTarball(dir)
	})
	_ = pullChart(c)
	if len(calls) != 1 || !strings.Contains(calls[0], "--repo") {
		t.Fatalf("expected a single upstream pull, got %q", calls)
	}
}

func TestPullChartReportsBothFailures(t *testing.T) {
	withHelmPull(t, func(args, dir string) (string, error) { return "boom", errors.New("exit status 1") })
	err := pullChart(versions.Get("redis"))
	if err == nil || !strings.Contains(err.Error(), "mirror "+versions.ChartMirror) {
		t.Fatalf("expected an error naming both sources, got %v", err)
	}
}
