package components

import (
	"context"
	"errors"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/verify"
)

type stubVerifier struct {
	err error
}

func (s stubVerifier) Verify(context.Context, string) error { return s.err }

func TestVerifyPlatformImagesWarnMissing(t *testing.T) {
	prev := imageVerifier
	t.Cleanup(func() { imageVerifier = prev })
	imageVerifier = stubVerifier{err: verify.ErrMissingSignature}
	t.Setenv("PLATFORM_VERIFY_IMAGES", "warn")

	cfg := &config.Config{ImageRegistry: "ghcr.io/mpratyush54", ImageTag: "test"}
	if err := verifyPlatformImages(cfg); err != nil {
		t.Fatalf("warn mode should allow missing signatures: %v", err)
	}
}

func TestVerifyPlatformImagesStrictMissing(t *testing.T) {
	prev := imageVerifier
	t.Cleanup(func() { imageVerifier = prev })
	imageVerifier = stubVerifier{err: verify.ErrMissingSignature}
	t.Setenv("PLATFORM_VERIFY_IMAGES", "strict")

	cfg := &config.Config{ImageRegistry: "ghcr.io/mpratyush54", ImageTag: "test"}
	if err := verifyPlatformImages(cfg); err == nil {
		t.Fatal("strict mode must fail when signature is missing")
	}
}

func TestVerifyPlatformImagesInvalid(t *testing.T) {
	prev := imageVerifier
	t.Cleanup(func() { imageVerifier = prev })
	imageVerifier = stubVerifier{err: verify.ErrInvalidSignature}
	t.Setenv("PLATFORM_VERIFY_IMAGES", "warn")

	cfg := &config.Config{ImageRegistry: "ghcr.io/mpratyush54", ImageTag: "test"}
	err := verifyPlatformImages(cfg)
	if err == nil || !errors.Is(err, verify.ErrInvalidSignature) {
		t.Fatalf("invalid signature must fail, got %v", err)
	}
}

func TestVerifyPlatformImagesCosignMissing(t *testing.T) {
	prev := imageVerifier
	t.Cleanup(func() { imageVerifier = prev })
	imageVerifier = stubVerifier{err: verify.ErrCosignMissing}
	t.Setenv("PLATFORM_VERIFY_IMAGES", "strict")

	cfg := &config.Config{ImageRegistry: "ghcr.io/mpratyush54", ImageTag: "test"}
	if err := verifyPlatformImages(cfg); err != nil {
		t.Fatalf("missing cosign must warn and continue even in strict: %v", err)
	}
}
