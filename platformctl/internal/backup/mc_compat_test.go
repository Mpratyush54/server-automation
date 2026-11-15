package backup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withMCConfig points the mc config lookup at a temporary file.
func withMCConfig(t *testing.T, body string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(p, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	old := mcConfigPaths
	mcConfigPaths = func() []string { return []string{p} }
	t.Cleanup(func() { mcConfigPaths = old; legacyTargets = map[string]S3Target{} })
}

// A backup.json written before #195 (target s3://<mc alias>/...) keeps
// working: the alias is read from mc's config file without the mc binary.
func TestLegacyMCAliasTargetRoundTrip(t *testing.T) {
	f := newRichFakeS3()
	_, srv := testClient(t, f)
	withMCConfig(t, `{"version":"10","aliases":{"offsite":{"url":"`+srv.URL+`","accessKey":"AK","secretKey":"SK","api":"s3v4","path":"auto"}}}`)
	externalS3 = nil

	tg, err := ParseTarget("s3://offsite/bkt/platform/archives")
	if err != nil {
		t.Fatal(err)
	}
	s := Store{Target: tg}
	dir := t.TempDir()
	src := filepath.Join(dir, "config.tar.age")
	if err := os.WriteFile(src, []byte("payload"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("20260101T000000Z", "config.tar.age", src); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.objects["bkt/platform/archives/20260101T000000Z/config.tar.age"]; !ok {
		t.Fatalf("object not at the legacy path: %v", f.objects)
	}
	dst := filepath.Join(dir, "out")
	if err := s.Get("20260101T000000Z", "config.tar.age", dst); err != nil {
		t.Fatal(err)
	}
	if _, incomplete, err := s.ListWithIncomplete(); err != nil || len(incomplete) != 1 {
		t.Fatalf("list: %v %v", incomplete, err)
	}
}

func TestLegacyMCAliasMissingNamesTheFix(t *testing.T) {
	withMCConfig(t, `{"version":"10","aliases":{}}`)
	externalS3 = nil
	tg, _ := ParseTarget("s3://gone/bkt/prefix")
	_, err := (Store{Target: tg}).List()
	if err == nil || !strings.Contains(err.Error(), `mc alias "gone"`) || !strings.Contains(err.Error(), "sudo platformctl backup target set") {
		t.Fatal(err)
	}
	if strings.Contains(err.Error(), "\n") {
		t.Fatal("error should be one line")
	}
}

func TestLegacyMCAliasFromEnvAndOldHostsKey(t *testing.T) {
	withMCConfig(t, `{"version":"9","hosts":{"old":{"url":"https://s3.eu-west-2.amazonaws.com","accessKey":"A1","secretKey":"S1"}}}`)
	got, err := legacyAliasTarget("old", "bucket-one")
	if err != nil {
		t.Fatal(err)
	}
	if got.Region != "eu-west-2" || got.AccessKey != "A1" || got.Endpoint != "https://s3.eu-west-2.amazonaws.com" {
		t.Fatalf("%+v", got)
	}
	t.Setenv("MC_HOST_envalias", "http://A2:S%2F2@10.1.2.3:9000")
	got, err = legacyAliasTarget("envalias", "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Endpoint != "http://10.1.2.3:9000" || got.AccessKey != "A2" || got.SecretKey != "S/2" {
		t.Fatalf("%+v", got)
	}
}

func TestConfigStillAcceptsMinioAlias(t *testing.T) {
	c := Config{Target: "file:///var/backups/x", Recipient: "", Retention: Retention{Daily: 1}, Components: []string{"config", "postgres", "minio"}, MinioAlias: "src"}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.MinioAlias = "bad alias"
	if err := c.Validate(); err == nil {
		t.Fatal("invalid alias accepted")
	}
}

// Capture copies every bucket except platform-backups into the layout older
// releases wrote with `mc mirror`; restore puts it back.
func TestMinioCaptureAndRestoreRoundTrip(t *testing.T) {
	f := newRichFakeS3()
	_, srv := testClient(t, f)
	old := minioSourceTarget
	minioSourceTarget = func(string) (S3Target, error) {
		return S3Target{Endpoint: srv.URL, AccessKey: "AK", SecretKey: "SK"}, nil
	}
	t.Cleanup(func() { minioSourceTarget = old })
	f.objects["platform-uploads/a/b c.txt"] = []byte("one")
	f.objects["platform-uploads/empty"] = []byte{}
	f.objects["platform-uploads/folder/"] = []byte{}
	f.objects["replays/r1"] = []byte("two")
	f.objects["platform-backups/skip"] = []byte("old backup")

	dir := t.TempDir()
	if err := captureMinioBuckets(dir, ""); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "objects", "platform-uploads", "a", "b c.txt"))
	if err != nil || string(b) != "one" {
		t.Fatal(string(b), err)
	}
	if _, err := os.Stat(filepath.Join(dir, "objects", "platform-backups")); !os.IsNotExist(err) {
		t.Fatal("platform-backups must not be captured")
	}
	list, _ := os.ReadFile(filepath.Join(dir, "buckets"))
	if !strings.Contains(string(list), "platform-uploads/") || !strings.Contains(string(list), "replays/") {
		t.Fatal(string(list))
	}

	f.objects = map[string][]byte{}
	if err := restoreMinioBuckets(dir, ""); err != nil {
		t.Fatal(err)
	}
	if string(f.objects["platform-uploads/a/b c.txt"]) != "one" || string(f.objects["replays/r1"]) != "two" {
		t.Fatalf("restore: %v", f.objects)
	}
	if v, ok := f.objects["platform-uploads/empty"]; !ok || len(v) != 0 {
		t.Fatal("empty object not restored")
	}
}

func TestMinioCaptureRefusesEscapingKeys(t *testing.T) {
	f := newRichFakeS3()
	_, srv := testClient(t, f)
	old := minioSourceTarget
	minioSourceTarget = func(string) (S3Target, error) {
		return S3Target{Endpoint: srv.URL, AccessKey: "AK", SecretKey: "SK"}, nil
	}
	t.Cleanup(func() { minioSourceTarget = old })
	f.objects["evil/../../outside"] = []byte("x")
	dir := t.TempDir()
	err := captureMinioBuckets(filepath.Join(dir, "cap"), "")
	if err == nil || !strings.Contains(err.Error(), "cannot back up") {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "outside")); !os.IsNotExist(err) {
		t.Fatal("file written outside the capture directory")
	}
}
