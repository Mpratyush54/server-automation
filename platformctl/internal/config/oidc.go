package config

import (
	"encoding/json"
	"net/mail"
	"strings"
)

// reservedEmailDomains can never receive mail (RFC 2606 / 6761), so Let's
// Encrypt rejects them as ACME contacts.
var reservedEmailDomains = map[string]bool{
	"example.com": true, "example.net": true, "example.org": true,
}

var reservedTLDs = map[string]bool{
	"test": true, "example": true, "invalid": true, "localhost": true,
	"local": true, "internal": true, "lan": true, "home": true, "corp": true,
}

// ValidACMEEmail reports whether email is usable as a Let's Encrypt contact.
// An empty or unusable address is not an error for the installer: the ACME
// account is registered without a contact instead.
func ValidACMEEmail(email string) bool {
	email = strings.TrimSpace(email)
	if email == "" {
		return false
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email {
		return false
	}
	at := strings.LastIndex(email, "@")
	domain := strings.ToLower(email[at+1:])
	labels := strings.Split(domain, ".")
	if len(labels) < 2 || reservedEmailDomains[domain] {
		return false
	}
	tld := labels[len(labels)-1]
	if len(tld) < 2 || reservedTLDs[tld] {
		return false
	}
	for _, l := range labels {
		if l == "" {
			return false
		}
	}
	return true
}

// OIDCClient is one entry of the API's OIDC_CLIENTS registry.
type OIDCClient struct {
	ID           string   `json:"id"`
	Secret       string   `json:"secret"`
	RedirectURIs []string `json:"redirectUris"`
}

// OIDCClients is the registry of SSO clients the installer configures, with
// the exact redirect URI each one uses.
func (c *Config) OIDCClients() []OIDCClient {
	d := c.Domain
	return []OIDCClient{
		{ID: "grafana", Secret: c.OIDCSecretGrafana, RedirectURIs: []string{"https://" + d + "/grafana/login/generic_oauth"}},
		{ID: "argocd", Secret: c.OIDCSecretArgoCD, RedirectURIs: []string{"https://" + d + "/argocd/auth/callback"}},
		{ID: "portainer", Secret: c.OIDCSecretPortainer, RedirectURIs: []string{"https://portainer." + d + "/"}},
		{ID: "oauth2-proxy", Secret: c.OIDCSecretOAuth2Proxy, RedirectURIs: []string{"https://" + d + "/oauth2/callback"}},
	}
}

// OIDCClientsJSON renders the registry for the API's OIDC_CLIENTS variable.
func (c *Config) OIDCClientsJSON() string {
	b, _ := json.Marshal(c.OIDCClients())
	return string(b)
}

// OIDCIssuer is the fixed public issuer the API advertises and signs with.
func (c *Config) OIDCIssuer() string { return "https://" + c.Domain + "/api/oauth" }
