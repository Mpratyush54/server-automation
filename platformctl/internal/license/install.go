package license

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

// ErrNotPinned means no client release is pinned and no local client was given.
var ErrNotPinned = errors.New("no license client release is pinned in this build; set " + EnvClient + "=/path/to/cairn-license")

// Installer downloads, verifies and installs the license client.
type Installer struct {
	Version  string
	SHA256   map[string]string
	BaseURL  string
	Arch     string
	Dest     string
	Override string
	Staged   string
	HTTP     *http.Client
	// Cosign verifies the release signature; nil skips it.
	Cosign func(ctx context.Context, sums, sig, cert string) error
}

// DefaultInstaller uses the pinned release and the environment.
func DefaultInstaller(staged string) Installer {
	in := Installer{
		Version:  versions.LicenseClientVersion,
		SHA256:   versions.LicenseClientSHA256,
		BaseURL:  versions.LicenseClientBaseURL,
		Arch:     runtime.GOARCH,
		Dest:     BinaryPath,
		Override: strings.TrimSpace(os.Getenv(EnvClient)),
		Staged:   staged,
		HTTP:     &http.Client{Timeout: 2 * time.Minute},
	}
	if path, err := exec.LookPath("cosign"); err == nil {
		in.Cosign = func(ctx context.Context, sums, sig, cert string) error {
			out, err := exec.CommandContext(ctx, path, "verify-blob",
				"--certificate", cert, "--signature", sig,
				"--certificate-identity-regexp", versions.LicenseClientCosignIdentityRegexp,
				"--certificate-oidc-issuer", versions.LicenseClientCosignIssuer, sums).CombinedOutput()
			if err != nil {
				return fmt.Errorf("cosign verify-blob: %w: %s", err, strings.TrimSpace(string(out)))
			}
			return nil
		}
	}
	return in
}

// Locate returns an installed client without downloading.
func (in Installer) Locate() (string, bool) {
	if in.Override != "" {
		if regular(in.Override) {
			return in.Override, true
		}
		return "", false
	}
	if regular(in.Dest) {
		return in.Dest, true
	}
	return "", false
}

// Ensure installs the client at Dest and returns its path.
func (in Installer) Ensure(ctx context.Context) (string, error) {
	if in.Override != "" {
		if !filepath.IsAbs(in.Override) || !regular(in.Override) {
			return "", fmt.Errorf("%s=%s: not an existing file", EnvClient, in.Override)
		}
		if filepath.Clean(in.Override) == filepath.Clean(in.Dest) {
			return in.Dest, nil
		}
		f, err := os.Open(in.Override)
		if err != nil {
			return "", err
		}
		defer f.Close()
		if _, err := install(in.Dest, f); err != nil {
			return "", err
		}
		return in.Dest, nil
	}
	if in.Version == "" {
		return "", ErrNotPinned
	}
	want := strings.ToLower(in.SHA256[in.Arch])
	if want == "" {
		return "", fmt.Errorf("no license client checksum pinned for %s", in.Arch)
	}
	if sum, err := fileSHA256(in.Dest); err == nil && sum == want {
		return in.Dest, nil
	}
	if in.Staged != "" {
		if sum, err := fileSHA256(in.Staged); err == nil && sum == want {
			f, err := os.Open(in.Staged)
			if err != nil {
				return "", err
			}
			defer f.Close()
			if _, err := install(in.Dest, f); err != nil {
				return "", err
			}
			return in.Dest, nil
		}
	}
	return in.Dest, in.download(ctx, want)
}

func (in Installer) url(file string) string {
	return strings.TrimRight(in.BaseURL, "/") + "/" + in.Version + "/" + file
}

func (in Installer) download(ctx context.Context, want string) error {
	if !strings.HasPrefix(in.BaseURL, "https://") {
		return fmt.Errorf("license client URL must be https: %s", in.BaseURL)
	}
	name := versions.LicenseClientFile(in.Arch)
	if in.Cosign != nil {
		if err := in.verifySignature(ctx, name, want); err != nil {
			return err
		}
	}
	body, err := in.get(ctx, in.url(name))
	if err != nil {
		return err
	}
	defer body.Close()
	tmp, err := os.MkdirTemp("", "cairn-license-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	staged := filepath.Join(tmp, name)
	sum, err := install(staged, body)
	if err != nil {
		return err
	}
	if sum != want {
		return fmt.Errorf("license client checksum mismatch: got %s, want %s", sum, want)
	}
	f, err := os.Open(staged)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = install(in.Dest, f)
	return err
}

func (in Installer) verifySignature(ctx context.Context, name, want string) error {
	dir, err := os.MkdirTemp("", "cairn-license-sig-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	paths := map[string]string{}
	for _, f := range []string{versions.LicenseClientSumsFile, versions.LicenseClientSigFile, versions.LicenseClientCertFile} {
		body, err := in.get(ctx, in.url(f))
		if err != nil {
			return err
		}
		p := filepath.Join(dir, f)
		out, err := os.Create(p)
		if err == nil {
			_, err = io.Copy(out, io.LimitReader(body, 1<<20))
			out.Close()
		}
		body.Close()
		if err != nil {
			return err
		}
		paths[f] = p
	}
	sums := paths[versions.LicenseClientSumsFile]
	if err := in.Cosign(ctx, sums, paths[versions.LicenseClientSigFile], paths[versions.LicenseClientCertFile]); err != nil {
		return err
	}
	got, err := sumFor(sums, name)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("signed %s lists %s for %s, pinned %s", versions.LicenseClientSumsFile, got, name, want)
	}
	return nil
}

func (in Installer) get(ctx context.Context, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := in.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", url, err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}
	return resp.Body, nil
}

func sumFor(path, name string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("%s not listed in %s", name, filepath.Base(path))
}

// install writes r to dest atomically with mode 0755 and returns its SHA-256.
func install(dest string, r io.Reader) (string, error) {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".cairn-license-*")
	if err != nil {
		return "", err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(tmp, h), io.LimitReader(r, 256<<20))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), 0o755)
	}
	if err == nil {
		err = os.Rename(tmp.Name(), dest)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func regular(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
}
