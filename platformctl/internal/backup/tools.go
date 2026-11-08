package backup

import (
	"fmt"
	"os/exec"
	"sort"
	"strings"
)

// RequiredTools lists host binaries an operation needs. remote is true for an
// s3:// target (uploads go through mc). restore adds restore-only helpers.
func RequiredTools(components []string, remote, restore bool) []string {
	need := map[string]bool{"bash": true, "kubectl": true}
	if remote {
		need["mc"] = true
	}
	for _, c := range components {
		switch c {
		case "minio":
			need["mc"], need["jq"] = true, true
		case "config":
			if restore {
				need["jq"] = true
			}
		case "redis":
			if restore {
				need["jq"] = true
			}
		case "k3s":
			if !restore {
				need["sqlite3"] = true // only for the SQLite datastore; etcd uses k3s itself
			}
		}
	}
	var out []string
	for k := range need {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// lookPath is replaced in tests.
var lookPath = exec.LookPath

// CheckTools fails fast, before any capture or restore, naming every missing tool.
func CheckTools(tools []string) error {
	var missing []string
	for _, t := range tools {
		if _, e := lookPath(t); e != nil {
			missing = append(missing, t)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing required tools on PATH: %s (see docs/operations/backups.md#setup)", strings.Join(missing, ", "))
	}
	return nil
}
