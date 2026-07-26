package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	c := Load()
	if c.PlatformName != "Platform" {
		t.Errorf("expected Platform, got %s", c.PlatformName)
	}
	if c.ImageRegistry != "ghcr.io/mpratyush54" {
		t.Errorf("expected ghcr.io/mpratyush54, got %s", c.ImageRegistry)
	}
	if c.ImageTag != "latest" {
		t.Errorf("expected latest, got %s", c.ImageTag)
	}
	if c.MinioAccessKey != "platformadmin" {
		t.Errorf("expected platformadmin, got %s", c.MinioAccessKey)
	}
	if !c.InstallArgoCD {
		t.Error("expected InstallArgoCD default true")
	}
	if !c.InstallMonitoring {
		t.Error("expected InstallMonitoring default true")
	}
}

func TestLoadEnvOverrides(t *testing.T) {
	os.Setenv("DOMAIN", "test.example.com")
	os.Setenv("ADMIN_EMAIL", "admin@test.com")
	os.Setenv("PLATFORM_IMAGE_REGISTRY", "custom.registry.com/user")
	os.Setenv("PLATFORM_IMAGE_TAG", "v1.2.3")
	defer func() {
		os.Unsetenv("DOMAIN")
		os.Unsetenv("ADMIN_EMAIL")
		os.Unsetenv("PLATFORM_IMAGE_REGISTRY")
		os.Unsetenv("PLATFORM_IMAGE_TAG")
	}()

	c := Load()
	if c.Domain != "test.example.com" {
		t.Errorf("expected test.example.com, got %s", c.Domain)
	}
	if c.AdminEmail != "admin@test.com" {
		t.Errorf("expected admin@test.com, got %s", c.AdminEmail)
	}
	if c.ImageRegistry != "custom.registry.com/user" {
		t.Errorf("expected custom.registry.com/user, got %s", c.ImageRegistry)
	}
	if c.ImageTag != "v1.2.3" {
		t.Errorf("expected v1.2.3, got %s", c.ImageTag)
	}
}

func TestLoadSkipK8S(t *testing.T) {
	os.Setenv("SKIP_K8S", "true")
	defer os.Unsetenv("SKIP_K8S")

	c := Load()
	if !c.SkipK8s {
		t.Error("SKIP_K8S env var should set SkipK8s to true")
	}
}

func TestLoadSkipPreflight(t *testing.T) {
	os.Setenv("SKIP_PREFLIGHT", "true")
	defer os.Unsetenv("SKIP_PREFLIGHT")

	c := Load()
	if !c.SkipPreflight {
		t.Error("SKIP_PREFLIGHT env var should set SkipPreflight to true")
	}
}

func TestGenerateSecretsAll(t *testing.T) {
	c := &Config{}
	c.GenerateSecrets()

	tests := []struct {
		name   string
		value  string
		minLen int
	}{
		{"PostgresPassword", c.PostgresPassword, 24},
		{"MongoPassword", c.MongoPassword, 24},
		{"RedisPassword", c.RedisPassword, 24},
		{"MinioSecretKey", c.MinioSecretKey, 32},
		{"JWTSecret", c.JWTSecret, 48},
		{"WebhookSecret", c.WebhookSecret, 32},
		{"ArgoCDPassword", c.ArgoCDPassword, 20},
		{"GrafanaPassword", c.GrafanaPassword, 20},
		{"InfisicalEncKey", c.InfisicalEncKey, 64},
		{"InfisicalJWT", c.InfisicalJWT, 48},
		{"PortainerPassword", c.PortainerPassword, 20},
	}

	for _, tt := range tests {
		if tt.value == "" {
			t.Errorf("%s should not be empty", tt.name)
		}
		if len(tt.value) < tt.minLen {
			t.Errorf("%s length %d < minimum %d", tt.name, len(tt.value), tt.minLen)
		}
	}
}

func TestGenerateSecretsPreservesExisting(t *testing.T) {
	c := &Config{
		PostgresPassword: "my-custom-password",
		JWTSecret:        "my-jwt-secret",
	}
	c.GenerateSecrets()

	if c.PostgresPassword != "my-custom-password" {
		t.Errorf("existing PostgresPassword was overwritten to %s", c.PostgresPassword)
	}
	if c.JWTSecret != "my-jwt-secret" {
		t.Errorf("existing JWTSecret was overwritten to %s", c.JWTSecret)
	}
	if c.MongoPassword == "" {
		t.Error("MongoPassword should have been generated")
	}
}

func TestPasswordLength(t *testing.T) {
	lengths := []int{1, 8, 16, 24, 32, 64, 100}
	for _, l := range lengths {
		pw := generatePassword(l)
		if len(pw) != l {
			t.Errorf("generatePassword(%d) returned length %d", l, len(pw))
		}
	}
}

func TestPasswordRandomness(t *testing.T) {
	pw1 := generatePassword(32)
	pw2 := generatePassword(32)
	if pw1 == pw2 {
		t.Error("two generated passwords should not be identical")
	}
}

func TestPasswordValidBase64(t *testing.T) {
	pw := generatePassword(32)
	for _, c := range pw {
		if !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", c) {
			t.Errorf("password contains invalid character %c", c)
		}
	}
}

func TestSaveEnvFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "subdir", ".env")

	c := &Config{
		Domain:           "test.example.com",
		AdminEmail:       "admin@test.com",
		PlatformName:     "Test",
		PostgresPassword: "pg-pass",
		JWTSecret:        "jwt-secret",
	}

	if err := c.SaveEnvFile(path); err != nil {
		t.Fatalf("SaveEnvFile failed: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading saved file: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, "DOMAIN=test.example.com") {
		t.Error("file missing DOMAIN")
	}
	if !strings.Contains(content, "POSTGRES_PASSWORD=pg-pass") {
		t.Error("file missing POSTGRES_PASSWORD")
	}
	if !strings.Contains(content, "JWT_SECRET=jwt-secret") {
		t.Error("file missing JWT_SECRET")
	}
}

func TestSaveEnvFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission test not applicable on Windows")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")

	c := &Config{Domain: "test.com"}
	if err := c.SaveEnvFile(path); err != nil {
		t.Fatalf("SaveEnvFile failed: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat file: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("expected 0600 permissions, got %o", info.Mode().Perm())
	}
}

func TestPromptInteractiveNonInteractive(t *testing.T) {
	c := &Config{NonInteractive: true}
	if err := c.PromptInteractive(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGetEnvBool(t *testing.T) {
	tests := []struct {
		val      string
		def      bool
		expected bool
	}{
		{"true", false, true},
		{"yes", false, true},
		{"y", false, true},
		{"1", false, true},
		{"false", true, false},
		{"no", true, false},
		{"", true, true},
		{"", false, false},
		{"invalid", false, false},
	}

	for _, tt := range tests {
		os.Setenv("TEST_GETENVBOOL", tt.val)
		result := getEnvBool("TEST_GETENVBOOL", tt.def)
		if result != tt.expected {
			t.Errorf("getEnvBool(%q, %v) = %v, want %v", tt.val, tt.def, result, tt.expected)
		}
		os.Unsetenv("TEST_GETENVBOOL")
	}
}
