package bundle

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

type entry struct {
	name     string
	body     string
	typeflag byte
	linkname string
}

func sha(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// buildBundle writes a tar.zst with the given entries and returns its path.
func buildBundle(t *testing.T, dir string, entries []entry) string {
	t.Helper()
	var raw bytes.Buffer
	tw := tar.NewWriter(&raw)
	for _, e := range entries {
		tf := e.typeflag
		if tf == 0 {
			tf = tar.TypeReg
		}
		hdr := &tar.Header{Name: e.name, Mode: 0o644, Size: int64(len(e.body)), Typeflag: tf, Linkname: e.linkname}
		if tf != tar.TypeReg {
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if tf == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "platform-bundle-v0.0.1-amd64.tar.zst")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	zw, err := zstd.NewWriter(f)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := zw.Write(raw.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return p
}

func goodEntries() []entry {
	files := map[string]string{
		"k3s/k3s-airgap-images-amd64.tar.zst":  "k3s-images",
		"images/platform-images-amd64.tar.zst": "platform-images",
		"charts/redis-28.3.12.tgz":             "redis-chart",
		"charts/ingress-nginx-4.15.1.tgz":      "nginx-chart",
	}
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	var sums strings.Builder
	for _, n := range names {
		fmt.Fprintf(&sums, "%s  %s\n", sha(files[n]), n)
	}
	out := []entry{
		{name: "SHA256SUMS", body: sums.String()},
		{name: "manifest.json", body: `{"version":"v0.0.1"}`},
		{name: "charts/", typeflag: tar.TypeDir},
	}
	for _, n := range names {
		out = append(out, entry{name: n, body: files[n]})
	}
	return out
}

func testOpts(t *testing.T) Options {
	root := t.TempDir()
	return Options{ImagesDir: filepath.Join(root, "images"), ChartsDir: filepath.Join(root, "charts")}
}

func writeSidecar(t *testing.T, bundle string, sum string) {
	t.Helper()
	line := sum + "  " + filepath.Base(bundle) + "\n"
	if err := os.WriteFile(bundle+".sha256", []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertFile(t *testing.T, p, want string) {
	t.Helper()
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("expected %s: %v", p, err)
	}
	if string(got) != want {
		t.Fatalf("%s = %q, want %q", p, got, want)
	}
}

func TestInstallPlacesFiles(t *testing.T) {
	b := buildBundle(t, t.TempDir(), goodEntries())
	sum, err := fileSHA256(b)
	if err != nil {
		t.Fatal(err)
	}
	writeSidecar(t, b, sum)
	opts := testOpts(t)

	if err := InstallWithOptions(b, opts); err != nil {
		t.Fatalf("install: %v", err)
	}
	assertFile(t, filepath.Join(opts.ImagesDir, "k3s-airgap-images-amd64.tar.zst"), "k3s-images")
	assertFile(t, filepath.Join(opts.ImagesDir, "platform-images-amd64.tar.zst"), "platform-images")
	assertFile(t, filepath.Join(opts.ChartsDir, "redis-28.3.12.tgz"), "redis-chart")
	assertFile(t, filepath.Join(opts.ChartsDir, "ingress-nginx-4.15.1.tgz"), "nginx-chart")
	for _, notInstalled := range []string{"manifest.json", "SHA256SUMS"} {
		if _, err := os.Stat(filepath.Join(opts.ChartsDir, notInstalled)); err == nil {
			t.Errorf("%s should not be installed", notInstalled)
		}
	}
}

func TestInstallWithoutSidecar(t *testing.T) {
	b := buildBundle(t, t.TempDir(), goodEntries())
	if err := InstallWithOptions(b, testOpts(t)); err != nil {
		t.Fatalf("install without .sha256 should succeed: %v", err)
	}
}

func TestInstallSidecarMismatch(t *testing.T) {
	b := buildBundle(t, t.TempDir(), goodEntries())
	writeSidecar(t, b, sha("something else"))
	opts := testOpts(t)
	err := InstallWithOptions(b, opts)
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected checksum mismatch, got %v", err)
	}
	if _, err := os.Stat(opts.ChartsDir); err == nil {
		t.Error("nothing should be extracted on outer checksum mismatch")
	}
}

func TestInstallInnerSumMismatch(t *testing.T) {
	entries := goodEntries()
	for i := range entries {
		if entries[i].name == "charts/redis-28.3.12.tgz" {
			entries[i].body = "tampered"
		}
	}
	b := buildBundle(t, t.TempDir(), entries)
	opts := testOpts(t)
	err := InstallWithOptions(b, opts)
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected inner checksum mismatch, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(opts.ChartsDir, "redis-28.3.12.tgz")); err == nil {
		t.Error("tampered file should be removed after failure")
	}
}

func TestInstallRejectsTraversal(t *testing.T) {
	cases := []entry{
		{name: "../evil.tgz", body: "x"},
		{name: "charts/../../evil.tgz", body: "x"},
		{name: "/etc/evil.tgz", body: "x"},
		{name: "charts/link.tgz", typeflag: tar.TypeSymlink, linkname: "/etc/passwd"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			b := buildBundle(t, dir, append(goodEntries(), c))
			opts := testOpts(t)
			if err := InstallWithOptions(b, opts); err == nil {
				t.Fatalf("expected rejection of %q", c.name)
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(opts.ChartsDir), "..", "evil.tgz")); err == nil {
				t.Fatal("traversal file was written")
			}
		})
	}
}

func TestInstallEmptyBundle(t *testing.T) {
	b := buildBundle(t, t.TempDir(), []entry{{name: "manifest.json", body: "{}"}})
	if err := InstallWithOptions(b, testOpts(t)); err == nil {
		t.Fatal("expected error for bundle without images or charts")
	}
}

func TestFetch(t *testing.T) {
	src := buildBundle(t, t.TempDir(), goodEntries())
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	sumHex := hex.EncodeToString(sum[:])
	badSum := false

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0.0/platform-bundle-v1.0.0-amd64.tar.zst":
			_, _ = w.Write(data)
		case "/v1.0.0/platform-bundle-v1.0.0-amd64.tar.zst.sha256":
			s := sumHex
			if badSum {
				s = sha("nope")
			}
			fmt.Fprintf(w, "%s  platform-bundle-v1.0.0-amd64.tar.zst\n", s)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	old := ReleaseBaseURL
	ReleaseBaseURL = srv.URL
	defer func() { ReleaseBaseURL = old }()

	dest := t.TempDir()
	p, err := Fetch(context.Background(), "1.0.0", "amd64", dest)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if filepath.Base(p) != "platform-bundle-v1.0.0-amd64.tar.zst" {
		t.Fatalf("unexpected path %s", p)
	}
	if err := InstallWithOptions(p, testOpts(t)); err != nil {
		t.Fatalf("install fetched bundle: %v", err)
	}

	badSum = true
	if _, err := Fetch(context.Background(), "v1.0.0", "amd64", t.TempDir()); err == nil {
		t.Fatal("expected checksum mismatch")
	}
	if _, err := Fetch(context.Background(), "v9.9.9", "amd64", t.TempDir()); err == nil {
		t.Fatal("expected 404 error")
	}
}

func TestURL(t *testing.T) {
	want := "https://github.com/Mpratyush54/server-automation/releases/download/v1.0.0/platform-bundle-v1.0.0-arm64.tar.zst"
	if got := URL("v1.0.0", "arm64"); got != want {
		t.Fatalf("URL = %s", got)
	}
}
