package config

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGeneratedSecuritySecretsPersistAndRemainStable(t *testing.T) {
	c := &Config{JWTSecret: "too-short"}
	c.GenerateSecrets()
	key, err := hex.DecodeString(c.SecretsEncryptionKey)
	if err != nil || len(key) != 32 {
		t.Fatal("expected 32 random bytes in hex")
	}
	if len(c.JWTSecret) < 32 || c.AdminPassword == "" {
		t.Fatal("weak signing secret or missing admin password")
	}
	old := c.SecretsEncryptionKey
	c.GenerateSecrets()
	if c.SecretsEncryptionKey != old {
		t.Fatal("encryption key changed on retry")
	}
	p := filepath.Join(t.TempDir(), "config")
	if err := c.SaveEnvFile(p); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "SECRETS_ENCRYPTION_KEY="+old+"\n") {
		t.Fatal("encryption key not persisted")
	}
}
