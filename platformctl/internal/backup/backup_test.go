package backup

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

func TestTarget(t *testing.T) {
	for _, raw := range []string{"s3://r2/backups/platform", "file:///var/backups/platform"} {
		if _, e := ParseTarget(raw); e != nil {
			t.Fatal(raw, e)
		}
	}
	for _, raw := range []string{"", "https://r2/bucket", "s3://user:pass@host/bucket", "s3://alias", "s3://alias/bucket/../other", "s3://alias/bucket/%2e%2e", "s3://alias/bucket?secret=x", "s3://alias/bucket#x", "file:///", "file://remote/tmp", "s3://alias/bucket/a\\b"} {
		if _, e := ParseTarget(raw); e == nil {
			t.Fatal("accepted", raw)
		}
	}
}
func TestRetention(t *testing.T) {
	var items []Manifest
	for i, s := range []string{"2026-01-01T01:00:00Z", "2026-01-01T02:00:00Z", "2025-12-31T01:00:00Z", "2025-12-20T01:00:00Z", "2025-11-01T01:00:00Z", "2025-10-01T01:00:00Z"} {
		tm, _ := time.Parse(time.RFC3339, s)
		items = append(items, Manifest{ID: fmt.Sprint(i), CreatedAt: tm})
	}
	got, e := Prune(items, Retention{Daily: 2, Weekly: 2, Monthly: 2})
	if e != nil {
		t.Fatal(e)
	}
	// Jan 1 newest (1), Dec 31 daily (2), Dec 20 weekly (3), Dec 31
	// monthly (2). Nov/Oct and the older same-day Jan snapshot are pruned.
	want := []string{"0", "4", "5"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if _, e = Prune(items, Retention{}); e == nil {
		t.Fatal("zero daily retention accepted")
	}
}
func identity(t *testing.T) *age.X25519Identity {
	t.Helper()
	k, e := age.GenerateX25519Identity()
	if e != nil {
		t.Fatal(e)
	}
	return k
}
func TestEncryptionRoundTrip(t *testing.T) {
	k := identity(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "source")
	os.Mkdir(src, 0700)
	want := []byte("secret DB bytes\x00\xff")
	os.WriteFile(filepath.Join(src, "data"), want, 0600)
	out := filepath.Join(dir, "archive.age")
	if e := EncryptDirectory(src, out, k.Recipient().String()); e != nil {
		t.Fatal(e)
	}
	ciphertext, _ := os.ReadFile(out)
	if bytes.Contains(ciphertext, want) || bytes.Contains(ciphertext, []byte(k.String())) {
		t.Fatal("plaintext/key leaked")
	}
	dst := t.TempDir()
	if e := DecryptDirectory(out, dst, strings.NewReader(k.String())); e != nil {
		t.Fatal(e)
	}
	got, _ := os.ReadFile(filepath.Join(dst, "data"))
	if !bytes.Equal(got, want) {
		t.Fatal("wrong plaintext")
	}
	if e := DecryptDirectory(out, t.TempDir(), strings.NewReader(identity(t).String())); e == nil {
		t.Fatal("wrong key accepted")
	}
	ciphertext[len(ciphertext)-1] ^= 1
	os.WriteFile(out, ciphertext, 0600)
	if e := DecryptDirectory(out, t.TempDir(), strings.NewReader(k.String())); e == nil {
		t.Fatal("corruption accepted")
	}
}
func TestRejectUnsafeArchive(t *testing.T) {
	k := identity(t)
	for _, name := range []string{"../outside", "/etc/passwd", "a\\..\\outside", "C:/outside"} {
		t.Run(name, func(t *testing.T) {
			f := filepath.Join(t.TempDir(), "test.age")
			out, _ := os.Create(f)
			w, _ := age.Encrypt(out, k.Recipient())
			tw := tar.NewWriter(w)
			tw.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: 1, Typeflag: tar.TypeReg})
			tw.Write([]byte("x"))
			tw.Close()
			w.Close()
			out.Close()
			if e := DecryptDirectory(f, t.TempDir(), strings.NewReader(k.String())); e == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}

type fakeDriver struct {
	fail     string
	restored []string
}

func (d *fakeDriver) Capture(component, dir string) error {
	if component == d.fail {
		return fmt.Errorf("capture failed")
	}
	return os.WriteFile(filepath.Join(dir, "data"), []byte(component+" original credentials/data"), 0600)
}
func (d *fakeDriver) Restore(component, dir string) error {
	b, e := os.ReadFile(filepath.Join(dir, "data"))
	if e != nil {
		return e
	}
	if !strings.HasPrefix(string(b), component) {
		return fmt.Errorf("wrong component data")
	}
	d.restored = append(d.restored, component)
	return nil
}
func testConfig(t *testing.T, k *age.X25519Identity) Config {
	return Config{Target: "file://" + filepath.ToSlash(t.TempDir()), Recipient: k.Recipient().String(), Retention: Retention{Daily: 2, Weekly: 1, Monthly: 1}, Components: []string{"config", "postgres"}}
}

// Construct a file URL rooted beneath t.TempDir on Linux and Windows.
func engineConfig(t *testing.T, k *age.X25519Identity) Config {
	c := testConfig(t, k)
	p := strings.TrimPrefix(c.Target, "file://")
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	c.Target = "file://" + p
	return c
}
func TestCreateRestoreAndCorruption(t *testing.T) {
	k := identity(t)
	c := engineConfig(t, k)
	d := &fakeDriver{}
	m, e := Create(c, "v1-test", d)
	if e != nil {
		t.Fatal(e)
	}
	if e = m.Validate(); e != nil {
		t.Fatal(e)
	}
	target, _ := ParseTarget(c.Target)
	s := Store{target}
	items, e := s.List()
	if e != nil || len(items) != 1 {
		t.Fatal(items, e)
	}
	if m.PlatformVersion != "v1-test" || len(m.Artifacts) != 2 {
		t.Fatal(m)
	}
	if e = Restore(c.Target, m.ID, "", []byte(k.String()), d); e != nil {
		t.Fatal(e)
	}
	// Data first, config (matching Secrets/.env) last.
	if !reflect.DeepEqual(d.restored, []string{"postgres", "config"}) {
		t.Fatal(d.restored)
	}
	// Corrupt the SECOND artifact: the first must not have been applied either.
	d.restored = nil
	os.WriteFile(filepath.Join(target.Path, m.ID, "postgres.tar.age"), []byte("bad"), 0600)
	if e = Restore(c.Target, m.ID, "", []byte(k.String()), d); e == nil || len(d.restored) != 0 {
		t.Fatal("corrupt restore mutated data", e, d.restored)
	}
}
func TestFailedCaptureIsNotPublished(t *testing.T) {
	k := identity(t)
	c := engineConfig(t, k)
	m, e := Create(c, "test", &fakeDriver{fail: "postgres"})
	if e == nil {
		t.Fatal("capture should fail")
	}
	target, _ := ParseTarget(c.Target)
	if _, e = os.Stat(filepath.Join(target.Path, m.ID, "backup.json")); !os.IsNotExist(e) {
		t.Fatal("failed backup published")
	}
	items, e := (Store{target}).List()
	if e != nil || len(items) != 0 {
		t.Fatal(items, e)
	}
}
func TestManifestAndRetentionOnStore(t *testing.T) {
	k := identity(t)
	c := engineConfig(t, k)
	target, _ := ParseTarget(c.Target)
	s := Store{target}
	for i := 0; i < 4; i++ {
		dir := t.TempDir()
		file := filepath.Join(dir, "config.tar.age")
		os.WriteFile(file, []byte("ciphertext"), 0600)
		h, n, _ := Checksum(file)
		m := Manifest{Version: 1, ID: fmt.Sprint(i), CreatedAt: time.Date(2026, 1, i+1, 0, 0, 0, 0, time.UTC), PlatformVersion: "test", Artifacts: []Artifact{{"config", "config.tar.age", h, n}}}
		if e := s.Put(m.ID, "config.tar.age", file); e != nil {
			t.Fatal(e)
		}
		b, _ := json.Marshal(m)
		manifest := filepath.Join(dir, "backup.json")
		os.WriteFile(manifest, b, 0600)
		s.Put(m.ID, "backup.json", manifest)
	}
	if e := s.Retain(Retention{Daily: 2}); e != nil {
		t.Fatal(e)
	}
	items, e := s.List()
	if e != nil || len(items) != 2 {
		t.Fatal(items, e)
	}
	m := items[0]
	m.Artifacts[0].File = "../bad"
	if e = m.Validate(); e == nil {
		t.Fatal("unsafe filename accepted")
	}
}
