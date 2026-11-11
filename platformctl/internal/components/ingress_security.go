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
		// externalTrafficPolicy Local keeps the client source IP: k3s routes
		// traffic for the LoadBalancer address (the node IP) straight to the
		// local controller pod without SNAT. With Cluster every request came
		// from the CNI gateway (10.42.0.1), which made the per-IP limits below
		// and the API's Express limiters one bucket shared by all clients.
		// The controller is the only hop: it overwrites X-Forwarded-For with
		// $remote_addr and ignores client-sent forwarding headers, so the API
		// (trust proxy = 1) sees the real, unspoofable client address.
		//
		// With Local, the k3s ServiceLB (svclb) pods forward to <hostIP>:<nodePort>
		// instead of the ClusterIP, so node ports are required: without them
		// svclb gets port 0 and host-local access (127.0.0.1:443, used by
		// `platformctl harden` readiness checks) breaks. The host firewall's
		// forward chain only admits original ports 80/443, so node ports are
		// not reachable from outside on hardened hosts.
		"service": map[string]any{
			"type": "LoadBalancer", "allocateLoadBalancerNodePorts": true,
			"externalTrafficPolicy": "Local",
		},
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
			// Explicit (also the chart defaults): never trust client-supplied
			// X-Forwarded-For / X-Real-IP; there is no proxy in front of nginx.
			"use-forwarded-headers":      "false",
			"compute-full-forwarded-for": "false",
			"use-proxy-protocol":         "false",
			"hsts":                       "true", "hsts-include-subdomains": "false", "hsts-max-age": "31536000",
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
