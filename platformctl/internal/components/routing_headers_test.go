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
