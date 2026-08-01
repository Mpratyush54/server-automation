#!/bin/bash
set -euo pipefail

echo "=== ingress-nginx pods ==="
sudo k3s kubectl -n ingress-nginx get pods || true
echo "=== configmap ==="
sudo k3s kubectl -n ingress-nginx get configmap ingress-nginx-controller -o yaml | sed -n '/^data:/,/^kind:/p' || true

NS=sdk-gitops-1785592179587-staging
HOST="sdk-gitops-1785592179587-staging.148.113.59.3.sslip.io"
E2E_HOST="sdk-e2e-1785591321562-development.148.113.59.3.sslip.io"

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
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sdk-e2e-dev-tls
  namespace: ${NS}
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
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

echo "=== certificates (wait 20s) ==="
sleep 20
sudo k3s kubectl get certificate -A || true
sudo k3s kubectl get ingress -A || true
sudo k3s kubectl -n cert-manager get pods || true
sudo k3s kubectl get challenges.acme.cert-manager.io -A 2>/dev/null || true
sudo k3s kubectl get certificaterequests -A 2>/dev/null || true

echo "=== TLS probe ${HOST} ==="
echo | openssl s_client -connect 148.113.59.3:443 -servername "${HOST}" 2>/dev/null | openssl x509 -noout -subject -issuer 2>&1 | head -5
echo "=== TLS probe ${E2E_HOST} ==="
echo | openssl s_client -connect 148.113.59.3:443 -servername "${E2E_HOST}" 2>/dev/null | openssl x509 -noout -subject -issuer 2>&1 | head -5
