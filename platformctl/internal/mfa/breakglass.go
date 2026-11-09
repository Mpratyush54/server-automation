// Package mfa holds operator break-glass actions for portal MFA (#24). They work without the
// platform API: SQL runs through psql inside the PostgreSQL pod, with the database password read
// inside the container (never placed in command arguments or logs).
package mfa

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Runner executes name with args, feeding stdin, and returns stdout. Injected in tests.
type Runner func(stdin, name string, args ...string) (string, error)

// ExecRunner runs a real command (stderr goes to the terminal).
func ExecRunner(stdin, name string, args ...string) (string, error) {
	c := exec.Command(name, args...)
	c.Stdin = strings.NewReader(stdin)
	var out bytes.Buffer
	c.Stdout = &out
	c.Stderr = os.Stderr
	err := c.Run()
	return out.String(), err
}

const (
	// DatabaseNamespace is where the bundled PostgreSQL runs.
	DatabaseNamespace = "databases"
	// DefaultDatabase is the platform database name when platform-env has no POSTGRES_DB.
	DefaultDatabase = "platform"
	auditAction     = "auth.mfa.break_glass_disable"
)

// pwHelper reads a Bitnami password from VAR or VAR_FILE inside the container (as internal/backup).
const pwHelper = `pw() { local v="${!1:-}" f="${1}_FILE"; if [ -z "$v" ] && [ -n "${!f:-}" ]; then v=$(cat "${!f}"); fi; printf "%s" "$v"; }`

// InPodScript runs in the PostgreSQL container. Database, email and host arrive as positional
// parameters and reach psql as variables, so they are never interpolated into shell source.
const InPodScript = pwHelper + `
export PGPASSWORD="$(pw POSTGRES_PASSWORD)"
exec psql -U postgres -d "$1" -X -q -At -v ON_ERROR_STOP=1 -v email="$2" -v host="$3" -f -
`

// DisableSQL removes the user's TOTP factor and recovery codes and writes an audit log row, in
// one transaction. psql quotes :'email' / :'host' as SQL literals.
const DisableSQL = `BEGIN;
CREATE TEMP TABLE platformctl_mfa_target ON COMMIT DROP AS
  SELECT id FROM users WHERE lower(email) = lower(:'email');
DO $$
BEGIN
  IF (SELECT count(*) FROM platformctl_mfa_target) <> 1 THEN
    RAISE EXCEPTION 'platformctl: no user with that email';
  END IF;
END $$;
DELETE FROM mfa_recovery_codes WHERE user_id IN (SELECT id FROM platformctl_mfa_target);
WITH removed AS (
  DELETE FROM user_mfa WHERE user_id IN (SELECT id FROM platformctl_mfa_target) RETURNING user_id
)
SELECT 'removed=' || count(*) FROM removed;
INSERT INTO audit_logs (user_id, action, target_type, target_id, metadata)
  SELECT NULL, '` + auditAction + `', 'User', id,
         jsonb_build_object('email', :'email', 'via', 'platformctl mfa disable', 'host', :'host')
  FROM platformctl_mfa_target;
COMMIT;
`

var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+$`)

// ValidateEmail rejects values that cannot be a user email (length, control characters).
func ValidateEmail(email string) error {
	if email == "" || len(email) > 200 || !emailRe.MatchString(email) {
		return errors.New("--user must be the user's email address")
	}
	for _, r := range email {
		if unicode.IsControl(r) {
			return errors.New("--user contains control characters")
		}
	}
	return nil
}

// BreakGlass disables MFA for a user directly in the platform database.
type BreakGlass struct {
	Run Runner
	// Database overrides the platform database name (default: POSTGRES_DB from platform-env).
	Database string
	// Host is recorded in the audit entry.
	Host string
}

// Result of a disable.
type Result struct {
	Database string
	// Removed is true when the user had an MFA factor (enrolled or pending).
	Removed bool
}

// PodArgs locates the PostgreSQL pod.
func PodArgs() []string {
	return []string{"-n", DatabaseNamespace, "get", "pods", "-l", "app.kubernetes.io/instance=postgresql",
		"-o", "jsonpath={.items[0].metadata.name}"}
}

// DatabaseArgs reads POSTGRES_DB from the platform-env Secret.
func DatabaseArgs() []string {
	return []string{"-n", "platform", "get", "secret", "platform-env", "-o", "jsonpath={.data.POSTGRES_DB}"}
}

// ExecArgs runs InPodScript in the pod with the values as positional parameters.
func ExecArgs(pod, database, email, host string) []string {
	return []string{"-n", DatabaseNamespace, "exec", "-i", pod, "--",
		"bash", "-ec", InPodScript, "platformctl-mfa", database, email, host}
}

func (b BreakGlass) database() string {
	if b.Database != "" {
		return b.Database
	}
	out, err := b.Run("", "kubectl", DatabaseArgs()...)
	if err != nil {
		return DefaultDatabase
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(out))
	if err != nil || strings.TrimSpace(string(raw)) == "" {
		return DefaultDatabase
	}
	return strings.TrimSpace(string(raw))
}

// Disable removes the factor and recovery codes of the user with this email and audit-logs it.
func (b BreakGlass) Disable(email string) (Result, error) {
	email = strings.TrimSpace(email)
	if err := ValidateEmail(email); err != nil {
		return Result{}, err
	}
	if b.Run == nil {
		b.Run = ExecRunner
	}
	pod, err := b.Run("", "kubectl", PodArgs()...)
	pod = strings.TrimSpace(pod)
	if err != nil || pod == "" {
		return Result{}, fmt.Errorf("PostgreSQL pod not found in namespace %s (is the platform installed and kubectl configured?)", DatabaseNamespace)
	}
	db := b.database()
	out, err := b.Run(DisableSQL, "kubectl", ExecArgs(pod, db, email, b.Host)...)
	if err != nil {
		return Result{Database: db}, fmt.Errorf("disabling MFA failed (unknown email, or the database has no MFA tables yet?): %w", err)
	}
	removed, perr := parseRemoved(out)
	if perr != nil {
		return Result{Database: db}, perr
	}
	return Result{Database: db, Removed: removed > 0}, nil
}

func parseRemoved(out string) (int, error) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "removed=") {
			return strconv.Atoi(strings.TrimPrefix(line, "removed="))
		}
	}
	return 0, fmt.Errorf("unexpected psql output: %q", strings.TrimSpace(out))
}
