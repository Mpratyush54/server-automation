// Package verify checks cosign signatures on platform images before install
// or update. The Verifier interface is injectable so unit tests never need
// network access or a real cosign binary.
package verify

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Sentinel errors returned by Verifier implementations.
var (
	ErrCosignMissing    = errors.New("cosign not installed")
	ErrMissingSignature = errors.New("no signature found")
	ErrInvalidSignature = errors.New("signature invalid")
	// ErrUnverifiable: verification could not run (registry, Sigstore or
	// network unreachable, offline install). Treated like a missing signature:
	// a warning by default, fatal only in ModeStrict.
	ErrUnverifiable = errors.New("signature could not be verified")
)

// Mode controls how missing signatures are treated.
type Mode string

const (
	// ModeWarn (default): missing signatures and a missing cosign binary are
	// reported but do not fail the install. Invalid signatures always fail.
	ModeWarn Mode = "warn"
	// ModeStrict: a missing signature is fatal. A missing cosign binary is
	// still a warning (operators may install offline without cosign).
	ModeStrict Mode = "strict"
)

// Certificate identity for keyless signatures produced by this repo's
// GitHub Actions workflows (must match the Kyverno verifyImages attestor).
const (
	CertificateIdentityRegexp = `https://github.com/Mpratyush54/server-automation/\.github/workflows/.*`
	CertificateOIDCIssuer     = "https://token.actions.githubusercontent.com"
)

// ModeFromEnv reads PLATFORM_VERIFY_IMAGES (strict|warn|empty).
func ModeFromEnv() Mode {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("PLATFORM_VERIFY_IMAGES"))) {
	case "strict", "1", "true", "yes":
		return ModeStrict
	default:
		return ModeWarn
	}
}

// Verifier checks one image reference for a valid cosign signature.
type Verifier interface {
	Verify(ctx context.Context, image string) error
}

// CosignVerifier shells out to the cosign CLI (keyless verify).
type CosignVerifier struct {
	// LookPath finds an executable on PATH. Defaults to exec.LookPath.
	LookPath func(file string) (string, error)
	// Command builds the cosign process. Defaults to exec.CommandContext.
	Command func(ctx context.Context, name string, arg ...string) *exec.Cmd
}

func (v CosignVerifier) lookPath() func(string) (string, error) {
	if v.LookPath != nil {
		return v.LookPath
	}
	return exec.LookPath
}

func (v CosignVerifier) command() func(context.Context, string, ...string) *exec.Cmd {
	if v.Command != nil {
		return v.Command
	}
	return exec.CommandContext
}

// Verify runs `cosign verify` with this repo's workflow identity.
func (v CosignVerifier) Verify(ctx context.Context, image string) error {
	image = strings.TrimSpace(image)
	if image == "" {
		return fmt.Errorf("empty image reference")
	}
	bin, err := v.lookPath()("cosign")
	if err != nil {
		return ErrCosignMissing
	}
	cmd := v.command()(ctx, bin,
		"verify",
		"--certificate-identity-regexp", CertificateIdentityRegexp,
		"--certificate-oidc-issuer", CertificateOIDCIssuer,
		image,
	)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return classify(out.String(), err)
	}
	return nil
}

// classify maps cosign's output to a sentinel. Only a signature that was
// found and failed verification is ErrInvalidSignature (always fatal);
// anything that prevented verification is ErrUnverifiable, so a Sigstore or
// registry outage never blocks an install in the default mode.
func classify(output string, runErr error) error {
	msg := strings.ToLower(output)
	detail := strings.TrimSpace(output)
	if detail == "" {
		detail = runErr.Error()
	}
	switch {
	case strings.Contains(msg, "no matching signatures"),
		strings.Contains(msg, "no signatures found"):
		return ErrMissingSignature
	case strings.Contains(msg, "none of the expected identities matched"),
		strings.Contains(msg, "expected oidc issuer"),
		strings.Contains(msg, "invalid signature"),
		strings.Contains(msg, "mismatch"),
		strings.Contains(msg, "failed to verify signature"),
		strings.Contains(msg, "certificate identity"):
		return fmt.Errorf("%w: %s", ErrInvalidSignature, detail)
	default:
		return fmt.Errorf("%w: %s", ErrUnverifiable, detail)
	}
}

// Result is one image's verification outcome for logging.
type Result struct {
	Image  string
	Status string // verified | missing | unverifiable | invalid | skipped
	Err    error
}

// Check verifies every image. Invalid signatures always fail. Missing
// signatures fail only in ModeStrict. ErrCosignMissing is always a soft skip.
func Check(ctx context.Context, v Verifier, mode Mode, images []string) ([]Result, error) {
	if v == nil {
		v = CosignVerifier{}
	}
	if mode == "" {
		mode = ModeWarn
	}
	var (
		out  []Result
		errs []error
	)
	for _, img := range images {
		img = strings.TrimSpace(img)
		if img == "" {
			continue
		}
		err := v.Verify(ctx, img)
		r := Result{Image: img, Err: err}
		switch {
		case err == nil:
			r.Status = "verified"
		case errors.Is(err, ErrCosignMissing):
			r.Status = "skipped"
		case errors.Is(err, ErrMissingSignature), errors.Is(err, ErrUnverifiable):
			r.Status = "missing"
			if errors.Is(err, ErrUnverifiable) {
				r.Status = "unverifiable"
			}
			if mode == ModeStrict {
				errs = append(errs, fmt.Errorf("%s: %w", img, err))
			}
		default:
			r.Status = "invalid"
			errs = append(errs, fmt.Errorf("%s: %w", img, err))
		}
		out = append(out, r)
	}
	return out, errors.Join(errs...)
}

// PlatformImages returns the API and portal image refs for a registry/tag.
func PlatformImages(registry, tag string) []string {
	registry = strings.TrimRight(strings.TrimSpace(registry), "/")
	tag = strings.TrimSpace(tag)
	if registry == "" || tag == "" {
		return nil
	}
	return []string{
		registry + "/platform-api:" + tag,
		registry + "/platform-portal:" + tag,
	}
}
