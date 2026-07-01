#!/bin/bash
set -e
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

DOMAIN="${1:-148.113.58.205.sslip.io}"

helm repo add oauth2-proxy https://oauth2-proxy.github.io/manifests 2>/dev/null || true
helm repo update 2>&1 | tail -3

kubectl create namespace oauth2-proxy --dry-run=client -o yaml | kubectl apply -f -

COOKIE_SECRET=$(openssl rand -base64 32 | tr -d '=' | tr '/+' '_-')

cat > /tmp/oauth2-values.yaml << YAML
config:
  clientID: "oauth2-proxy"
  clientSecret: "placeholder"
  cookieSecret: "${COOKIE_SECRET}"
  emailDomains: ["*"]
  upstreams: ["static://202"]
  configFile: |
    provider = "oidc"
    oidc_issuer_url = "https://${DOMAIN}/api/oauth"
    email_domains = [ "*" ]
    upstreams = [ "static://202" ]
    set_xauthrequest = true
    reverse_proxy = true
    cookie_secure = true
    cookie_samesite = "lax"
    cookie_domains = [ ".${DOMAIN}" ]
    whitelist_domains = [ ".${DOMAIN}" ]
    pass_access_token = true
    pass_authorization_header = true
    set_authorization_header = true
    ssl_insecure_skip_verify = true
    skip_provider_button = true
    cookie_refresh = "5m"
    cookie_expire = "24h"
    scope = "openid profile email groups"
    redirect_url = "https://${DOMAIN}/oauth2/callback"

service:
  type: ClusterIP
  portNumber: 4180

ingress:
  enabled: false

extraArgs:
  http-address: "0.0.0.0:4180"
YAML

helm upgrade --install oauth2-proxy oauth2-proxy/oauth2-proxy \
  --namespace oauth2-proxy \
  -f /tmp/oauth2-values.yaml \
  --wait 2>&1

echo "oauth2-proxy installed successfully (DOMAIN=$DOMAIN)"
