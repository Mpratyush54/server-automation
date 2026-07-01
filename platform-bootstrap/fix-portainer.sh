#!/bin/bash
# Load dynamic environment variables
source /etc/platform/.env

PORTAINER_POD_IP=$(kubectl get pod -n portainer -l app.kubernetes.io/name=portainer -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || kubectl get pod -n portainer -l app=portainer -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || echo "")
echo "Portainer pod IP: $PORTAINER_POD_IP"

if [[ -z "$PORTAINER_POD_IP" ]]; then
  echo "Error: could not find Portainer pod IP"
  exit 1
fi

kubectl apply -n platform -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: portainer-proxy
  namespace: platform
spec:
  ports:
  - name: https
    port: 9443
    targetPort: 9443
    protocol: TCP
---
apiVersion: v1
kind: Endpoints
metadata:
  name: portainer-proxy
  namespace: platform
subsets:
- addresses:
  - ip: $PORTAINER_POD_IP
  ports:
  - name: https
    port: 9443
    protocol: TCP
EOF

# Remove /portainer path from the main ingress rules
kubectl get ingress platform -n platform -o json | python3 -c "
import json, sys
obj = json.load(sys.stdin)
for rule in obj['spec']['rules']:
    if 'http' in rule:
        rule['http']['paths'] = [p for p in rule['http']['paths'] if p['path'] != '/portainer']
print(json.dumps(obj))
" | kubectl apply -f -

# Create dedicated portainer ingress with HTTPS backend
kubectl apply -n platform -f - <<EOFING
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: portainer-ingress
  namespace: platform
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
    nginx.ingress.kubernetes.io/proxy-ssl-verify: "off"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
spec:
  tls:
  - hosts:
    - $DOMAIN
    secretName: platform-tls
  rules:
  - host: $DOMAIN
    http:
      paths:
      - path: /portainer
        pathType: Prefix
        backend:
          service:
            name: portainer-proxy
            port:
              number: 9443
  - http:
      paths:
      - path: /portainer
        pathType: Prefix
        backend:
          service:
            name: portainer-proxy
            port:
              number: 9443
EOFING

echo "Portainer patch applied!"
