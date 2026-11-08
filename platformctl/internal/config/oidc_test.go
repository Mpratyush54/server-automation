package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidACMEEmail(t *testing.T) {
	good := []string{"ops@company.io", "a.b+tag@mail.example.co.uk"}
	bad := []string{"", "admin@e2e.test", "admin@example.com", "x@host.local", "x@localhost",
		"no-at-sign", "a@b", "a@.com", "Name <a@b.io>", "a@sub..io"}
	for _, e := range good {
		if !ValidACMEEmail(e) {
			t.Errorf("%q should be valid", e)
		}
	}
	for _, e := range bad {
		if ValidACMEEmail(e) {
			t.Errorf("%q should be rejected (Let's Encrypt refuses it)", e)
		}
	}
}

func TestOIDCClientsJSON(t *testing.T) {
	c := &Config{Domain: "p.example.io", OIDCSecretGrafana: "g", OIDCSecretArgoCD: "a",
		OIDCSecretPortainer: "p", OIDCSecretOAuth2Proxy: "o", OIDCSecretMinio: "m"}
	var got []OIDCClient
	if err := json.Unmarshal([]byte(c.OIDCClientsJSON()), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"grafana":      "https://p.example.io/grafana/login/generic_oauth",
		"argocd":       "https://p.example.io/argocd/auth/callback",
		"portainer":    "https://portainer.p.example.io/",
		"oauth2-proxy": "https://p.example.io/oauth2/callback",
		"minio":        "https://minio.p.example.io/oauth_callback",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d clients", len(got))
	}
	for _, cl := range got {
		if cl.Secret == "" || len(cl.RedirectURIs) != 1 || cl.RedirectURIs[0] != want[cl.ID] {
			t.Errorf("bad client %+v", cl)
		}
		if strings.Contains(cl.ID, "infisical") {
			t.Error("Infisical was removed")
		}
	}
}

func TestGenerateSecretsCreatesDistinctOIDCSecrets(t *testing.T) {
	c := &Config{Domain: "d.io", AdminEmail: "a@d.io"}
	c.GenerateSecrets()
	seen := map[string]bool{}
	for _, s := range []string{c.OIDCSecretGrafana, c.OIDCSecretArgoCD, c.OIDCSecretPortainer, c.OIDCSecretOAuth2Proxy, c.OIDCSecretMinio} {
		if len(s) < 32 || seen[s] {
			t.Fatalf("OIDC secrets must be long and distinct, got %q", s)
		}
		seen[s] = true
	}
}
