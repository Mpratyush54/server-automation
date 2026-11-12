package components

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func TestIngressSecurityValues(t *testing.T) {
	for _, waf := range []bool{false, true} {
		t.Setenv("INGRESS_IP_RATE_LIMIT", "")
		t.Setenv("INGRESS_IP_BURST", "")
		t.Setenv("INGRESS_IP_CONNECTIONS", "")
		cfg := config.Load()
		cfg.WAF = waf
		values := IngressSecurityValues(cfg)
		controller := values["controller"].(map[string]any)
		conf := controller["config"].(map[string]string)
		for _, directive := range []string{"limit_req_zone", "limit_conn_zone", "rate=1000r/s", "limit_req zone=platform_requests burst=2000 nodelay", "limit_conn platform_connections 2000"} {
			if !strings.Contains(conf["http-snippet"], directive) {
				t.Error("missing limit", directive)
			}
		}
		if conf["limit-req-status-code"] != "429" || conf["limit-conn-status-code"] != "429" || strings.Contains(conf["http-snippet"], "limit_req_status") || strings.Contains(conf["http-snippet"], "limit_conn_status") {
			t.Fatal("duplicate/rejected nginx status directives")
		}
		if conf["enable-modsecurity"] != boolString(waf) || conf["enable-owasp-modsecurity-crs"] != boolString(waf) || !strings.Contains(conf["modsecurity-snippet"], "SecRuleEngine DetectionOnly") || !strings.Contains(conf["modsecurity-snippet"], "Include /etc/nginx/modsecurity/modsecurity.conf") {
			t.Fatal("WAF policy")
		}
		if controller["allowSnippetAnnotations"] != true || conf["annotations-risk-level"] != "Critical" {
			t.Fatal("platform routing snippets broken")
		}
		service := controller["service"].(map[string]any)
		// Real client IPs for per-IP limits: Local keeps the source address;
		// svclb needs node ports under Local (host firewall blocks them externally).
		if service["externalTrafficPolicy"] != "Local" || service["allocateLoadBalancerNodePorts"] != true || service["type"] != "LoadBalancer" {
			t.Fatalf("client source IP not preserved: %v", service)
		}
		// Forwarding headers from clients must never be trusted (no proxy in front).
		for _, k := range []string{"use-forwarded-headers", "compute-full-forwarded-for", "use-proxy-protocol"} {
			if conf[k] != "false" {
				t.Fatalf("%s must be false, got %q", k, conf[k])
			}
		}
		security := controller["containerSecurityContext"].(map[string]any)
		if security["allowPrivilegeEscalation"] != false || security["runAsNonRoot"] != true {
			t.Fatal("controller privileges")
		}
		if _, err := json.Marshal(values); err != nil {
			t.Fatal(err)
		}
	}
}

func TestIngressSecurityValuesNonHAUnchanged(t *testing.T) {
	t.Setenv("INGRESS_IP_RATE_LIMIT", "")
	t.Setenv("INGRESS_IP_BURST", "")
	t.Setenv("INGRESS_IP_CONNECTIONS", "")
	for _, profile := range []string{config.ProfileMinimal, config.ProfileStandard, config.ProfileFull} {
		t.Run(profile, func(t *testing.T) {
			cfg := &config.Config{Profile: profile, IngressIPRateLimit: 1000, IngressIPBurst: 2000, IngressIPConnections: 2000}
			controller := IngressSecurityValues(cfg)["controller"].(map[string]any)
			if _, ok := controller["kind"]; ok {
				t.Fatal("non-ha must not set controller.kind")
			}
			service := controller["service"].(map[string]any)
			if _, ok := service["annotations"]; ok {
				t.Fatal("non-ha must not set service annotations")
			}
			if service["externalTrafficPolicy"] != "Local" || service["allocateLoadBalancerNodePorts"] != true {
				t.Fatalf("%v", service)
			}
		})
	}
}

