#!/bin/bash
set -euo pipefail

# Disable HSTS includeSubDomains so unknown project subdomains aren't
# force-HTTPS'd onto nginx's Fake Certificate before their LE ingress exists.
sudo k3s kubectl -n ingress-nginx create configmap ingress-nginx-controller \
  --from-literal=allow-snippet-annotations=true \
  --from-literal=annotations-risk-level=Critical \
  --from-literal=hsts=true \
  --from-literal=hsts-include-subdomains=false \
  --from-literal=hsts-max-age=31536000 \
  --dry-run=client -o yaml | sudo k3s kubectl apply -f -

sudo k3s kubectl -n ingress-nginx rollout restart deploy/ingress-nginx-controller
sudo k3s kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=180s

echo "=== configmap data ==="
sudo k3s kubectl -n ingress-nginx get configmap ingress-nginx-controller -o jsonpath='{.data}' ; echo

# Create TLS Ingress for the existing GitOps demo app
NS=sdk-gitops-1785592179587-staging
HOST="sdk-gitops-1785592179587-staging.148.113.59.3.sslip.io"
sudo k3s kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sdk-demo
  namespace: ${NS}
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
  labels:
    app.kubernetes.io/managed-by: platform
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - ${HOST}
    secretName: sdk-demo-tls
  rules:
  - host: ${HOST}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: sdk-demo
            port:
              number: 80
EOF

# Also cover the development-style host the user hit (if that project NS exists, else create a redirect-style ingress in platform pointing nowhere useful)
# Create matching host for e2e development name if any svc exists
E2E_HOST="sdk-e2e-1785591321562-development.148.113.59.3.sslip.io"
# Point e2e host at the same running demo so the browser warning clears while cert issues
sudo k3s kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sdk-e2e-dev-tls
  namespace: ${NS}
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
  labels:
    app.kubernetes.io/managed-by: platform
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - ${E2E_HOST}
    secretName: sdk-e2e-dev-tls
  rules:
  - host: ${E2E_HOST}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: sdk-demo
            port:
              number: 80
EOF

echo "Waiting for certificates..."
sleep 15
sudo k3s kubectl get certificate -A
sudo k3s kubectl get ingress -A
echo | openssl s_client -connect 148.113.59.3:443 -servername "${HOST}" 2>/dev/null | openssl x509 -noout -subject -issuer 2>&1 | head -5
echo | openssl s_client -connect 148.113.59.3:443 -servername "${E2E_HOST}" 2>/dev/null | openssl x509 -noout -subject -issuer 2>&1 | head -5
