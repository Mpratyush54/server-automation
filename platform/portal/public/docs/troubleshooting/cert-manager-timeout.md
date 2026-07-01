# cert-manager — Certificate stuck in "Issued=False"

## Symptom

> `kubectl get certificate` shows `READY=False` with conditions like:
> - `TLS handshake timeout`
> - `DNS challenge failed`
> - `Connection refused` or `i/o timeout`

## Root Cause

cert-manager cannot complete the ACME challenge (HTTP-01 or DNS-01) because:

| Cause | Scenario |
|-------|----------|
| DNS propagation delay | The DNS records for the domain have not propagated before the challenge check |
| Firewall blocking port 80/443 | HTTP-01 challenge requires inbound access to port 80 or 443 from the internet |
| A/AAAA records point to wrong IP | The domain resolves to an IP that does not route to the ingress controller |
| Rate limiting | Let's Encrypt production issuer has rate limits per domain per week |

## Fix

### 1. Use the Let's Encrypt **staging** issuer for testing

Create a staging issuer to avoid rate limits during testing:

```yaml
# letsencrypt-staging.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-staging-private-key
    solvers:
      - http01:
          ingress:
            class: nginx
```

Apply it:

```bash
kubectl apply -f letsencrypt-staging.yaml
```

Reference the staging issuer in your Certificate or ingress annotation:

```yaml
cert-manager.io/cluster-issuer: letsencrypt-staging
```

### 2. Verify DNS records

```bash
dig +short A <your-domain>
dig +short AAAA <your-domain>    # only if you serve IPv6
```

Ensure the resolved IP matches your cluster's ingress controller external IP.

### 3. Check port reachability

```bash
# From an external machine
curl -v http://<your-domain>/.well-known/acme-challenge/test
curl -v https://<your-domain>
```

Port 80 (HTTP-01 challenge) and port 443 (TLS) must be reachable from the public internet. Check cloud firewall / security group rules and your local firewall.

### 4. Check the certificate request logs

```bash
kubectl describe certificate <cert-name> -n <namespace>
kubectl describe order -n <namespace>
kubectl describe challenge -n <namespace>
kubectl logs -l app=cert-manager -n cert-manager --tail=50
```

The logs will show exactly which step failed and why.

### 5. Switch to production issuer after testing

Once staging works, update to the production issuer:

```yaml
server: https://acme-v02.api.letsencrypt.org/directory
```

## Verification

```bash
kubectl get certificate <cert-name> -n <namespace> -w
```

Expected output — `READY` changes to `True`.

```bash
openssl s_client -connect <your-domain>:443 -servername <your-domain> 2>/dev/null \
  | openssl x509 -noout -issuer
```

Expected output — shows Let's Encrypt as the issuer.
