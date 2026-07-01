# SSL Certificates (Let's Encrypt + cert-manager)

Platform uses **cert-manager** with **Let's Encrypt** to automatically provision and renew TLS certificates for all ingress endpoints.

---

## Architecture

```
Internet ──► Ingress-NGINX ──► cert-manager (HTTP-01 challenge)
                │
                ├── https://platform.dev
                ├── https://api.platform.dev
                ├── https://argocd.platform.dev
                ├── https://grafana.platform.dev
                ├── https://portainer.platform.dev
                ├── https://minio.platform.dev
                └── https://infisical.platform.dev
```

All subdomains share a single wildcard-ish certificate stored in the `platform-tls` secret.

---

## 1. Install cert-manager via Helm

### Add Helm Repository

```bash
helm repo add cert-manager https://charts.jetstack.io
helm repo update
```

### Install with CRDs

```bash
helm upgrade --install cert-manager cert-manager/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true \
  --wait
```

### Verify Installation

```bash
kubectl get pods -n cert-manager
# NAME                                       READY   STATUS    RESTARTS
# cert-manager-7dd585dc66-abcde              1/1     Running   0
# cert-manager-cainjector-7dd585dc66-abcde   1/1     Running   0
# cert-manager-webhook-7dd585dc66-abcde      1/1     Running   0

kubectl get crd | grep cert-manager
# certificaterequests.cert-manager.io
# certificates.cert-manager.io
# challenges.acme.cert-manager.io
# clusterissuers.cert-manager.io
# issuers.cert-manager.io
# orders.acme.cert-manager.io
```

---

## 2. Create ClusterIssuer (Staging + Production)

### Staging Issuer (for testing)

The staging environment has **much higher rate limits** but issues invalid certificates.

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: admin@yourcompany.com
    privateKeySecretRef:
      name: letsencrypt-staging
    solvers:
    - http01:
        ingress:
          class: nginx
```

### Production Issuer

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@yourcompany.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
```

### Apply

```bash
kubectl apply -f clusterissuer.yaml
```

### Verify

```bash
kubectl get clusterissuer
# NAME                  READY   AGE
# letsencrypt-prod      True    1m
# letsencrypt-staging   True    1m

kubectl describe clusterissuer letsencrypt-prod
# Should show: Status: True  Message: "The ACME account was registered with the ACME server"
```

---

## 3. Annotate Ingress for Automatic Certificate Provisioning

The Platform Ingress is annotated to automatically request certificates from cert-manager:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: platform
  namespace: platform
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod    # <-- triggers cert-manager
spec:
  tls:
  - hosts:
    - platform.dev
    - api.platform.dev
    - argocd.platform.dev
    - grafana.platform.dev
    - portainer.platform.dev
    - minio.platform.dev
    - infisical.platform.dev
    secretName: platform-tls    # <-- cert stored here
  rules:
  - host: platform.dev
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: platform-portal
            port:
              number: 80
```

### Key Annotations

| Annotation | Value | Purpose |
|---|---|---|
| `cert-manager.io/cluster-issuer` | `letsencrypt-prod` | Issuer to use for certificate |
| `kubernetes.io/ingress.class` | `nginx` | Which ingress controller to use |
| `nginx.ingress.kubernetes.io/proxy-body-size` | `50m` | Allow larger request bodies |

### Test with Staging First

To test without hitting production rate limits, temporarily switch:

```bash
kubectl annotate ingress platform -n platform \
  cert-manager.io/cluster-issuer=letsencrypt-staging \
  --overwrite
```

After verification, switch back:

```bash
kubectl annotate ingress platform -n platform \
  cert-manager.io/cluster-issuer=letsencrypt-prod \
  --overwrite
```

---

## 4. Certificate Status & Renewal Monitoring

### Check Certificate

```bash
kubectl get certificate -n platform
# NAME           READY   SECRET         AGE
# platform-tls   True    platform-tls   10d
```

### Detailed Certificate Info

```bash
kubectl describe certificate platform-tls -n platform
```

Look for:
```
Status:
  Conditions:
    Message:               Certificate is up to date and has not expired
    Reason:                Ready
    Status:                True
    Type:                  Ready
  Not After:               2026-09-28T12:00:00Z
  Renewal Time:            2026-08-29T12:00:00Z
