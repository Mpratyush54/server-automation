package stack

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/ocifetch"
)

func registry(t *testing.T, files map[string]string, corrupt string) (*ocifetch.Client, string) {
	t.Helper()
	blobs := map[string]string{}
	var layers []string
	for name, data := range files {
		sum := sha256.Sum256([]byte(data))
		d := "sha256:" + hex.EncodeToString(sum[:])
		blobs[d] = data
		if name == corrupt {
			blobs[d] = "tampered"
		}
		layers = append(layers, fmt.Sprintf(`{"digest":%q,"size":%d,"annotations":{"org.opencontainers.image.title":%q}}`, d, len(data), name))
	}
	manifest := fmt.Sprintf(`{"schemaVersion":2,"layers":[%s]}`, strings.Join(layers, ","))
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"token":"anon"}`) })
	mux.HandleFunc("/v2/mpratyush54/platform-stack/manifests/stable-amd64", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, manifest)
	})
	mux.HandleFunc("/v2/mpratyush54/platform-stack/blobs/", func(w http.ResponseWriter, r *http.Request) {
		data, ok := blobs[strings.TrimPrefix(r.URL.Path, "/v2/mpratyush54/platform-stack/blobs/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, data)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	sum := sha256.Sum256([]byte(manifest))
	return &ocifetch.Client{BaseURL: srv.URL, HTTP: srv.Client()}, "sha256:" + hex.EncodeToString(sum[:])
}

func testPaths(t *testing.T) Paths {
	d := t.TempDir()
	return Paths{K3sImages: filepath.Join(d, "images"), Charts: filepath.Join(d, "charts"),
		Staging: filepath.Join(d, "stack"), Record: filepath.Join(d, "stack", "installed.json")}
}

var stackFiles = map[string]string{
	"stack.json":                      `{"stackVersion":"2026.11.08-7"}`,
	"k3s":                             "k3s-binary",
	"k3s-install.sh":                  "#!/bin/sh\n",
	"k3s-airgap-images-amd64.tar.zst": "airgap",
	"platform-images-amd64-1.tar.zst": "images-1",
	"platform-images-amd64-2.tar.zst": "images-2",
	"chart-redis-28.3.12.tgz":         "redis-chart",
	"README.unknown":                  "ignored",
}

func TestInstallPlacesEveryFileAndRecordsTheDigest(t *testing.T) {
	client, digest := registry(t, stackFiles, "")
	p := testPaths(t)
	res, err := Install(client, "stable-amd64", p, 3)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		filepath.Join(p.K3sImages, "k3s-airgap-images-amd64.tar.zst"): "airgap",
		filepath.Join(p.K3sImages, "platform-images-amd64-1.tar.zst"): "images-1",
		filepath.Join(p.K3sImages, "platform-images-amd64-2.tar.zst"): "images-2",
		filepath.Join(p.Charts, "redis-28.3.12.tgz"):                  "redis-chart",
		p.K3sBinary(): "k3s-binary",
		p.K3sScript(): "#!/bin/sh\n",
	}
	for path, body := range want {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != body {
			t.Errorf("%s: got %q, %v", path, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(p.K3sImages, "README.unknown")); !os.IsNotExist(err) {
		t.Error("unknown files must be skipped")
	}
	if !p.Staged() {
		t.Error("k3s binary and script should be staged")
	}
	if res.Digest != digest || res.Version != "2026.11.08-7" || res.Tag != "stable-amd64" {
		t.Fatalf("result %+v, want digest %s", res, digest)
	}
	var rec Result
	data, _ := os.ReadFile(p.Record)
	if json.Unmarshal(data, &rec) != nil || rec.Digest != digest {
		t.Fatalf("installed stack not recorded: %s", data)
	}
}

func TestInstallFailsOnACorruptFile(t *testing.T) {
	client, _ := registry(t, stackFiles, "platform-images-amd64-2.tar.zst")
	p := testPaths(t)
	_, err := Install(client, "stable-amd64", p, 4)
	if err == nil || !strings.Contains(err.Error(), "digest mismatch") {
		t.Fatalf("expected a digest mismatch, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(p.K3sImages, "platform-images-amd64-2.tar.zst")); !os.IsNotExist(statErr) {
		t.Fatal("a corrupt image tarball must never reach the k3s images directory")
	}
}

func TestTag(t *testing.T) {
	for choice, want := range map[string]string{
		"": "stable-amd64", "stable": "stable-amd64", "edge": "edge-amd64",
		"2026.11.08-3": "2026.11.08-3-amd64", "off": "", " none ": "",
	} {
		if got := Tag(choice, "amd64"); got != want {
			t.Errorf("Tag(%q) = %q, want %q", choice, got, want)
		}
	}
}
