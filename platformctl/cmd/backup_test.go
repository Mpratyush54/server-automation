package cmd

import (
	"strings"
	"testing"

	"filippo.io/age"
)

// Validation must fail before provisioning starts (RunE returns before any
// host change), so a typo never leaves a half-restored server.
func TestProvisionRestoreFlagValidation(t *testing.T) {
	defer func() { provisionRestoreFrom, provisionRestoreID, cfg.NonInteractive = "", "", false }()
	cases := []struct {
		from, id string
		args     []string
		auto     bool
		stdin    string
		want     string
	}{
		{"", "", []string{"20260101T000000.000000000Z"}, true, "", "needs --restore-from"},
		{"s3://r2/b/p", "", nil, true, "", "needs a backup ID"},
		{"s3://r2/b/p", "a", []string{"b"}, true, "", "conflicting"},
		{"s3://r2/b/p", "a", nil, false, "", "requires --auto"},
		{"https://r2/b", "a", nil, true, "", "target must be"},
		{"s3://r2/b/p", "a", nil, true, "not a key", "age identity"},
	}
	for _, c := range cases {
		provisionRestoreFrom, provisionRestoreID, cfg.NonInteractive = c.from, c.id, c.auto
		provisionCmd.SetIn(strings.NewReader(c.stdin))
		e := provisionCmd.RunE(provisionCmd, c.args)
		if e == nil || !strings.Contains(e.Error(), c.want) {
			t.Fatalf("%+v: got %v, want %q", c, e, c.want)
		}
	}
}

func TestReadIdentity(t *testing.T) {
	k, _ := age.GenerateX25519Identity()
	b, e := readIdentity(strings.NewReader("# created: now\n" + k.String() + "\n"))
	if e != nil || !strings.Contains(string(b), k.String()) {
		t.Fatal(e)
	}
	if _, e = readIdentity(strings.NewReader(k.Recipient().String())); e == nil {
		t.Fatal("public recipient accepted as identity")
	}
}

func TestRestoreConfigNeedsTargetOnFreshVM(t *testing.T) {
	old := backupConfigPath
	defer func() { backupConfigPath = old }()
	backupConfigPath = t.TempDir() + "/missing.json"
	if _, e := restoreConfig(""); e == nil {
		t.Fatal("missing config without --target accepted")
	}
	c, e := restoreConfig("s3://r2/bucket/prefix")
	if e != nil || c.Target != "s3://r2/bucket/prefix" {
		t.Fatal(c, e)
	}
}

func TestProvisionRestoreHintOnFreshServer(t *testing.T) {
	oldPath, oldFrom, oldID := backupConfigPath, provisionRestoreFrom, provisionRestoreID
	defer func() { backupConfigPath, provisionRestoreFrom, provisionRestoreID = oldPath, oldFrom, oldID }()
	backupConfigPath = t.TempDir() + "/missing.json"
	provisionRestoreFrom, provisionRestoreID = "s3://r2/bucket/prefix", ""
	err := provisionCmd.RunE(provisionCmd, nil)
	if err == nil {
		t.Fatal("missing backup ID accepted")
	}
	for _, hint := range []string{"on a configured server", "on a fresh server", "ls <backup-directory>/", "mc ls <alias>/<bucket>/<prefix>/", "backup.json"} {
		if !strings.Contains(err.Error(), hint) {
			t.Errorf("restore hint %q missing %q", err, hint)
		}
	}
	if strings.Contains(err.Error(), "backup list --target") {
		t.Fatal("restore hint still suggests a command requiring an existing config")
	}
}
