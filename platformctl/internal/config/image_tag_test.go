package config

import (
	"os"
	"path/filepath"
	"testing"
)

// provision --bundle replaces only a default image tag (see ImageTagSource).
func TestImageTagSource(t *testing.T) {
	oldPath := envFilePath
	t.Cleanup(func() { envFilePath = oldPath })
	dir := t.TempDir()

	envFilePath = filepath.Join(dir, "absent.env")
	t.Setenv("PLATFORM_IMAGE_TAG", "")
	if c := Load(); c.ImageTagSource != "" {
		t.Fatalf("default: %q", c.ImageTagSource)
	}

	t.Setenv("PLATFORM_IMAGE_TAG", "1.4.0")
	if c := Load(); c.ImageTagSource != ImageTagFromEnv || c.ImageTag != "1.4.0" {
		t.Fatalf("env: %q %q", c.ImageTagSource, c.ImageTag)
	}

	envFilePath = filepath.Join(dir, ".env")
	if err := os.WriteFile(envFilePath, []byte("PLATFORM_IMAGE_TAG=1.3.0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PLATFORM_IMAGE_TAG", "")
	if c := Load(); c.ImageTagSource != ImageTagSaved || c.ImageTag != "1.3.0" {
		t.Fatalf("saved: %q %q", c.ImageTagSource, c.ImageTag)
	}
}
