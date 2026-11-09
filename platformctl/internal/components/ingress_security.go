package components

import "github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"

// IngressSecurityValues uses actual nginx directives: ingress-nginx does not
// have ConfigMap keys named limit-rps/limit-connections (those are annotations).
// Limits apply per client per controller, including platform-managed routes.
func IngressSecurityValues(c *config.Config) map[string]any {
	memory, cpu := "512Mi", "1000m"
	if c.WAF {
		memory, cpu = "1Gi", "2000m"
	}
	return map[string]any{"controller": map[string]any{
		"service":        map[string]any{"type": "LoadBalancer", "allocateLoadBalancerNodePorts": false},
		"publishService": map[string]any{"enabled": true},
		// ApplyServiceRouting needs configuration snippets to strip frame headers.
		// Ingress write privileges must remain limited to trusted operators/API.
		"allowSnippetAnnotations": true,
		"containerSecurityContext": map[string]any{
			"runAsNonRoot": true, "runAsUser": 101, "runAsGroup": 82, "allowPrivilegeEscalation": false,
			"seccompProfile": map[string]string{"type": "RuntimeDefault"},
			"capabilities":   map[string]any{"drop": []string{"ALL"}, "add": []string{"NET_BIND_SERVICE"}},
		},
		"resources": map[string]any{
			"requests": map[string]string{"cpu": "100m", "memory": "128Mi"},
			"limits":   map[string]string{"cpu": cpu, "memory": memory},
		},
		"config": map[string]string{
			"annotations-risk-level": "Critical",
			"hsts":                   "true", "hsts-include-subdomains": "false", "hsts-max-age": "31536000",
			"http-snippet": `limit_req_zone $binary_remote_addr zone=platform_requests:10m rate=100r/s;
limit_conn_zone $binary_remote_addr zone=platform_connections:10m;
limit_req zone=platform_requests burst=200 nodelay;
limit_conn platform_connections 100;`,
			// The controller template emits these directives at http scope.
			// Repeating them in http-snippet makes nginx reject its config.
			"limit-req-status-code": "429", "limit-conn-status-code": "429",
			"enable-modsecurity":           boolString(c.WAF),
			"enable-owasp-modsecurity-crs": boolString(c.WAF),
			"modsecurity-snippet":          "Include /etc/nginx/modsecurity/modsecurity.conf\nSecRuleEngine DetectionOnly",
		},
	}}
}

func boolString(v bool) string {
	if v {
		return "true"
	}
	return "false"
}
