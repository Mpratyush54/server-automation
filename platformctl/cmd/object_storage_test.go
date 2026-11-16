package cmd

import (
	"errors"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/runner"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func TestExternalObjectStorageGraph(t *testing.T) {
	c := allOn()
	c.Profile = config.ProfileHA
	c.ObjectStorage.Mode = "external"
	steps := provisionGraph(c)
	if err := runner.Validate(toNodes(steps)); err != nil {
		t.Fatal(err)
	}
	// Golden set of skipped bundled-storage nodes. Other core steps still run.
	var skipped []string
	for _, s := range steps {
		if s.name == "minio" || s.name == "storage-scoped" {
			if !s.skip {
				t.Fatalf("%s must be skipped", s.name)
			}
			skipped = append(skipped, s.name)
		}
		if (s.name == "platform" || s.name == "routing") && s.skip {
			t.Fatal(s.name)
		}
	}
	if strings.Join(skipped, ",") != "minio,storage-scoped" {
		t.Fatal(skipped)
	}
}

func TestReadObjectCredentials(t *testing.T) {
	d, err := readObjectCredentials(strings.NewReader("access\nsecret\n"))
	if err != nil || d["OBJECT_STORAGE_ACCESS_KEY"] != "access" || d["OBJECT_STORAGE_SECRET_KEY"] != "secret" {
		t.Fatal(err)
	}
	for _, input := range []string{"", "access\n", "\nsecret\n", "access\nsecret\nextra\n"} {
		if _, err := readObjectCredentials(strings.NewReader(input)); err == nil {
			t.Fatal("accepted malformed input")
		}
	}
}

func TestExternalObjectArchiveDefaults(t *testing.T) {
	c := &config.Config{ObjectStorage: config.ObjectStorageSettings{Mode: "external"}}
	if defaultArchiveTarget(c) != "external" {
		t.Fatal(defaultArchiveTarget(c))
	}
	c.Backup.Mode = config.BackupModeLocal
	if defaultArchiveTarget(c) != defaultLocalArchiveTarget {
		t.Fatal("explicit local archive choice overridden")
	}
	if got := strings.Join(objectBackupComponents(c, []string{"config", "postgres", "minio", "k3s"}), ","); got != "config,postgres,k3s" {
		t.Fatal(got)
	}
}

func TestResolveExternalObjectStorageProbesAndRejectsMigration(t *testing.T) {
	backupSandbox(t)
	oldPrepare, oldStdin, oldCredentials := prepareObjectStorage, objectCredentialsStdin, objectCredentials
	t.Cleanup(func() {
		prepareObjectStorage, objectCredentialsStdin, objectCredentials = oldPrepare, oldStdin, oldCredentials
	})
	objectCredentialsStdin = true
	c := &config.Config{NonInteractive: true, ObjectStorage: config.ObjectStorageSettings{
		Mode: "external", Endpoint: "https://objects.example.com", Region: "auto", BucketPrefix: "test-cairn"}}
	calls := 0
	prepareObjectStorage = func(c *config.Config, d map[string]string) error {
		calls++
		if d["OBJECT_STORAGE_ACCESS_KEY"] != "access" {
			t.Fatal("credentials missing")
		}
		return errors.New("external endpoint probe failed")
	}
	if err := resolveObjectStorage(c, strings.NewReader("access\nsecret\n")); err == nil || err.Error() != "external endpoint probe failed" || calls != 1 {
		t.Fatal(err, calls)
	}
	if err := state.MarkDone("minio"); err != nil {
		t.Fatal(err)
	}
	if err := resolveObjectStorage(c, strings.NewReader("access\nsecret\n")); err == nil || !strings.Contains(err.Error(), "fresh installs") || calls != 1 {
		t.Fatal(err, calls)
	}
}

func TestObjectStorageBecomesBackupTargetUnlessExplicit(t *testing.T) {
	probed := backupSandbox(t)
	oldCredentials := objectCredentials
	t.Cleanup(func() { objectCredentials = oldCredentials })
	objectCredentials = map[string]string{"OBJECT_STORAGE_ACCESS_KEY": "access", "OBJECT_STORAGE_SECRET_KEY": "secret"}
	c := &config.Config{NonInteractive: true, ObjectStorage: config.ObjectStorageSettings{
		Mode: "external", Endpoint: "https://objects.example.com", Region: "auto", BucketPrefix: "test-cairn"}}
	if err := resolveBackupTarget(c); err != nil {
		t.Fatal(err)
	}
	if c.Backup.Bucket != "test-cairn-backups" || !c.BackupExternal() || len(*probed) != 1 {
		t.Fatal(c.Backup, *probed)
	}
	c.Backup.Bucket = "separate-target"
	if err := resolveBackupTarget(c); err != nil {
		t.Fatal(err)
	}
	if c.Backup.Bucket != "separate-target" {
		t.Fatal("explicit target overridden")
	}
}

func TestObjectCredentialsStdinNeedsAuto(t *testing.T) {
	old := objectCredentialsStdin
	t.Cleanup(func() { objectCredentialsStdin = old })
	objectCredentialsStdin = true
	if err := checkObjectStorageFlags(&config.Config{}); err == nil || !strings.Contains(err.Error(), "--auto") {
		t.Fatal(err)
	}
	if err := checkObjectStorageFlags(&config.Config{NonInteractive: true}); err != nil {
		t.Fatal(err)
	}
}

func TestObjectStorageModeCannotChangeAfterInstall(t *testing.T) {
	backupSandbox(t)
	oldMode, oldPrepare := objectModeFlag, prepareObjectStorage
	t.Cleanup(func() { objectModeFlag, prepareObjectStorage = oldMode, oldPrepare })
	prepareObjectStorage = func(*config.Config, map[string]string) error { return nil }
	if err := state.MarkDone("platform"); err != nil {
		t.Fatal(err)
	}
	objectModeFlag = "external"
	c := &config.Config{NonInteractive: true, ObjectStorage: config.ObjectStorageSettings{
		Endpoint: "https://objects.example.com", Region: "auto", BucketPrefix: "test-cairn"}}
	if err := resolveObjectStorage(c, strings.NewReader("")); err == nil || !strings.Contains(err.Error(), "cannot change") {
		t.Fatal(err)
	}
	objectModeFlag = "bundled"
	c = &config.Config{NonInteractive: true, ObjectStorage: config.ObjectStorageSettings{Mode: "external",
		Endpoint: "https://objects.example.com/", Region: "auto", BucketPrefix: "test-cairn"}}
	if err := resolveObjectStorage(c, strings.NewReader("")); err == nil || !strings.Contains(err.Error(), "cannot change") {
		t.Fatal(err)
	}
}
