package cmd

import (
	"slices"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/ingressha"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
)

// parseK3sConfig reads the subset of YAML platformctl renders for k3s:
// "key: value" scalars and "key:" followed by "  - item" lists.
func parseK3sConfig(t *testing.T, data string) (keys []string, values map[string][]string) {
	t.Helper()
	values = map[string][]string{}
	current := ""
	for _, raw := range strings.Split(data, "\n") {
		line := strings.TrimRight(raw, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "- ") {
			if current == "" {
				t.Fatalf("list item without key: %q", line)
			}
			values[current] = append(values[current], strings.Trim(strings.TrimPrefix(trimmed, "- "), `"`))
			continue
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			t.Fatalf("unexpected line %q", line)
		}
		current = key
		keys = append(keys, key)
		if v := strings.TrimSpace(value); v != "" {
			values[key] = []string{strings.Trim(v, `"`)}
		} else {
			values[key] = nil
		}
	}
	return keys, values
}

// mergeK3sConfig applies k3s' config.yaml.d rules: drop-ins are read in order
// after config.yaml; a plain key replaces the value, "key+" appends to it.
func mergeK3sConfig(t *testing.T, base string, dropIns ...string) map[string][]string {
	t.Helper()
	_, merged := parseK3sConfig(t, base)
	for _, d := range dropIns {
		keys, values := parseK3sConfig(t, d)
		for _, k := range keys {
			if name, ok := strings.CutSuffix(k, "+"); ok {
				merged[name] = append(merged[name], values[k]...)
			} else {
				merged[k] = values[k]
			}
		}
	}
	return merged
}

// k3sCriticalKeys are the settings k3s requires to be identical on every server
// (a joining server with different values is refused) that platformctl sets.
var k3sCriticalKeys = []string{"disable", "secrets-encryption", "cluster-cidr", "service-cidr", "cluster-dns", "cluster-domain", "flannel-backend", "disable-network-policy", "disable-kube-proxy", "egress-selector-mode"}

func TestHAServerConfigAndIngressFragmentMerge(t *testing.T) {
	c := &config.Config{
		Profile:       config.ProfileHA,
		IngressHAMode: config.IngressHAModeVIP, IngressVIP: "10.0.0.50", APIVIP: "10.0.0.60",
		Cluster: config.Cluster{APISANs: []string{"k8s.example.com", "10.0.0.100"}, NodeIP: "10.0.0.11"},
	}
	fragment := ingressha.K3sConfigFragment(c)
	if fragment == "" {
		t.Fatal("vip mode must render a fragment")
	}
	// The fragment only appends, so it can never replace a first-server setting.
	keys, _ := parseK3sConfig(t, fragment)
	for _, k := range keys {
		if !strings.HasSuffix(k, "+") {
			t.Fatalf("ingress HA fragment key %q replaces instead of appending", k)
		}
	}

	first := mergeK3sConfig(t, k3s.RenderServerConfig(k3sServerOptions(c)), fragment)
	joinOpts := clusterServerOptions(c)
	joinOpts.ServerURL, joinOpts.TokenFile = "https://10.0.0.60:6443", k3s.ServerTokenFile
	joinOpts.NodeIP = "10.0.0.12"
	joiner := mergeK3sConfig(t, k3s.RenderServerConfig(joinOpts), fragment)

	if got, want := first["tls-san"], []string{"k8s.example.com", "10.0.0.100", "10.0.0.60"}; !slices.Equal(got, want) {
		t.Fatalf("first server tls-san = %v, want PLATFORM_API_SANS plus API_VIP %v", got, want)
	}
	if !slices.Equal(joiner["tls-san"], first["tls-san"]) {
		t.Fatalf("servers serve different SANs: %v vs %v", joiner["tls-san"], first["tls-san"])
	}
	if got := first["disable"]; !slices.Equal(got, []string{"traefik", "servicelb"}) {
		t.Fatalf("disable = %v", got)
	}
	for _, k := range k3sCriticalKeys {
		if !slices.Equal(first[k], joiner[k]) {
			t.Errorf("critical k3s setting %s differs: first %v, joiner %v", k, first[k], joiner[k])
		}
	}
	if first["cluster-init"] == nil || joiner["cluster-init"] != nil || joiner["server"] == nil {
		t.Fatalf("cluster-init only on the first server, server URL only on joiners: %v / %v", first, joiner)
	}

	// Without the fragment a joiner would disagree on servicelb (k3s refuses it):
	// this is why join writes the fragment on servers.
	bare := mergeK3sConfig(t, k3s.RenderServerConfig(joinOpts))
	if slices.Equal(bare["disable"], first["disable"]) {
		t.Fatal("expected a disable mismatch without the fragment")
	}

	// tls-san+ without PLATFORM_API_SANS still yields just the API VIP.
	c.Cluster.APISANs = nil
	only := mergeK3sConfig(t, k3s.RenderServerConfig(k3sServerOptions(c)), ingressha.K3sConfigFragment(c))
	if !slices.Equal(only["tls-san"], []string{"10.0.0.60"}) {
		t.Fatalf("tls-san = %v", only["tls-san"])
	}

	// External mode: no fragment, so first server and joiners keep servicelb.
	c.IngressHAMode = config.IngressHAModeExternal
	if ingressha.K3sConfigFragment(c) != "" {
		t.Fatal("external mode must not render a fragment")
	}
}
