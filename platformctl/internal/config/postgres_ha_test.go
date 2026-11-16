package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPostgresHAConfig(t *testing.T) {
	for _, key := range []string{"POSTGRES_HA_STORAGE_CLASS", "POSTGRES_BACKUP_RETENTION", "POSTGRES_BACKUP_DESTINATION", "POSTGRES_BACKUP_ENDPOINT", "POSTGRES_BACKUP_SECRET"} {
		t.Setenv(key, "")
	}
	c := Load()
	if c.PostgresHAStorageClass != "local-path" || c.PostgresBackupRetention != "14d" {
		t.Fatal(c.PostgresHAStorageClass, c.PostgresBackupRetention)
	}
	p := filepath.Join(t.TempDir(), ".env")
	for _, profile := range Profiles {
		c.Profile = profile
		if err := c.SaveEnvFile(p); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "POSTGRES_BACKUP_RETENTION=") != c.IsHA() {
			t.Fatal(profile)
		}
		if !c.IsHA() {
			changed := *c
			changed.PostgresHAStorageClass = "other-class"
			changed.PostgresBackupDestination = "s3://another-bucket/prefix/"
			changed.PostgresBackupEndpoint = "https://s3.example.com"
			changed.PostgresBackupSecret = "external-s3"
			changed.PostgresBackupRetention = "3w"
			if err := changed.SaveEnvFile(p); err != nil {
				t.Fatal(err)
			}
			after, err := os.ReadFile(p)
			if err != nil {
				t.Fatal(err)
			}
			if string(after) != string(b) {
				t.Fatal("PostgreSQL HA settings changed non-HA .env")
			}
		}
	}
	for _, field := range []*string{&c.PostgresHAStorageClass, &c.PostgresBackupDestination, &c.PostgresBackupEndpoint, &c.PostgresBackupSecret, &c.PostgresBackupRetention} {
		old := *field
		*field = "bad\nvalue"
		if err := c.SaveEnvFile(p); err == nil {
			t.Fatal("line break accepted")
		}
		*field = old
	}
	t.Setenv("POSTGRES_HA_STORAGE_CLASS", "ssd")
	t.Setenv("POSTGRES_BACKUP_RETENTION", "3w")
	c = Load()
	if c.PostgresHAStorageClass != "ssd" || c.PostgresBackupRetention != "3w" {
		t.Fatal("override not loaded")
	}
}
