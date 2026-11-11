package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHardeningConfiguration(t *testing.T) {
	oldPath := envFilePath
	envFilePath = filepath.Join(t.TempDir(), "absent.env")
	defer func() { envFilePath = oldPath }()
	for _, key := range []string{"PLATFORM_HARDEN", "PLATFORM_WAF", "PLATFORM_NGINX_AUTH_JAIL"} {
		t.Setenv(key, "")
	}
	c := Load()
	if c.SkipHardening || c.WAF || c.NginxAuthJail {
		t.Fatal("unsafe defaults")
	}
	t.Setenv("PLATFORM_HARDEN", "false")
	t.Setenv("PLATFORM_WAF", "true")
	t.Setenv("PLATFORM_NGINX_AUTH_JAIL", "true")
	c = Load()
	if !c.SkipHardening || !c.WAF || !c.NginxAuthJail {
		t.Fatal("environment overrides ignored")
	}
	path := filepath.Join(t.TempDir(), "saved.env")
	if err := c.SaveEnvFile(path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"PLATFORM_HARDEN=false", "PLATFORM_WAF=true", "PLATFORM_NGINX_AUTH_JAIL=true"} {
		if !strings.Contains(string(data), want+"\n") {
			t.Fatal("setting not persisted", want)
		}
	}
}

func TestSkipHardeningEnvironment(t *testing.T) {
	oldPath := envFilePath
	envFilePath = filepath.Join(t.TempDir(), "absent.env")
	defer func() { envFilePath = oldPath }()
	t.Setenv("PLATFORM_HARDEN", "")
	t.Setenv("SKIP_HARDENING", "true")
	if !Load().SkipHardening {
		t.Fatal("SKIP_HARDENING=true ignored")
	}
}