```

### Check the TLS Secret

```bash
kubectl get secret platform-tls -n platform -o yaml
```

### Check Certificate Order

```bash
kubectl get orders -n platform
kubectl describe order -n platform <order-name>
```

### Check ACME Challenges

```bash
kubectl get challenges -n platform
kubectl describe challenge -n platform <challenge-name>
```

### Set Up Renewal Alerts

cert-manager handles automatic renewal 30 days before expiry. To monitor proactively:

```bash
# Check days until expiry
kubectl get certificate platform-tls -n platform -o json | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status']['notAfter'])"

# Add a Prometheus alert for certificates expiring soon
# cert-manager exposes metrics at :9402/metrics
# certmanager_certificate_expiration_timestamp_seconds
```

---

## 5. Troubleshooting DNS Challenges

### Symptom: Certificate stuck at "Issuing"

```bash
kubectl describe certificate platform-tls -n platform
```

Check the order and challenge:

```bash
kubectl get orders -n platform
kubectl describe order -n platform <order-name>
# Look for: State: pending, valid, or failed
```

### Symptom: Challenge "pending" or "invalid"

```bash
kubectl get challenges -n platform
kubectl describe challenge -n platform <challenge-name>
```

### Common DNS Issues

| Error | Cause | Fix |
|---|---|---|
| `Failed to load http-01 solver` | Ingress not reachable from internet | Ensure port 80 is open; test with `curl http://DOMAIN/.well-known/acme-challenge/test` |
| `No valid IP addresses` | DNS not resolving to server IP | `dig +short DOMAIN`, verify A record |
| `404 on challenge URL` | Ingress not routing to cert-manager solver | Check ingress controller is running: `kubectl get pods -n ingress-nginx` |
| `Rate limit exceeded` | Too many certificates in a week | Use staging issuer for testing |
| `context deadline exceeded` | Network timeout from ACME server | Check egress firewall; Let's Encrypt must reach your server |
| `Unknown issuer` | ClusterIssuer name mismatch | Verify annotation: `kubectl get ingress platform -n platform -o yaml \| grep cluster-issuer` |

### Manual Challenge Debugging

```bash
# 1. Verify DNS resolution
dig +short platform.dev
dig +short argocd.platform.dev

# 2. Check ingress controller serves on port 80
kubectl get svc -n ingress-nginx ingress-nginx-controller

# 3. Test HTTP challenge endpoint from external
curl -v http://platform.dev/.well-known/acme-challenge/ 2>&1 | head -20

# 4. Check cert-manager pod logs
kubectl logs -n cert-manager deploy/cert-manager --tail=50
kubectl logs -n cert-manager deploy/cert-manager --tail=50 -f

# 5. Force re-issuance by deleting the certificate
kubectl delete certificate platform-tls -n platform
# Wait for cert-manager to recreate it from the ingress annotation

# 6. Delete the order to retry
kubectl delete orders -n platform --all
```

---

## 6. Manual Certificate (Non-Let's Encrypt)

If you have your own certificate:

```bash
kubectl create secret tls platform-tls \
  --namespace platform \
  --cert=/path/to/cert.pem \
  --key=/path/to/key.pem

# Remove the cert-manager annotation to prevent overwrite
kubectl annotate ingress platform -n platform \
  cert-manager.io/cluster-issuer- \
```

---

## 7. Let's Encrypt Rate Limits

| Limit | Scope | Value |
|---|---|---|
| Certificates per registered domain | Per week | 50 |
| Duplicate certificate | Per week | 5 |
| Failed validations | Per account, per hostname, per hour | 5 |
| ACME account registrations | Per IP, per 3 hours | 10 |

**Always use staging for testing**, especially during development.

---

## 8. Full Verification Checklist

```bash
# 1. cert-manager pods running
kubectl get pods -n cert-manager

# 2. ClusterIssuer ready
kubectl get clusterissuer letsencrypt-prod -o jsonpath='{.status.conditions[0].status}'

# 3. Ingress has correct annotation
kubectl get ingress platform -n platform -o jsonpath='{.metadata.annotations}'

# 4. TLS section lists all hosts
kubectl get ingress platform -n platform -o jsonpath='{.spec.tls}'

# 5. Certificate issued
kubectl get certificate platform-tls -n platform -o wide

# 6. TLS secret exists
kubectl get secret platform-tls -n platform

# 7. HTTPS works from outside
curl -I https://$DOMAIN 2>/dev/null | grep -i "SSL\|TLS\|certificate"
curl -v https://$DOMAIN 2>&1 | grep "Server certificate"
```
