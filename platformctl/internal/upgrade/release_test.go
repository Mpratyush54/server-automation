package upgrade

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func fakeHTTP(t *testing.T, fn func(*http.Request) (int, string)) {
	t.Helper()
	old := client
	client = &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		code, body := fn(r)
		return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	t.Cleanup(func() { client = old })
}
func TestMetadataRulesAndLegacyFallback(t *testing.T) {
	rules := `{"minimumSource":"1.2.0","breakingNotes":"maintenance window","irreversibleMigrations":true}`
	fakeHTTP(t, func(r *http.Request) (int, string) {
		if strings.HasSuffix(r.URL.Path, "upgrade.json") {
			return 200, rules
		}
		return 200, `{"tag_name":"v1.3.0","body":"release notes"}`
	})
	r, e := Metadata("1.3.0")
	if e != nil || r.Tag != "v1.3.0" || r.Rules.MinimumSource != "1.2.0" || !r.Rules.Irreversible {
		t.Fatal(r, e)
	}
	rules = "invalid"
	if _, e = Metadata("1.3.0"); e == nil {
		t.Fatal("accepted invalid rules")
	}
}
func TestMissingMetadataAndPatchSelection(t *testing.T) {
	fakeHTTP(t, func(r *http.Request) (int, string) {
		if strings.HasSuffix(r.URL.Path, "/releases") {
			return 200, `[{"tag_name":"v1.3.0"},{"tag_name":"v1.2.9"},{"tag_name":"v1.2.10-rc.1","prerelease":true},{"tag_name":"v1.2.8","draft":true}]`
		}
		if strings.Contains(r.URL.Path, "/tags/") {
			return 200, `{"tag_name":"v1.2.9"}`
		}
		return 404, ""
	})
	r, e := PatchMetadata("v1.2.3")
	if e != nil || r.Tag != "v1.2.9" || r.Rules.MinimumSource != "" {
		t.Fatal(r, e)
	}
}
func TestArchiveChecksumAndSafeExtraction(t *testing.T) {
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tr := tar.NewWriter(gz)
	// Other members (including paths outside the destination) are never extracted.
	for _, name := range []string{"../outside", "platformctl"} {
		if e := tr.WriteHeader(&tar.Header{Name: name, Mode: 0700, Size: 6, Typeflag: tar.TypeReg}); e != nil {
			t.Fatal(e)
		}
		_, _ = tr.Write([]byte("binary"))
	}
	_ = tr.Close()
	_ = gz.Close()
	data := b.Bytes()
	sum := sha256.Sum256(data)
	sums := []byte(fmt.Sprintf("%x  asset.tar.gz\n", sum))
	dir := t.TempDir()
	p, e := extractVerified("asset.tar.gz", sums, data, dir)
	if e != nil {
		t.Fatal(e)
	}
	out, e := os.ReadFile(p)
	if e != nil || string(out) != "binary" {
		t.Fatal(string(out), e)
	}
	for _, bad := range [][]byte{nil, []byte("wrong asset.tar.gz"), append(sums, sums...)} {
		if _, e = extractVerified("asset.tar.gz", bad, data, t.TempDir()); e == nil {
			t.Fatal("accepted bad checksum")
		}
	}
	data = append([]byte{}, data...)
	data[0] ^= 1
	if _, e = extractVerified("asset.tar.gz", sums, data, t.TempDir()); e == nil {
		t.Fatal("accepted corrupted archive")
	}
}
func TestMirrorLayerDigests(t *testing.T) {
	sum := sha256.Sum256([]byte("archive"))
	checks := []byte("checksums")
	cs := sha256.Sum256(checks)
	fakeHTTP(t, func(r *http.Request) (int, string) {
		switch {
		case r.URL.Path == "/token":
			return 200, `{"token":"fake"}`
		case strings.Contains(r.URL.Path, "/manifests/"):
			return 200, fmt.Sprintf(`{"layers":[{"digest":"sha256:%x","annotations":{"org.opencontainers.image.title":"asset"}},{"digest":"sha256:%x","annotations":{"org.opencontainers.image.title":"checksums.txt"}}]}`, sum, cs)
		case strings.HasSuffix(r.URL.Path, fmt.Sprintf("%x", sum)):
			return 200, "archive"
		default:
			return 200, string(checks)
		}
	})
	s, a, e := mirror("1.2.3", "asset")
	if e != nil || string(s) != "checksums" || string(a) != "archive" {
		t.Fatal(string(s), string(a), e)
	}
}
