package helm

import (
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
	"os"
)

// CacheChart follows provision's cache/upstream/GHCR fallback for one changed chart.
func CacheChart(c versions.Chart) error {
	if _, e := os.Stat(c.CacheFile()); e == nil {
		return nil
	}
	if e := os.MkdirAll(versions.ChartCacheDir, 0755); e != nil {
		return e
	}
	return pullFn(c)
}
