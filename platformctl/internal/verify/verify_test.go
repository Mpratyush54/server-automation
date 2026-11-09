package verify

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
)

type fakeVerifier struct {
	res map[string]error
}

func (f fakeVerifier) Verify(_ context.Context, image string) error {
	if err, ok := f.res[image]; ok {
		return err
	}
	return nil
}

func TestCheckWarnMode(t *testing.T) {
	v := fakeVerifier{res: map[string]error{
		"reg/api:1":    nil,
		"reg/portal:1": ErrMissingSignature,
	}}
	results, err := Check(context.Background(), v, ModeWarn, []string{"reg/api:1", "reg/portal:1"})
	if err != nil {
		t.Fatalf("warn mode must ignore missing signatures: %v", err)
	}
	if len(results) != 2 || results[0].Status != "verified" || results[1].Status != "missing" {
		t.Fatalf("unexpected results: %+v", results)
	}
}

func TestCheckStrictMissingFails(t *testing.T) {
	v := fakeVerifier{res: map[string]error{
		"reg/api:1": ErrMissingSignature,
	}}
	_, err := Check(context.Background(), v, ModeStrict, []string{"reg/api:1"})
	if err == nil || !errors.Is(err, ErrMissingSignature) {
		t.Fatalf("strict mode should fail on missing signature, got %v", err)
	}
}

func TestCheckInvalidAlwaysFails(t *testing.T) {
	v := fakeVerifier{res: map[string]error{
		"reg/api:1": ErrInvalidSignature,
	}}
	for _, mode := range []Mode{ModeWarn, ModeStrict} {
		_, err := Check(context.Background(), v, mode, []string{"reg/api:1"})
		if err == nil || !errors.Is(err, ErrInvalidSignature) {
			t.Fatalf("mode %s: want invalid signature error, got %v", mode, err)
		}
	}
}

func TestCheckCosignMissingIsSoft(t *testing.T) {
	v := fakeVerifier{res: map[string]error{
		"reg/api:1": ErrCosignMissing,
	}}
	for _, mode := range []Mode{ModeWarn, ModeStrict} {
		results, err := Check(context.Background(), v, mode, []string{"reg/api:1"})
		if err != nil {
			t.Fatalf("mode %s: missing cosign must not fail: %v", mode, err)
		}
		if results[0].Status != "skipped" {
			t.Fatalf("mode %s: status=%s", mode, results[0].Status)
		}
	}
}

func TestPlatformImages(t *testing.T) {
	got := PlatformImages("ghcr.io/mpratyush54/", "1.2.3")
	want := []string{
		"ghcr.io/mpratyush54/platform-api:1.2.3",
		"ghcr.io/mpratyush54/platform-portal:1.2.3",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("got %v want %v", got, want)
	}
	if PlatformImages("", "x") != nil || PlatformImages("r", "") != nil {
		t.Fatal("empty registry/tag must yield nil")
	}
}

func TestModeFromEnv(t *testing.T) {
	t.Setenv("PLATFORM_VERIFY_IMAGES", "")
	if ModeFromEnv() != ModeWarn {
		t.Fatal("default warn")
	}
	t.Setenv("PLATFORM_VERIFY_IMAGES", "strict")
	if ModeFromEnv() != ModeStrict {
		t.Fatal("strict")
	}
}

func TestCosignVerifierMissingBinary(t *testing.T) {
	v := CosignVerifier{
		LookPath: func(string) (string, error) { return "", errors.New("not found") },
	}
	if err := v.Verify(context.Background(), "img:tag"); !errors.Is(err, ErrCosignMissing) {
		t.Fatalf("got %v", err)
	}
}

func TestCosignVerifierParsesMissingSignature(t *testing.T) {
	v := CosignVerifier{
		LookPath: func(string) (string, error) { return "cosign", nil },
		Command: func(ctx context.Context, name string, arg ...string) *exec.Cmd {
			// Simulate cosign stderr via a shell that prints and exits 1.
			return exec.CommandContext(ctx, "bash", "-c", `echo "Error: no matching signatures" >&2; exit 1`)
		},
	}
	if err := v.Verify(context.Background(), "img:tag"); !errors.Is(err, ErrMissingSignature) {
		t.Fatalf("got %v", err)
	}
}

func TestCosignVerifierParsesInvalid(t *testing.T) {
	v := CosignVerifier{
		LookPath: func(string) (string, error) { return "cosign", nil },
		Command: func(ctx context.Context, name string, arg ...string) *exec.Cmd {
			return exec.CommandContext(ctx, "bash", "-c", `echo "certificate subject mismatch" >&2; exit 1`)
		},
	}
	if err := v.Verify(context.Background(), "img:tag"); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("got %v", err)
	}
}

func TestCosignVerifierSuccess(t *testing.T) {
	v := CosignVerifier{
		LookPath: func(string) (string, error) { return "cosign", nil },
		Command: func(ctx context.Context, name string, arg ...string) *exec.Cmd {
			return exec.CommandContext(ctx, "bash", "-c", `echo verified; exit 0`)
		},
	}
	if err := v.Verify(context.Background(), "img:tag"); err != nil {
		t.Fatal(err)
	}
}

// A registry/Sigstore/network failure is not an invalid signature: it must
// not block a default install (only strict mode fails).
func TestUnverifiableIsSoftUnlessStrict(t *testing.T) {
	v := CosignVerifier{
		LookPath: func(string) (string, error) { return "cosign", nil },
		Command: func(ctx context.Context, name string, arg ...string) *exec.Cmd {
			return exec.CommandContext(ctx, "bash", "-c", `echo "Error: getting Rekor public keys: dial tcp: lookup tuf-repo-cdn.sigstore.dev: no such host" >&2; exit 1`)
		},
	}
	if err := v.Verify(context.Background(), "img:tag"); !errors.Is(err, ErrUnverifiable) {
		t.Fatalf("a network failure must be ErrUnverifiable, got %v", err)
	}
	res, err := Check(context.Background(), v, ModeWarn, []string{"reg/api:1"})
	if err != nil || len(res) != 1 || res[0].Status != "unverifiable" {
		t.Fatalf("warn mode must continue: res=%+v err=%v", res, err)
	}
	if _, err := Check(context.Background(), v, ModeStrict, []string{"reg/api:1"}); !errors.Is(err, ErrUnverifiable) {
		t.Fatalf("strict mode must fail, got %v", err)
	}
}

func TestIdentityMismatchIsInvalid(t *testing.T) {
	err := classify("Error: none of the expected identities matched what was in the certificate", errors.New("exit status 1"))
	if !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("got %v", err)
	}
}
