package cmd

import (
	"context"
	"fmt"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/images"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// startBackgroundPrePull pulls every image the install will need (generated
// list in internal/images plus this release's API/portal) while Helm installs
// run, so each chart's `--wait` mostly finds its images already on disk.
// Failures are only warnings: the kubelet pulls anything still missing.
func startBackgroundPrePull() {
	apiImg := fmt.Sprintf("%s/platform-api:%s", cfg.ImageRegistry, cfg.ImageTag)
	portalImg := fmt.Sprintf("%s/platform-portal:%s", cfg.ImageRegistry, cfg.ImageTag)
	extra := []string{apiImg, portalImg}
	if components.FullTelemetry(cfg) {
		if img, err := components.ProfileIngestImage(cfg); err == nil {
			extra = append(extra, img)
		}
	}
	n := len(images.ListForProfile(components.FullTelemetry(cfg), cfg.IsHA())) + len(extra)
	color.Cyan("  ■ Pre-pulling %d images in background (log: %s)", n, images.LogPath)

	go func() {
		done := state.Track("image-prepull (background)")
		res := images.PrePullForProfile(context.Background(), resolveParallel(), components.FullTelemetry(cfg), cfg.IsHA(), extra...)
		done(fmt.Sprintf("%d pulled, %d present, %d failed", len(res.Pulled), len(res.Skipped), len(res.Failed)))
	}()
}
