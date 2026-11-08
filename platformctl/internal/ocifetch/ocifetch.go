// Package ocifetch downloads single files from public OCI artifacts (as pushed
// by `oras push <ref> file:type`) with anonymous registry tokens.
//
// It is the GitHub-Releases-outage fallback for the k3s binary and install
// script mirrored on GHCR (see versions.K3sMirror). Every blob is verified
// against its content digest before it is written.
package ocifetch

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// TitleAnnotation names a layer's file in oras artifacts.
const TitleAnnotation = "org.opencontainers.image.title"

// Client fetches from one registry. BaseURL is "https://ghcr.io" in production.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

// New returns a client for an image reference's registry host (e.g. "ghcr.io").
func New(host string) *Client {
	return &Client{BaseURL: "https://" + host, HTTP: &http.Client{Timeout: 10 * time.Minute}}
}

type manifest struct {
	Layers []struct {
		Digest      string            `json:"digest"`
		Size        int64             `json:"size"`
		Annotations map[string]string `json:"annotations"`
	} `json:"layers"`
}

func (c *Client) token(repo string) (string, error) {
	u := fmt.Sprintf("%s/token?scope=%s", c.BaseURL, url.QueryEscape("repository:"+repo+":pull"))
	resp, err := c.HTTP.Get(u)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry token: HTTP %d", resp.StatusCode)
	}
	var t struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&t); err != nil || t.Token == "" {
		return "", fmt.Errorf("registry token: invalid response")
	}
	return t.Token, nil
}

func (c *Client) get(path, token, accept string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("GET %s: HTTP %d", path, resp.StatusCode)
	}
	return resp, nil
}

// Fetch writes the layer titled `file` of `repo:tag` to dst (mode perm),
// verifying its sha256 digest. dst is replaced atomically.
func (c *Client) Fetch(repo, tag, file, dst string, perm os.FileMode) error {
	token, err := c.token(repo)
	if err != nil {
		return err
	}
	resp, err := c.get(fmt.Sprintf("/v2/%s/manifests/%s", repo, tag), token,
		"application/vnd.oci.image.manifest.v1+json")
	if err != nil {
		return err
	}
	var m manifest
	err = json.NewDecoder(resp.Body).Decode(&m)
	resp.Body.Close()
	if err != nil {
		return fmt.Errorf("manifest %s:%s: %w", repo, tag, err)
	}
	digest := ""
	for _, l := range m.Layers {
		if l.Annotations[TitleAnnotation] == file {
			digest = l.Digest
			break
		}
	}
	if !strings.HasPrefix(digest, "sha256:") {
		return fmt.Errorf("%s:%s has no file %q", repo, tag, file)
	}
	blob, err := c.get(fmt.Sprintf("/v2/%s/blobs/%s", repo, digest), token, "")
	if err != nil {
		return err
	}
	defer blob.Body.Close()

	tmp, err := os.CreateTemp(filepath.Dir(dst), ".ocifetch-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), blob.Body); err != nil {
		tmp.Close()
		return fmt.Errorf("download %s: %w", file, err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if got := "sha256:" + hex.EncodeToString(h.Sum(nil)); got != digest {
		return fmt.Errorf("%s: digest mismatch (got %s, want %s)", file, got, digest)
	}
	if err := os.Chmod(tmp.Name(), perm); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}
