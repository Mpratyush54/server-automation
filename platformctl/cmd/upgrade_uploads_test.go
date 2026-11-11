package cmd

import (
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

func TestBackupContainerUploadsArchivesEachPod(t *testing.T) {
	oldRun, oldArchive := upgradeRun, uploadsArchive
	defer func() { upgradeRun, uploadsArchive = oldRun, oldArchive }()
	upgradeRun = func(string, ...string) (string, error) { return "api-a api-b api-c", nil }
	uploadsArchive = func(pod string, w io.Writer) error {
		switch pod {
		case "api-a":
			_, err := w.Write([]byte("tar-bytes"))
			return err
		case "api-b":
			return errNoUploads
		}
		return errors.New("exec refused")
	}
	var out bytes.Buffer
	got := backupContainerUploads(&out, t.TempDir())
	if len(got) != 1 || !strings.HasSuffix(got[0], "api-a.tar") {
		t.Fatalf("archives = %v", got)
	}
	if b, _ := os.ReadFile(got[0]); string(b) != "tar-bytes" {
		t.Fatal("archive content")
	}
	if !strings.Contains(out.String(), "api-c") || strings.Contains(out.String(), "api-b:") {
		t.Fatalf("output: %s", out.String())
	}
}

func TestBackupContainerUploadsNothingToDo(t *testing.T) {
	oldRun, oldArchive := upgradeRun, uploadsArchive
	defer func() { upgradeRun, uploadsArchive = oldRun, oldArchive }()
	upgradeRun = func(string, ...string) (string, error) { return "api-a", nil }
	uploadsArchive = func(string, io.Writer) error { return errNoUploads }
	var out bytes.Buffer
	if got := backupContainerUploads(&out, t.TempDir()); len(got) != 0 || out.Len() != 0 {
		t.Fatalf("%v %q", got, out.String())
	}
}
