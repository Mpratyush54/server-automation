package ocifetch

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func registry(t *testing.T, files map[string][]byte, corrupt string) *httptest.Server {
	t.Helper()
	blobs := map[string][]byte{}
	var layers []string
	for name, data := range files {
		sum := sha256.Sum256(data)
		d := "sha256:" + hex.EncodeToString(sum[:])
		blobs[d] = data
		if name == corrupt {
			blobs[d] = append([]byte("x"), data...)
		}
		layers = append(layers, fmt.Sprintf(`{"digest":%q,"size":%d,"annotations":{%q:%q}}`, d, len(data), TitleAnnotation, name))
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Query().Get("scope"), "repository:o/k3s:pull") {
			http.Error(w, "bad scope", 400)
			return
		}
		fmt.Fprint(w, `{"token":"anon"}`)
	})
	mux.HandleFunc("/v2/o/k3s/manifests/v1-k3s1", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer anon" {
			http.Error(w, "no auth", 401)
			return
		}
		fmt.Fprintf(w, `{"schemaVersion":2,"layers":[%s]}`, strings.Join(layers, ","))
	})
	mux.HandleFunc("/v2/o/k3s/blobs/", func(w http.ResponseWriter, r *http.Request) {
		d := strings.TrimPrefix(r.URL.Path, "/v2/o/k3s/blobs/")
		data, ok := blobs[d]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(data)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchVerifiesAndWritesNamedLayer(t *testing.T) {
	srv := registry(t, map[string][]byte{"k3s": []byte("binary"), "install.sh": []byte("#!/bin/sh")}, "")
	c := &Client{BaseURL: srv.URL, HTTP: srv.Client()}
	dst := filepath.Join(t.TempDir(), "k3s")
	if err := c.Fetch("o/k3s", "v1-k3s1", "k3s", dst, 0o755); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(dst)
	if string(got) != "binary" {
		t.Fatalf("got %q", got)
	}
	if fi, _ := os.Stat(dst); fi.Mode().Perm()&0o100 == 0 && os.PathSeparator == '/' {
		t.Fatalf("mode %v not executable", fi.Mode())
	}
}

func TestFetchRejectsDigestMismatchAndLeavesNoFile(t *testing.T) {
	srv := registry(t, map[string][]byte{"k3s": []byte("binary")}, "k3s")
	c := &Client{BaseURL: srv.URL, HTTP: srv.Client()}
	dst := filepath.Join(t.TempDir(), "k3s")
	err := c.Fetch("o/k3s", "v1-k3s1", "k3s", dst, 0o755)
	if err == nil || !strings.Contains(err.Error(), "digest mismatch") {
		t.Fatalf("expected digest mismatch, got %v", err)
	}
	if _, statErr := os.Stat(dst); !os.IsNotExist(statErr) {
		t.Fatal("a corrupt download must not be written")
	}
}

func TestFetchMissingFile(t *testing.T) {
	srv := registry(t, map[string][]byte{"k3s": []byte("binary")}, "")
	c := &Client{BaseURL: srv.URL, HTTP: srv.Client()}
	err := c.Fetch("o/k3s", "v1-k3s1", "k3s-arm64", filepath.Join(t.TempDir(), "x"), 0o755)
	if err == nil || !strings.Contains(err.Error(), "no file") {
		t.Fatalf("expected missing-file error, got %v", err)
	}
}
