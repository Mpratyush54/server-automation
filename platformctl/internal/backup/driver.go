package backup

import (
	_ "embed"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

//go:embed common.sh
var commonScript string

//go:embed capture.sh
var captureScript string

//go:embed restore.sh
var restoreScript string

// HostDriver runs only on the k3s server. Secrets are read inside the database
// containers, not placed in command arguments or printed in command logs.
//
// Quiet captures the component scripts' raw kubectl/mongodump/etcd output and
// prints one progress line per component to Progress instead; the captured
// output is shown only when a component fails. The zero value streams the raw
// output (restore, upgrade and migration callers).
type HostDriver struct {
	MinioAlias string
	Quiet      bool
	Progress   io.Writer
}

// maxCapturedOutput bounds the output kept for a failing component.
const maxCapturedOutput = 64 << 10

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	max int
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.max; over > 0 {
		t.buf = append(t.buf[:0], t.buf[over:]...)
	}
	return len(p), nil
}

var runBash = func(body string, args []string, stdout, stderr io.Writer) error {
	c := exec.Command("bash", append([]string{"-c", body}, args...)...)
	c.Env = append(os.Environ(), "KUBECONFIG=/etc/rancher/k3s/k3s.yaml")
	c.Stdout = stdout
	c.Stderr = stderr
	return c.Run()
}

func runScript(script, component, dir string, quiet bool, errOut io.Writer) error {
	// Normalise line endings: a Windows (autocrlf) checkout must not embed CRLF.
	body := strings.ReplaceAll(commonScript+"\n"+script, "\r\n", "\n")
	args := []string{"platform-backup", component, dir}
	if !quiet {
		if e := runBash(body, args, os.Stdout, os.Stderr); e != nil {
			return fmt.Errorf("component operation failed: %w", e)
		}
		return nil
	}
	out := &tailBuffer{max: maxCapturedOutput}
	if e := runBash(body, args, out, out); e != nil {
		if len(out.buf) > 0 {
			fmt.Fprintf(errOut, "--- %s output ---\n%s", component, out.buf)
			if out.buf[len(out.buf)-1] != '\n' {
				fmt.Fprintln(errOut)
			}
			fmt.Fprintf(errOut, "--- end of %s output ---\n", component)
		}
		return fmt.Errorf("component operation failed: %w", e)
	}
	return nil
}

func (d HostDriver) progress() io.Writer {
	if d.Progress != nil {
		return d.Progress
	}
	return os.Stdout
}

func (d HostDriver) Capture(component, dir string) error {
	start := time.Now()
	if d.Quiet {
		fmt.Fprintf(d.progress(), "  - Backing up %s...\n", component)
	}
	var e error
	if component == "minio" {
		e = captureMinioBuckets(dir, d.MinioAlias)
	} else {
		e = runScript(captureScript, component, dir, d.Quiet, os.Stderr)
	}
	if d.Quiet && e == nil {
		fmt.Fprintf(d.progress(), "    %s done (%s)\n", component, time.Since(start).Round(100*time.Millisecond))
	}
	return e
}
func (d HostDriver) Restore(component, dir string) error {
	if component == "minio" {
		return restoreMinioBuckets(dir, d.MinioAlias)
	}
	return runScript(restoreScript, component, dir, d.Quiet, os.Stderr)
}

func kubectl(args ...string) (string, error) {
	c := exec.Command("kubectl", args...)
	c.Env = append(os.Environ(), "KUBECONFIG=/etc/rancher/k3s/k3s.yaml")
	c.Stderr = os.Stderr
	b, e := c.Output()
	return strings.TrimSpace(string(b)), e
}

// Quiesce stops the platform API (the main Postgres/Redis/MinIO writer) so
// databases can be dropped and recreated. The returned resume function scales
// it back and restarts the platform deployments so every pod reads the
// restored Secrets. Project workloads are the operator's responsibility.
func (d HostDriver) Quiesce() (func() error, error) {
	out, e := kubectl("-n", "platform", "get", "deploy", "platform-api", "-o", "jsonpath={.spec.replicas}")
	if e != nil {
		return nil, fmt.Errorf("platform-api not found; provision the server before restoring: %w", e)
	}
	replicas, _ := strconv.Atoi(out)
	if replicas < 1 {
		replicas = 1
	}
	if _, e = kubectl("-n", "platform", "scale", "deploy/platform-api", "--replicas=0"); e != nil {
		return nil, e
	}
	_, _ = kubectl("-n", "platform", "wait", "--for=delete", "pod", "-l", "app=platform-api", "--timeout=180s")
	return func() error {
		if _, e := kubectl("-n", "platform", "scale", "deploy/platform-api", "--replicas="+strconv.Itoa(replicas)); e != nil {
			return e
		}
		if _, e := kubectl("-n", "platform", "rollout", "restart", "deploy"); e != nil {
			return e
		}
		_, e := kubectl("-n", "platform", "rollout", "status", "deploy/platform-api", "--timeout=600s")
		return e
	}, nil
}
