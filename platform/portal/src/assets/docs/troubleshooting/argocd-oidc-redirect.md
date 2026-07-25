# ArgoCD login → `Invalid redirect URL`

## Symptom

Clicking "Sign in with SSO" on the ArgoCD login page redirects to Platform's
`/oauth2/start`, then loops back with:

```
Invalid redirect URL: the protocol and host (including port) must match and
the path must be within allowed URLs if provided
```

## Root Cause

ArgoCD validates the OAuth `redirect_uri` against its own `url` config setting.
Two configurations end up mismatched:

1. **Path-based mount** — bootstrap installed ArgoCD at
   `https://YOUR_DOMAIN/argocd` (because the DOMAIN is a bare IP or sslip.io).
   The `argocd-cm` `url` field must be exactly that URL.

2. **Subdomain mount** — bootstrap installed at `https://argocd.YOUR_DOMAIN`.
   The `url` field must be exactly that URL.

If the `url` field disagrees with what the browser is hitting — either because
you changed the ingress after install, moved from path-based to subdomain, or
added TLS after the fact — ArgoCD rejects the redirect.

## Fix

### 1. Confirm which URL your browser is actually hitting

Open the ArgoCD login page and copy the address bar. Call this `$EXPECTED_URL`.

Examples:

- Path-based: `https://203.0.113.10.sslip.io/argocd`
- Subdomain:  `https://argocd.platform.example.com`

### 2. Sync `argocd-cm.url` to `$EXPECTED_URL`

```bash
kubectl -n argocd patch configmap argocd-cm --type merge \
  -p '{"data":{"url":"https://argocd.platform.example.com"}}'
```

### 3. If ArgoCD is behind a subpath, also make sure `--basehref` and `--rootpath` match

The bootstrap sets these automatically. If you customised, verify the
`argocd-server` deployment args include:

```yaml
- --insecure
- --basehref=/argocd
- --rootpath=/argocd
```

### 4. Roll the ArgoCD server

```bash
kubectl -n argocd rollout restart deployment/argocd-server
kubectl -n argocd rollout status  deployment/argocd-server
```

### 5. Wait 30 s for oauth2-proxy to refresh its cached endpoints

If Platform uses oauth2-proxy in front of ArgoCD, its cached OIDC discovery
document also needs to invalidate. Restart it if the loop persists:

```bash
kubectl -n oauth2-proxy rollout restart deployment/oauth2-proxy
```

## Verification

```bash
curl -sk https://<ARGOCD_URL>/api/v1/settings | jq '.url,.oidcConfig.callbackURL'
```

Both fields should point at the same host as your browser.

Now try the login flow again — it should redirect out to your OIDC provider,
back to `/auth/callback`, and land you on the ArgoCD applications page.
