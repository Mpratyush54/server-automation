package components

import (
	"context"
	"fmt"
	"time"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/verify"
)

// imageVerifier is the cosign checker used before installing or updating
// platform images. Tests replace it with a fake.
var imageVerifier verify.Verifier = verify.CosignVerifier{}

// verifyPlatformImages checks API/portal signatures. Missing cosign or (in
// warn mode) missing signatures print a warning and continue; invalid
// signatures always fail. PLATFORM_VERIFY_IMAGES=strict makes a missing
// signature fatal.
func verifyPlatformImages(cfg *config.Config) error {
	images := verify.PlatformImages(cfg.ImageRegistry, cfg.ImageTag)
	if len(images) == 0 {
		return nil
	}
	mode := verify.ModeFromEnv()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	color.Cyan("  ■ Verifying platform image signatures (%s)...", mode)
	results, err := verify.Check(ctx, imageVerifier, mode, images)
	for _, r := range results {
		switch r.Status {
		case "verified":
			color.Green("    ✓ %s", r.Image)
		case "missing":
			color.Yellow("    ⚠ %s: no signature (set PLATFORM_VERIFY_IMAGES=strict to require one)", r.Image)
		case "unverifiable":
			color.Yellow("    ⚠ %s: could not verify (%v); continuing (PLATFORM_VERIFY_IMAGES=strict makes this fatal)", r.Image, r.Err)
		case "skipped":
			color.Yellow("    ⚠ cosign not installed; skipping verification for %s", r.Image)
		case "invalid":
			color.Red("    ✗ %s: %v", r.Image, r.Err)
		}
	}
	if err != nil {
		return fmt.Errorf("platform image verification failed: %w", err)
	}
	return nil
}
