package components

import (
	"strings"
	"testing"
)

// ingressDoc returns the manifest document of the Ingress named `name` from
// the rendered routing script ("" when absent). Documents are separated by
// "---" lines or heredoc "EOF" terminators.
func ingressDoc(script, name string) string {
	for _, chunk := range strings.Split(script, "\nEOF\n") {
		for _, doc := range strings.Split(chunk, "\n---\n") {
			if strings.Contains(doc, "kind: Ingress") && strings.Contains(doc, "\n  name: "+name+"\n") {
				return doc
			}
		}
	}
	return ""
}

// Regression: the main Ingress hid X-Frame-Options and Content-Security-Policy
// on every path, so the portal and the API reached browsers without their
// clickjacking protection. Only the embedded Grafana path may change framing,
// and only to same-origin.
func TestRoutingKeepsFrameProtectionOutsideGrafanaEmbed(t *testing.T) {
	script := serviceRoutingScript("example.test")

	main := ingressDoc(script, "platform")
	if main == "" {
		t.Fatal("main platform Ingress missing")
	}
	if strings.Contains(main, "proxy_hide_header") || strings.Contains(main, "configuration-snippet") {
		t.Fatalf("main Ingress must not rewrite response headers (portal and API send their own):\n%s", main)
	}
	for _, path := range []string{"path: /api", "path: /\n"} {
		if !strings.Contains(main, path) {
			t.Fatalf("main Ingress lost %q", path)
		}
	}
	if strings.Contains(main, "path: /grafana") {
		t.Fatal("/grafana must be served by platform-grafana-embed, not the main Ingress")
	}

	embed := ingressDoc(script, "platform-grafana-embed")
	if embed == "" {
		t.Fatal("platform-grafana-embed Ingress missing")
	}
	for _, want := range []string{
		"path: /grafana", "name: grafana-proxy", "host: example.test", "secretName: platform-tls",
		`add_header X-Frame-Options "SAMEORIGIN" always;`,
		`add_header Content-Security-Policy "frame-ancestors 'self'" always;`,
	} {
		if !strings.Contains(embed, want) {
			t.Fatalf("grafana embed Ingress missing %q:\n%s", want, embed)
		}
	}

	// No other Ingress strips framing headers.
	for _, name := range []string{"platform-argocd", "platform-portainer"} {
		if doc := ingressDoc(script, name); strings.Contains(doc, "proxy_hide_header X-Frame-Options") {
			t.Fatalf("%s must not strip X-Frame-Options", name)
		}
	}
	if strings.Contains(script, "__DOMAIN__") || strings.Contains(script, "__ISSUER__") {
		t.Fatal("unrendered placeholders left in the routing script")
	}
}

// Remote MCP (#193): https://DOMAIN/mcp and the OAuth discovery documents under
// /.well-known/oauth-* must reach the API, not the portal, with longer timeouts
// for tool calls, and without touching response headers.
func TestRoutingSendsMcpAndOAuthDiscoveryToAPI(t *testing.T) {
	script := serviceRoutingScript("example.test")

	doc := ingressDoc(script, "platform-mcp")
	if doc == "" {
		t.Fatal("platform-mcp Ingress missing")
	}
	for _, path := range []string{"/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"} {
		block := "- path: " + path + "\n        pathType: Prefix\n        backend:\n          service:\n            name: platform-api\n            port:\n              number: 3000"
		if !strings.Contains(doc, block) {
			t.Fatalf("platform-mcp must route %s to platform-api:3000:\n%s", path, doc)
		}
	}
	for _, want := range []string{
		"host: example.test", "secretName: platform-tls",
		`nginx.ingress.kubernetes.io/proxy-read-timeout: "120"`,
		`nginx.ingress.kubernetes.io/proxy-buffering: "off"`,
	} {
		if !strings.Contains(doc, want) {
			t.Fatalf("platform-mcp Ingress missing %q:\n%s", want, doc)
		}
	}
	if strings.Contains(doc, "proxy_hide_header") || strings.Contains(doc, "configuration-snippet") {
		t.Fatal("platform-mcp must not rewrite response headers (WWW-Authenticate must reach clients)")
	}
	// Only the API's own discovery paths: ACME HTTP-01 challenges stay with cert-manager.
	if strings.Contains(doc, "path: /.well-known\n") || strings.Contains(doc, "acme-challenge") {
		t.Fatal("platform-mcp must not claim all of /.well-known")
	}
	// The portal still serves everything else on the main host.
	main := ingressDoc(script, "platform")
	if !strings.Contains(main, "path: /\n") || strings.Contains(main, "path: /mcp") {
		t.Fatal("main Ingress must keep / for the portal and leave /mcp to platform-mcp")
	}
}
