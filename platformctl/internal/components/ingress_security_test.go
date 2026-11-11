package components

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func TestIngressSecurityValues(t *testing.T) {
	for _, waf := range []bool{false, true} {
		values := IngressSecurityValues(&config.Config{WAF: waf})
		controller := values["controller"].(map[string]any)
		conf := controller["config"].(map[string]string)
		for _, directive := range []string{"limit_req_zone", "limit_conn_zone", "rate=100r/s", "limit_req zone=platform_requests burst=200 nodelay", "limit_conn platform_connections 100"} {
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
