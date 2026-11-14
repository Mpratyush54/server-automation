package k3s

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"strings"
)

const buildRegistrySettingsPath = "/etc/rancher/k3s/cairn-build-registry.json"

// BuildRegistrySettings routes the build registry's public image name to the
// registry's in-cluster Service. Nothing is published through ingress: the
// node's containerd reaches the ClusterIP through kube-proxy. Older settings
// files with a CAFile field are read and the field ignored.
type BuildRegistrySettings struct {
	Host     string
	Endpoint string
}

// BuildRegistriesYAML keeps credentials in Kubernetes imagePullSecrets (per
// project, pull-only). The containerd mirror only supplies routing.
func BuildRegistriesYAML(githubToken string, settings BuildRegistrySettings) string {
	content := RegistriesYAML(githubToken)
	if settings.Host == "" || settings.Endpoint == "" {
		return content
	}
	return content + fmt.Sprintf("mirrors:\n  %q:\n    endpoint: [%q]\n", settings.Host, settings.Endpoint)
}

// ValidBuildRegistryEndpoint accepts only http://<cluster IP>:5000.
func ValidBuildRegistryEndpoint(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Port() != "5000" {
		return false
	}
	_, err = netip.ParseAddr(u.Hostname())
	return err == nil
}

// WriteBuildRegistry records the mirror and rewrites registries.yaml. Settings
// survive future GHCR credential reconciliation by WriteRegistries.
func WriteBuildRegistry(githubToken, host, endpoint string) (bool, error) {
	if host == "" || strings.ContainsAny(host, "/\\\n\r \"") {
		return false, fmt.Errorf("invalid registry host")
	}
	if !ValidBuildRegistryEndpoint(endpoint) {
		return false, fmt.Errorf("invalid registry endpoint")
	}
	if err := os.MkdirAll("/etc/rancher/k3s", 0755); err != nil {
		return false, err
	}
	data, _ := json.Marshal(BuildRegistrySettings{Host: host, Endpoint: endpoint})
	if err := os.WriteFile(buildRegistrySettingsPath, data, 0600); err != nil {
		return false, err
	}
	// The previous design trusted a registry CA file; it is no longer referenced.
	_ = os.Remove("/etc/rancher/k3s/cairn-registry-ca.crt")
	return WriteRegistries(githubToken)
}
