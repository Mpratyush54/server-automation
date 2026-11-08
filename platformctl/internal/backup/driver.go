package backup

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

//go:embed common.sh
var commonScript string

//go:embed capture.sh
var captureScript string

//go:embed restore.sh
var restoreScript string

// HostDriver runs only on the k3s server. Secrets are read inside the database
// containers, not placed in command arguments or printed in command logs.
type HostDriver struct{ MinioAlias string }

func runScript(script, component, dir, alias string) error {
	// Normalise line endings: a Windows (autocrlf) checkout must not embed CRLF.
	body := strings.ReplaceAll(commonScript+"\n"+script, "\r\n", "\n")
	c := exec.Command("bash", "-c", body, "platform-backup", component, dir)
	c.Env = append(os.Environ(), "KUBECONFIG=/etc/rancher/k3s/k3s.yaml")
	if alias != "" {
		c.Env = append(c.Env, "PLATFORM_BACKUP_MINIO_SOURCE="+alias)
	}
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	if e := c.Run(); e != nil {
		return fmt.Errorf("component operation failed: %w", e)
	}
	return nil
}
func (d HostDriver) Capture(component, dir string) error {
	return runScript(captureScript, component, dir, d.MinioAlias)
}
func (d HostDriver) Restore(component, dir string) error {
	return runScript(restoreScript, component, dir, d.MinioAlias)
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
