package config

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// PostgreSQL replication on the ha profile (POSTGRES_REPLICATION).
const (
	// PostgresReplicationSync makes every commit wait for one standby, so a
	// server failure loses no acknowledged write. Writes pause until failover
	// finishes when the primary's server fails.
	PostgresReplicationSync = "sync"
	// PostgresReplicationAsync commits on the primary alone: writes do not
	// wait for a standby, but the last acknowledged writes can be lost when
	// the primary's server fails. Failover is not faster than with sync.
	PostgresReplicationAsync = "async"
)

// PostgresReplicationDocsURL explains the choice in plain language.
const PostgresReplicationDocsURL = "https://cairnpaas.dev/docs/operations/postgres-replication"

// NormalizePostgresReplication lower-cases and trims a mode; empty means sync.
func NormalizePostgresReplication(mode string) string {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		return PostgresReplicationSync
	}
	return mode
}

// ValidatePostgresReplicationMode accepts sync or async (after normalizing).
func ValidatePostgresReplicationMode(mode string) error {
	switch NormalizePostgresReplication(mode) {
	case PostgresReplicationSync, PostgresReplicationAsync:
		return nil
	}
	return fmt.Errorf("POSTGRES_REPLICATION must be sync or async, not %q (see %s)", strings.TrimSpace(mode), PostgresReplicationDocsURL)
}

// ValidatePostgresReplication checks POSTGRES_REPLICATION. It only matters on
// the ha profile, but a typo is rejected on every profile.
func (c *Config) ValidatePostgresReplication() error {
	return ValidatePostgresReplicationMode(c.PostgresReplication)
}

// PostgresReplicationChosen reports whether POSTGRES_REPLICATION was set in
// the environment or the saved .env (so provision does not ask again).
func (c *Config) PostgresReplicationChosen() bool { return c.postgresReplicationChosen }

func (c *Config) loadPostgresReplication() {
	raw := os.Getenv("POSTGRES_REPLICATION")
	c.postgresReplicationChosen = strings.TrimSpace(raw) != ""
	c.PostgresReplication = NormalizePostgresReplication(raw)
}

// PostgresReplicationChoices is the explanation shown before the question
// and by `platformctl postgres replication show`.
func PostgresReplicationChoices(w io.Writer) {
	fmt.Fprintln(w, "    sync  (default) Every write is copied to a second server before it is confirmed.")
	fmt.Fprintln(w, "                    No confirmed write is lost if a server dies. Writes pause during failover:")
	fmt.Fprintln(w, "                    about 1 minute when a server is lost.")
	fmt.Fprintln(w, "    async           Writes are confirmed right away and copied a moment later.")
	fmt.Fprintln(w, "                    Failover also takes about 1 minute when a server is lost, and the")
	fmt.Fprintln(w, "                    last writes confirmed before the failure can be lost.")
	fmt.Fprintf(w, "    Which one to pick: %s\n", PostgresReplicationDocsURL)
}

// PromptPostgresReplication asks for the replication mode (ha profile). Enter
// keeps the current value. It reads one line without buffering past it, so
// later prompts on the same input still see their answers.
func (c *Config) PromptPostgresReplication(in io.Reader, out io.Writer) {
	cur := NormalizePostgresReplication(c.PostgresReplication)
	if ValidatePostgresReplicationMode(cur) != nil {
		cur = PostgresReplicationSync
	}
	fmt.Fprintln(out, "\n  ■ PostgreSQL replication")
	fmt.Fprintln(out, "    The database keeps a copy on each of the three servers. Choose how writes are copied:")
	PostgresReplicationChoices(out)
	for attempt := 0; attempt < 3; attempt++ {
		fmt.Fprintf(out, "  ? Replication mode (sync/async) [%s]: ", cur)
		answer, err := readLine(in)
		answer = strings.ToLower(strings.TrimSpace(answer))
		if answer == "" {
			c.PostgresReplication = cur
			return
		}
		if ValidatePostgresReplicationMode(answer) == nil {
			c.PostgresReplication = answer
			return
		}
		fmt.Fprintln(out, "    Please type sync or async.")
		if err != nil {
			break
		}
	}
	c.PostgresReplication = cur
}

// readLine reads up to a newline one byte at a time (no read-ahead).
func readLine(in io.Reader) (string, error) {
	var b strings.Builder
	buf := make([]byte, 1)
	for {
		n, err := in.Read(buf)
		if n == 1 {
			if buf[0] == '\n' {
				return strings.TrimSuffix(b.String(), "\r"), nil
			}
			b.WriteByte(buf[0])
		}
		if err != nil {
			return b.String(), err
		}
	}
}
