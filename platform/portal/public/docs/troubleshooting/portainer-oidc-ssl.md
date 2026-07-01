# Portainer OIDC — "tls: failed to verify certificate"

## Symptom

> When configuring OIDC authentication in Portainer, the error `tls: failed to verify certificate` is shown.

## Root Cause

Portainer started before cert-manager completed issuing the Let's Encrypt certificate for the ingress. Because no valid TLS certificate existed yet, the ingress controller (or Portainer itself) fell back to a dummy self-signed certificate. OIDC providers (e.g., Google, Azure AD, Dex) reject self-signed certificates during the TLS handshake, causing the verification failure.

## Fix

Wait for the Let's Encrypt certificate to be fully issued before configuring OIDC.

### 1. Check certificate status

```bash
kubectl get certificate -n portainer
```

Wait until the `READY` column shows `True`:

```bash
kubectl wait --for=condition=Ready certificate/<your-cert-name> -n portainer --timeout=300s
```

### 2. Verify the ingress is serving the correct certificate

```bash
curl -v https://<your-domain> 2>&1 | grep -i "certificate\|issuer"
```

You should see `Let's Encrypt` as the issuer, not a self-signed authority.

### 3. Now configure OIDC

Navigate in Portainer to **Settings → Authentication → OIDC** and enter your provider details.

## Verification

```bash
# Confirm the TLS certificate is issued by Let's Encrypt
openssl s_client -connect <your-domain>:443 -servername <your-domain> 2>/dev/null | openssl x509 -noout -issuer
```

Expected output: `issuer=C = US, O = Let's Encrypt, CN = R3`

Attempt the OIDC login flow — it should redirect and authenticate successfully.
