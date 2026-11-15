package k3s

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"slices"
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

// hostsPath is the node's hosts file (a variable for tests).
var hostsPath = "/etc/hosts"

// HostsWithEntry returns hosts file content in which host maps only to ip:
// other lines naming host are removed and one "<ip> <host>" line is appended.
func HostsWithEntry(content, host string, ip netip.Addr) string {
	var out []string
	for _, line := range strings.Split(strings.TrimRight(content, "\n"), "\n") {
		fields := strings.Fields(strings.SplitN(line, "#", 2)[0])
		if len(fields) > 1 && slices.Contains(fields[1:], host) {
			continue
		}
		out = append(out, line)
	}
	out = append(out, ip.String()+" "+host)
	return strings.TrimLeft(strings.Join(out, "\n"), "\n") + "\n"
}

// WriteHostsEntry maps host to ip in the node's hosts file, keeping every other
// entry. It reports whether the file changed.
func WriteHostsEntry(host string, ip netip.Addr) (bool, error) {
	if host == "" || strings.ContainsAny(host, " \t\n\r#") || !ip.IsValid() {
		return false, fmt.Errorf("invalid hosts entry")
	}
	current, err := os.ReadFile(hostsPath)
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	next := HostsWithEntry(string(current), host, ip)
	if next == string(current) {
		return false, nil
	}
	mode := os.FileMode(0644)
	if info, err := os.Stat(hostsPath); err == nil {
		mode = info.Mode().Perm()
	}
	return true, os.WriteFile(hostsPath, []byte(next), mode)
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