func TestIngressSecurityValuesHA(t *testing.T) {
	vip := &config.Config{
		Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP, IngressVIP: "10.0.0.50",
		IngressIPRateLimit: 1000, IngressIPBurst: 2000, IngressIPConnections: 2000,
	}
	controller := IngressSecurityValues(vip)["controller"].(map[string]any)
	if controller["kind"] != "DaemonSet" {
		t.Fatal(controller["kind"])
	}
	service := controller["service"].(map[string]any)
	ann := service["annotations"].(map[string]string)
	if ann["kube-vip.io/loadbalancerIPs"] != "10.0.0.50" {
		t.Fatal(ann)
	}
	if service["externalTrafficPolicy"] != "Local" || service["allocateLoadBalancerNodePorts"] != true {
		t.Fatal(service)
	}

	ext := &config.Config{Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeExternal}
	controller = IngressSecurityValues(ext)["controller"].(map[string]any)
	if controller["kind"] != "DaemonSet" {
		t.Fatal(controller["kind"])
	}
	service = controller["service"].(map[string]any)
	if _, ok := service["annotations"]; ok {
		t.Fatal("external mode must not set kube-vip annotation")
	}
}

func TestIngressIPLimits(t *testing.T) {
	tests := []struct {
		name, rate, burst, connections, want string
	}{
		{"custom", "5000", "10000", "3000", "limit_req_zone $binary_remote_addr zone=platform_requests:10m rate=5000r/s;\nlimit_req zone=platform_requests burst=10000 nodelay;\nlimit_conn_zone $binary_remote_addr zone=platform_connections:10m;\nlimit_conn platform_connections 3000;"},
		{"no rate", "0", "2000", "3000", "limit_conn_zone $binary_remote_addr zone=platform_connections:10m;\nlimit_conn platform_connections 3000;"},
		{"no burst", "5000", "0", "0", "limit_req_zone $binary_remote_addr zone=platform_requests:10m rate=5000r/s;\nlimit_req zone=platform_requests;"},
		{"no connections", "5000", "10000", "0", "limit_req_zone $binary_remote_addr zone=platform_requests:10m rate=5000r/s;\nlimit_req zone=platform_requests burst=10000 nodelay;"},
		{"all disabled", "0", "0", "0", ""},
		{"invalid", "-1", "invalid", "65536", "limit_req_zone $binary_remote_addr zone=platform_requests:10m rate=1000r/s;\nlimit_req zone=platform_requests burst=2000 nodelay;\nlimit_conn_zone $binary_remote_addr zone=platform_connections:10m;\nlimit_conn platform_connections 2000;"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("INGRESS_IP_RATE_LIMIT", tt.rate)
			t.Setenv("INGRESS_IP_BURST", tt.burst)
			t.Setenv("INGRESS_IP_CONNECTIONS", tt.connections)
			controller := IngressSecurityValues(config.Load())["controller"].(map[string]any)
			got := controller["config"].(map[string]string)["http-snippet"]
			if got != tt.want {
				t.Fatalf("http-snippet = %q, want %q", got, tt.want)
			}
		})
	}
}

// Ingress HA settings left in the environment must not leak into the values of
// a non-ha install (switching profiles keeps .env keys around).
func TestIngressSecurityValuesIgnoreHASettingsOffHA(t *testing.T) {
	for _, profile := range []string{config.ProfileMinimal, config.ProfileStandard, config.ProfileFull} {
		plain := &config.Config{Profile: profile, IngressIPRateLimit: 1000, IngressIPBurst: 2000, IngressIPConnections: 2000}
		withHA := *plain
		withHA.IngressHAMode, withHA.IngressVIP, withHA.APIVIP = config.IngressHAModeVIP, "10.0.0.50", "10.0.0.60"
		if !reflect.DeepEqual(IngressSecurityValues(plain), IngressSecurityValues(&withHA)) {
			t.Fatalf("%s: ha settings changed non-ha values", profile)
		}
		var keys []string
		for k := range IngressSecurityValues(plain)["controller"].(map[string]any) {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		want := []string{"allowSnippetAnnotations", "config", "containerSecurityContext", "publishService", "resources", "service"}
		if !reflect.DeepEqual(keys, want) {
			t.Fatalf("%s: controller keys %v, want %v", profile, keys, want)
		}
	}
}
