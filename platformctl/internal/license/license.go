// Package license runs the license client and reads its result.
package license

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
)

const (
	BinaryPath  = "/usr/local/lib/cairn/cairn-license"
	LicenseFile = "/etc/platform/license.json"
	StatusFile  = "/etc/platform/license-status.json"

	EnvClient  = "PLATFORM_LICENSE_CLIENT"
	EnvEnforce = "PLATFORM_LICENSE_ENFORCE"
	EnvKey     = "CAIRN_LICENSE_KEY"

	SignupURL  = "https://cairnpaas.dev/signup"
	AccountURL = "https://cairnpaas.dev/account"
	PricingURL = "https://cairnpaas.dev/pricing#enterprise"
)

// Report is the client's JSON output.
type Report struct {
	Command        string `json:"command"`
	Status         string `json:"status"`
	ExitCode       int    `json:"exit_code"`
	AllowProvision bool   `json:"allow_provision"`
	Reason         string `json:"reason,omitempty"`
	ErrorCode      string `json:"error_code,omitempty"`
	File           string `json:"file,omitempty"`
	Type           string `json:"type,omitempty"`
	InstallID      string `json:"install_id,omitempty"`
	Plan           string `json:"plan,omitempty"`
	Org            string `json:"org,omitempty"`
	MaxNodes       *int   `json:"max_nodes,omitempty"`
	MaxInstalls    *int   `json:"max_installs,omitempty"`
	IssuedAt       string `json:"issued_at,omitempty"`
	ExpiresAt      string `json:"expires_at,omitempty"`
}

// Params are passed to the client.
type Params struct {
	Version string
	Profile string
	Nodes   int
}

func (f Params) args() []string {
	n := f.Nodes
	if n < 1 {
		n = 1
	}
	v := f.Version
	if v == "" {
		v = "dev"
	}
	p := f.Profile
	if p == "" {
		p = "standard"
	}
	return []string{"--version", v, "--profile", p, "--nodes", strconv.Itoa(n)}
}

// Key is a license key given as a file or a value.
type Key struct {
	File  string
	Value string
}

// Empty reports whether no key was given.
func (k Key) Empty() bool { return k.File == "" && strings.TrimSpace(k.Value) == "" }

// Runner executes the client and returns stdout, stderr and the exit code.
type Runner func(ctx context.Context, path string, args []string, stdin string) (stdout, stderr []byte, exit int, err error)

// Client runs the license client binary at Path.
type Client struct {
	Path string
	Run  Runner
}

func execRunner(ctx context.Context, path string, args []string, stdin string) ([]byte, []byte, int, error) {
	c := exec.CommandContext(ctx, path, args...)
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	if stdin != "" {
		c.Stdin = strings.NewReader(stdin)
	}
	err := c.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.Bytes(), errb.Bytes(), ee.ExitCode(), nil
	}
	if err != nil {
		return nil, errb.Bytes(), -1, err
	}
	return out.Bytes(), errb.Bytes(), 0, nil
}

func (c *Client) run(ctx context.Context, args []string, stdin string) ([]byte, []byte, int, error) {
	r := c.Run
	if r == nil {
		r = execRunner
	}
	return r(ctx, c.Path, args, stdin)
}

func (c *Client) report(ctx context.Context, args []string, stdin string) (Report, error) {
	out, errb, code, err := c.run(ctx, args, stdin)
	if err != nil {
		return Report{}, fmt.Errorf("run license client: %w", err)
	}
	var r Report
	if jerr := json.Unmarshal(bytes.TrimSpace(out), &r); jerr != nil {
		r = Report{Command: args[0], Status: "error", Reason: strings.TrimSpace(string(errb))}
	}
	r.ExitCode = code
	r.AllowProvision = code == ExitValid || code == ExitAttention
	if r.Command == "" {
		r.Command = args[0]
	}
	return r, nil
}

// Activate runs `activate`.
func (c *Client) Activate(ctx context.Context, fp Params, key Key) (Report, error) {
	args := append([]string{"activate"}, fp.args()...)
	stdin := ""
	if key.File != "" {
		args = append(args, "--key-file", key.File)
	} else {
		args = append(args, "--key", "-")
		stdin = strings.TrimSpace(key.Value) + "\n"
	}
	return c.report(ctx, args, stdin)
}

