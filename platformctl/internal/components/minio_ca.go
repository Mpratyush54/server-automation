package components

import (
	"fmt"
	"strings"
	"time"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// MinIO uses the platform API as its OpenID provider. It reads the discovery
// document in-cluster, but the document names the public issuer, so MinIO
// fetches the signing keys from https://DOMAIN/api/oauth/jwks. When the
// platform serves its internal CA (private-IP domain, or Let's Encrypt could
// not issue) that fetch failed with "x509: certificate signed by unknown
// authority", MinIO's IAM never initialised, and the storage-scoped and
// telemetry steps waited until they timed out.
//
// minio-values.yaml therefore mounts the ConfigMap below (optional, so MinIO
// starts without it) and adds its directory to SSL_CERT_DIR, next to the
// system roots. platformctl publishes the CA certificate (never its key)
// there before MinIO is installed and whenever the internal CA is in use.
// Grafana, oauth2-proxy and Portainer call the provider only through
// in-cluster URLs and ArgoCD gets the CA as its OIDC rootCA, so MinIO is the
// only client that needs this.
const (
	MinioNamespace     = "storage"
	MinioCAConfigMap   = "platform-ca"
	platformCASecretNS = "cert-manager"
	platformCASecret   = "platform-ca"
)

// Seams for tests.
var (
	readPlatformCA = func() string { return kubeSecretValue(platformCASecretNS, platformCASecret, "ca.crt") }
	readMinioCA    = func() string {
		out, _ := shell.Output("kubectl", "-n", MinioNamespace, "get", "configmap", MinioCAConfigMap, "--ignore-not-found", "-o", `jsonpath={.data.ca\.crt}`)
		return out
	}
	applyMinioCA = func(cm map[string]any) error {
		if err := kubeApplyJSON(map[string]any{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]string{"name": MinioNamespace}}); err != nil {
			return err
		}
		return kubeApplyJSON(cm)
	}
	minioInstalled = func() bool {
		out, err := shell.Output("kubectl", "-n", MinioNamespace, "get", "statefulset,deployment", "-l", "app.kubernetes.io/instance=minio", "-o", "name")
		return err == nil && strings.TrimSpace(out) != ""
	}
	restartMinio = func() error {
		return shell.RunBash(`set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl -n ` + MinioNamespace + ` rollout restart statefulset,deployment -l app.kubernetes.io/instance=minio >/dev/null`)
	}
	caWaitTimeout = 2 * time.Minute
	caPollEvery   = 5 * time.Second
)

// minioCAConfigMap renders the CA copy for MinIO, or nil without a certificate.
func minioCAConfigMap(caPEM string) map[string]any {
	cert := caCertificatePEM(caPEM)
	if cert == "" {
		return nil
	}
	return map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata": map[string]any{
			"name":      MinioCAConfigMap,
			"namespace": MinioNamespace,
			"labels":    map[string]string{"app.kubernetes.io/managed-by": "platformctl"},
		},
		"data": map[string]string{"ca.crt": cert},
	}
}

// publishMinioCA copies the internal CA certificate into MinIO's namespace.
// changed is true when the copy was created or its certificate changed; false
// (no error) when the CA does not exist yet.
func publishMinioCA() (changed bool, err error) {
	cm := minioCAConfigMap(readPlatformCA())
	if cm == nil {
		return false, nil
	}
	want := cm["data"].(map[string]string)["ca.crt"]
	if strings.TrimSpace(readMinioCA()) == strings.TrimSpace(want) {
		return false, nil
	}
	if err := applyMinioCA(cm); err != nil {
		return false, fmt.Errorf("publish the internal CA for MinIO: %w", err)
	}
	return true, nil
}

// prepareMinioCA runs before MinIO is installed, so its first start already
// trusts the internal CA. cert-manager issues the CA a few seconds after its
// issuers are applied; wait for it briefly. Best effort: trustMinioCA repairs
// a missing copy when the TLS step falls back to the internal CA.
func prepareMinioCA() {
	deadline := time.Now().Add(caWaitTimeout)
	for readPlatformCA() == "" {
		if time.Now().After(deadline) {
			color.Yellow("  ⚠ MinIO: the internal CA (secret cert-manager/platform-ca) is not ready; it is added when the TLS step falls back to it")
			return
		}
		time.Sleep(caPollEvery)
	}
	if _, err := publishMinioCA(); err != nil {
		color.Yellow("  ⚠ MinIO: %v", err)
	}
}

// trustMinioCA keeps MinIO's CA copy current. With the internal CA in use and
// a new copy, MinIO restarts: Go reads the trusted roots once per process.
func trustMinioCA(useCA bool) error {
	changed, err := publishMinioCA()
	if err != nil {
		return err
	}
	if !changed || !useCA || !minioInstalled() {
		return nil
	}
	color.Cyan("  ■ MinIO now trusts the internal CA; restarting it so OpenID sign-in works")
	return restartMinio()
}
