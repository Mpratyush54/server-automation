package cmd

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
)

func TestRunRestoreTestReportsSuccess(t *testing.T) {
	oldTest, oldPublish := restoreTestPostgres, publishRestoreStatus
	t.Cleanup(func() { restoreTestPostgres, publishRestoreStatus = oldTest, oldPublish })
	var published []error
	var bytes []int64
	publishRestoreStatus = func(kind, id string, _ time.Time, m backup.Manifest, e error) error {
		var n int64
		for _, a := range m.Artifacts {
			n += a.Bytes
		}
		bytes = append(bytes, n)
		if kind != "restore-test" || id != "20261115T030000Z" {
			t.Fatalf("published %s %s", kind, id)
		}
		published = append(published, e)
		return nil
	}
	restoreTestPostgres = func(string, string, []byte) (backup.Manifest, error) {
		return backup.Manifest{Artifacts: []backup.Artifact{{Component: "postgres", Bytes: 4096}}}, nil
	}
	var out strings.Builder
	if err := runRestoreTest(&out, "s3://x/y", "20261115T030000Z", []byte("AGE-SECRET-KEY-notreal")); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	if !strings.Contains(s, "Restore test passed: backup 20261115T030000Z") || !strings.Contains(s, "PostgreSQL") || !strings.Contains(s, " in 0s.") || strings.Contains(s, "notreal") {
		t.Fatalf("success output: %q", s)
	}

	// A failure prints no success line and is still published.
	boom := errors.New("pg_restore failed")
	restoreTestPostgres = func(string, string, []byte) (backup.Manifest, error) { return backup.Manifest{}, boom }
	out.Reset()
	if err := runRestoreTest(&out, "s3://x/y", "20261115T030000Z", nil); !errors.Is(err, boom) || out.Len() != 0 {
		t.Fatalf("failure: err=%v out=%q", err, out.String())
	}
	if len(published) != 2 || published[0] != nil || !errors.Is(published[1], boom) {
		t.Fatalf("published %v", published)
	}
	// The restore-test status carries the size of what was restored, not 0 B.
	if bytes[0] != 4096 {
		t.Fatalf("published size %d, want 4096", bytes[0])
	}
}
