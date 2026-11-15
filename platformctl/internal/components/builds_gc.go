package components

import (
	"fmt"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

func RegistryGCManifest() string {
	return fmt.Sprintf(`apiVersion: batch/v1
kind: Job
metadata: {name: registry-gc, namespace: registry}
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 600
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: {type: RuntimeDefault}}
      containers:
      - name: gc
        image: %s
        args: [garbage-collect, /etc/distribution/config.yml]
        envFrom: [{secretRef: {name: registry-storage}}]
        resources: {requests: {cpu: 100m, memory: 128Mi}, limits: {cpu: '1', memory: 512Mi}}
        securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
        volumeMounts: [{name: config, mountPath: /etc/distribution, readOnly: true}, {name: token, mountPath: /token, readOnly: true}]
      volumes: [{name: config, configMap: {name: registry}}, {name: token, secret: {secretName: registry-token-cert, items: [{key: cert.pem, path: cert.pem}]}}]
`, BuildRegistryImage)
}

// Registry GC requires a maintenance window: never sweep while pushes can run.
// The registry is restarted even if GC fails. No untagged-manifest deletion:
// BuildKit cache/index references must remain intact.
func InstallRegistryGC(c *config.Config) (result error) {
	if !BuildsEnabled(c) {
		return fmt.Errorf("source builds are disabled")
	}
	if err := shell.RunBash("kubectl -n registry scale deployment/registry --replicas=0"); err != nil {
		return err
	}
	defer func() {
		// Confirm the sweeper has stopped before reopening the registry for writes.
		if err := shell.RunBash("kubectl -n registry delete job registry-gc --ignore-not-found --cascade=foreground --wait=true --timeout=120s"); err != nil {
			result = fmt.Errorf("GC shutdown could not be confirmed; registry remains paused: %w", err)
			return
		}
		if err := shell.RunBash("kubectl -n registry scale deployment/registry --replicas=1"); result == nil {
			result = err
		}
	}()
	if err := shell.RunBash("kubectl -n registry wait --for=delete pod -l app=registry --timeout=120s"); err != nil {
		return err
	}
	if err := shell.RunBash("kubectl -n registry delete job registry-gc --ignore-not-found --wait=true"); err != nil {
		return err
	}
	if _, err := shell.RunWithInput("kubectl", []string{"create", "-f", "-"}, RegistryGCManifest()); err != nil {
		return err
	}
	return shell.RunBash("kubectl -n registry wait --for=condition=complete job/registry-gc --timeout=660s")
}
