package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestLonghornConfig(t *testing.T) {
	oldPath := envFilePath
	envFilePath = filepath.Join(t.TempDir(), "absent")
	defer func() { envFilePath = oldPath }()
	for _, tc := range []struct {
		raw  string
		want int
	}{{"", 0}, {"0", 0}, {"1", 1}, {"2", 2}, {"3", 3}, {"4", 0}, {"-1", 0}, {"invalid", 0}, {"999999999999999999999999999", 0}} {
		t.Run(tc.raw, func(t *testing.T) {
			t.Setenv("LONGHORN_REPLICAS", tc.raw)
			if got := Load().LonghornReplicas; got != tc.want {
				t.Errorf("got %d want %d", got, tc.want)
			}
		})
	}
	t.Setenv("LONGHORN_REPLICAS", "2")
	t.Setenv("LONGHORN_BACKUP_TARGET", "s3://backup@us-east-1/longhorn/")
	t.Setenv("LONGHORN_BACKUP_SECRET", "backup-secret")
	c := Load()
	p := filepath.Join(t.TempDir(), ".env")
	if err := c.SaveEnvFile(p); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, pair := range []string{"LONGHORN_REPLICAS=" + strconv.Itoa(c.LonghornReplicas), "LONGHORN_BACKUP_TARGET=" + c.LonghornBackupTarget, "LONGHORN_BACKUP_SECRET=" + c.LonghornBackupSecret} {
		if !strings.Contains(string(data), pair+"\n") {
			t.Fatalf("missing %s", pair)
		}
	}
	// Reload the actual saved dotenv values through Load without leaking environment changes.
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok && !strings.HasPrefix(key, "#") {
			t.Setenv(key, value)
		}
	}
	got := Load()
	if got.LonghornReplicas != 2 || got.LonghornBackupTarget != c.LonghornBackupTarget || got.LonghornBackupSecret != "backup-secret" {
		t.Fatalf("round trip: %+v", got)
	}
	if strings.Contains(string(data), "AWS_ACCESS_KEY_ID=") || strings.Contains(string(data), "AWS_SECRET_ACCESS_KEY=") {
		t.Fatal("backup credentials saved")
	}
}
