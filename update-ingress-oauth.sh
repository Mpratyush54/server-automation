#!/bin/bash
set -e
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

DOMAIN="148.113.59.57.sslip.io"

# Get the current ingress YAML to preserve other rules
kubectl get ingress caps-platform -n caps-platform -o yaml > /tmp/current-ingress.yaml

# Remove the portainer-ingress if it still exists
kubectl delete ingress portainer-ingress -n caps-platform 2>/dev/null || true

# Create ExternalName service for oauth2-proxy in caps-platform namespace
kubectl apply -n caps-platform -f - << EOF
apiVersion: v1
kind: Service
metadata:
  name: oauth2-proxy-proxy
  namespace: caps-platform
spec:
  type: ExternalName
  externalName: oauth2-proxy.oauth2-proxy.svc.cluster.local
EOF

echo "oauth2-proxy ExternalName service created"

# Patch the main caps-platform ingress to add /oauth2 path on root domain
# First, extract all rules except portainer/minio/infisical subdomain rules
# We'll replace the full ingress

kubectl apply -n caps-platform -f - << EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: caps-platform
  namespace: caps-platform
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
  - hosts:
    - ${DOMAIN}
    - api.${DOMAIN}
    - argocd.${DOMAIN}
    - grafana.${DOMAIN}
    - portainer.${DOMAIN}
    - minio.${DOMAIN}
    - infisical.${DOMAIN}
    secretName: caps-platform-tls
  rules:
  # Root domain - all path-based routes
  - host: ${DOMAIN}
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: caps-api
            port:
              number: 3000
      - path: /argocd
        pathType: Prefix
        backend:
          service:
            name: argocd-proxy
            port:
              number: 80
      - path: /grafana
        pathType: Prefix
        backend:
          service:
            name: grafana-proxy
            port:
              number: 80
      - path: /minio
        pathType: Prefix
        backend:
          service:
            name: minio-proxy
            port:
              number: 9090
      - path: /oauth2
        pathType: Prefix
        backend:
          service:
            name: oauth2-proxy-proxy
            port:
              number: 4180
      - path: /
        pathType: Prefix
        backend:
          service:
            name: caps-portal
            port:
              number: 80
  # API subdomain
  - host: api.${DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: caps-api
            port:
              number: 3000
  # ArgoCD subdomain (direct, no auth)
  - host: argocd.${DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: argocd-proxy
            port:
              number: 80
  # Grafana subdomain (direct, no auth)
  - host: grafana.${DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: grafana-proxy
            port:
              number: 80
  # Catch-all for bare IP access
  - http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: caps-api
            port:
              number: 3000
      - path: /argocd
        pathType: Prefix
        backend:
          service:
            name: argocd-proxy
            port:
              number: 80
      - path: /grafana
        pathType: Prefix
        backend:
          service:
            name: grafana-proxy
            port:
              number: 80
      - path: /minio
        pathType: Prefix
        backend:
          service:
            name: minio-proxy
            port:
              number: 9090
      - path: /oauth2
        pathType: Prefix
        backend:
          service:
            name: oauth2-proxy-proxy
            port:
              number: 4180
      - path: /
        pathType: Prefix
        backend:
          service:
            name: caps-portal
            port:
              number: 80
EOF

echo "Main ingress updated"

# Create auth-protected ingress for Portainer
kubectl apply -n caps-platform -f - << EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: portainer-ingress
  namespace: caps-platform
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-buffer-size: "8k"
    nginx.ingress.kubernetes.io/proxy-buffers-number: "4"
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/auth-url: "http://oauth2-proxy-proxy.caps-platform.svc.cluster.local:4180/oauth2/auth"
    nginx.ingress.kubernetes.io/auth-signin: "https://${DOMAIN}/oauth2/start?rd=\$scheme://\$host\$request_uri"
    nginx.ingress.kubernetes.io/auth-response-headers: "X-Auth-Request-User, X-Auth-Request-Email"
spec:
  tls:
  - hosts:
    - portainer.${DOMAIN}
    secretName: caps-platform-tls
  rules:
  - host: portainer.${DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: portainer-proxy
            port:
              number: 9000
EOF

echo "Portainer ingress created with auth"

# Create auth-protected ingress for MinIO
kubectl apply -n caps-platform -f - << EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: minio-ingress
  namespace: caps-platform
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-buffer-size: "8k"
    nginx.ingress.kubernetes.io/proxy-buffers-number: "4"
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/auth-url: "http://oauth2-proxy-proxy.caps-platform.svc.cluster.local:4180/oauth2/auth"
    nginx.ingress.kubernetes.io/auth-signin: "https://${DOMAIN}/oauth2/start?rd=\$scheme://\$host\$request_uri"
    nginx.ingress.kubernetes.io/auth-response-headers: "X-Auth-Request-User, X-Auth-Request-Email"
spec:
  tls:
  - hosts:
    - minio.${DOMAIN}
    secretName: caps-platform-tls
  rules:
  - host: minio.${DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: minio-proxy
            port:
              number: 9090
EOF

echo "MinIO ingress created with auth"

# Create auth-protected ingress for Infisical
kubectl apply -n caps-platform -f - << EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: infisical-ingress
  namespace: caps-platform
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-buffer-size: "8k"
    nginx.ingress.kubernetes.io/proxy-buffers-number: "4"
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/auth-url: "http://oauth2-proxy-proxy.caps-platform.svc.cluster.local:4180/oauth2/auth"
    nginx.ingress.kubernetes.io/auth-signin: "https://${DOMAIN}/oauth2/start?rd=\$scheme://\$host\$request_uri"
    nginx.ingress.kubernetes.io/auth-response-headers: "X-Auth-Request-User, X-Auth-Request-Email"
spec:
  tls:
  - hosts:
    - infisical.${DOMAIN}
    secretName: caps-platform-tls
  rules:
  - host: infisical.${DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: infisical-proxy
            port:
              number: 8080
EOF

echo "Infisical ingress created with auth"
echo "All ingresses updated successfully"
