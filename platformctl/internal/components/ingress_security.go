package components

import (
	"fmt"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

// IngressSecurityValues uses actual nginx directives: ingress-nginx does not
// have ConfigMap keys named limit-rps/limit-connections (those are annotations).
// Limits apply per client per controller, including platform-managed routes.
func IngressSecurityValues(c *config.Config) map[string]any {
	memory, cpu := "512Mi", "1000m"
	if c.WAF {
		memory, cpu = "1Gi", "2000m"
	}
	var limits []string
	if c.IngressIPRateLimit > 0 {
		limits = append(limits, fmt.Sprintf("limit_req_zone $binary_remote_addr zone=platform_requests:10m rate=%dr/s;", c.IngressIPRateLimit))
		requestLimit := "limit_req zone=platform_requests"
		if c.IngressIPBurst > 0 {
			requestLimit += fmt.Sprintf(" burst=%d nodelay", c.IngressIPBurst)
		}
		limits = append(limits, requestLimit+";")
	}
	if c.IngressIPConnections > 0 {
		limits = append(limits,
			"limit_conn_zone $binary_remote_addr zone=platform_connections:10m;",
			fmt.Sprintf("limit_conn platform_connections %d;", c.IngressIPConnections))
	}
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
	//
	// The trade-off of Local on several nodes: only a node with a ready local
	// controller pod can serve the address. On the ha profile (#54) the
	// controller is therefore a DaemonSet, so every health-checked node
	// (external mode) and whichever node kube-vip elects for the VIP (vip
	// mode; with svc_election kube-vip only elects nodes with a local
	// endpoint) has one.
	service := map[string]any{
		"type": "LoadBalancer", "allocateLoadBalancerNodePorts": true,
		"externalTrafficPolicy": "Local",
	}
	controller := map[string]any{
		"service":        service,
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
			"http-snippet": strings.Join(limits, "\n"),
			// The controller template emits these directives at http scope.
			// Repeating them in http-snippet makes nginx reject its config.
			"limit-req-status-code": "429", "limit-conn-status-code": "429",
			"enable-modsecurity":           boolString(c.WAF),
			"enable-owasp-modsecurity-crs": boolString(c.WAF),
			"modsecurity-snippet":          "Include /etc/nginx/modsecurity/modsecurity.conf\nSecRuleEngine DetectionOnly",
		},
	}
	if c.IsHA() {
		controller["kind"] = "DaemonSet"
		if strings.ToLower(strings.TrimSpace(c.IngressHAMode)) == config.IngressHAModeVIP && c.IngressVIP != "" {
			service["annotations"] = map[string]string{
				"kube-vip.io/loadbalancerIPs": c.IngressVIP,
			}
		}
	}
	return map[string]any{"controller": controller}
}

func boolString(v bool) string {
	if v {
		return "true"
	}
	return "false"
}