// Verify runs `verify`; nodes <= 0 omits --nodes.
func (c *Client) Verify(ctx context.Context, nodes int) (Report, error) {
	args := []string{"verify"}
	if nodes > 0 {
		args = append(args, "--nodes", strconv.Itoa(nodes))
	}
	return c.report(ctx, args, "")
}

// Refresh runs the client's refresh command.
func (c *Client) Refresh(ctx context.Context, fp Params) (Report, error) {
	return c.report(ctx, append([]string{"checkin"}, fp.args()...), "")
}

// RequestOffline runs `request-offline` and returns its output.
func (c *Client) RequestOffline(ctx context.Context, fp Params) (string, error) {
	out, errb, code, err := c.run(ctx, append([]string{"request-offline"}, fp.args()...), "")
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("license client exited %d: %s", code, strings.TrimSpace(string(errb)))
	}
	return strings.TrimSpace(string(out)), nil
}

// InstallOffline runs `install-offline`.
func (c *Client) InstallOffline(ctx context.Context, file string) (Report, error) {
	return c.report(ctx, []string{"install-offline", "--file", file}, "")
}

// Upgrade activates when a key is given, otherwise (or when the server is
// unreachable) verifies.
func (c *Client) Upgrade(ctx context.Context, fp Params, key Key) (Report, error) {
	if !key.Empty() {
		r, err := c.Activate(ctx, fp, key)
		if err != nil || r.ExitCode != ExitError {
			return r, err
		}
	}
	return c.Verify(ctx, fp.Nodes)
}

// Exit codes.
const (
	ExitValid     = 0
	ExitError     = 1
	ExitUsage     = 2
	ExitAttention = 10
	ExitInvalid   = 20
	ExitLimit     = 21
	ExitMissing   = 30
)

var messages = map[int]string{
	ExitValid:     "license valid",
	ExitAttention: "license needs attention; see " + AccountURL,
	ExitInvalid:   "license not valid%s; see " + AccountURL,
	ExitLimit:     "license node limit reached%s; see " + PricingURL,
	ExitMissing:   "no license key; get one at " + SignupURL + " and pass --license-key-file or " + EnvKey,
	ExitError:     "license server unreachable%s; retry later",
	ExitUsage:     "license client usage error%s",
}

// Decision says whether an operation may continue.
type Decision struct {
	Proceed bool
	Warn    bool
	Message string
}

// Decide maps a report to a decision. Without enforce it always proceeds.
func Decide(r Report, enforce bool) Decision {
	msg, ok := messages[r.ExitCode]
	if !ok {
		msg = "license check failed (exit " + strconv.Itoa(r.ExitCode) + ")%s"
	}
	detail := ""
	if r.Reason != "" {
		detail = ": " + r.Reason
	}
	switch r.ExitCode {
	case ExitValid:
	case ExitAttention, ExitMissing:
	default:
		msg = fmt.Sprintf(msg, detail)
	}
	d := Decision{Proceed: r.AllowProvision, Warn: r.ExitCode != ExitValid, Message: msg}
	if !enforce && !d.Proceed {
		d.Proceed = true
		d.Message += " (" + EnvEnforce + "=false, continuing)"
	}
	return d
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// ParseStatus reads a status file written by WriteStatus.
func ParseStatus(r io.Reader) (Status, error) {
	var s Status
	err := json.NewDecoder(r).Decode(&s)
	return s, err
}

// RegistryCredentials is the output of `registry-credentials`.
type RegistryCredentials struct {
	Registry string `json:"registry"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// RegistryCredentials runs `registry-credentials`. Errors never include the output.
func (c *Client) RegistryCredentials(ctx context.Context) (RegistryCredentials, error) {
	out, _, code, err := c.run(ctx, []string{"registry-credentials"}, "")
	if err != nil {
		return RegistryCredentials{}, fmt.Errorf("run license client: %w", err)
	}
	if code != 0 {
		return RegistryCredentials{}, fmt.Errorf("registry-credentials exited %d", code)
	}
	var rc RegistryCredentials
	if json.Unmarshal(bytes.TrimSpace(out), &rc) != nil || rc.Registry == "" || rc.Username == "" || rc.Password == "" {
		return RegistryCredentials{}, errors.New("registry-credentials returned no credentials")
	}
	return rc, nil
}
