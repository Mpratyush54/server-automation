# Bootstrap Deployment Walkthrough

Script: `platform-bootstrap/bootstrap.sh`  
Target: Ubuntu 22.04+ with k3s  
Version: 2.0.0

## Overview

The bootstrap script provisions a full Platform stack in ~30 minutes. It is **idempotent** — each phase checks a state file (`/etc/platform/.bootstrap_state`) and skips completed steps.

```bash
# Run on a fresh Ubuntu server
sudo ./platform-bootstrap/bootstrap.sh

# Or via curl (non-interactive with pre-filled .env)
NON_INTERACTIVE=true sudo ./platform-bootstrap/bootstrap.sh
```

## Phase 0 — Prerequisites

Installs system packages needed by all subsequent phases.

```bash
apt-get update -qq
apt-get install -y -qq \
  curl wget git jq unzip gnupg lsb-release ca-certificates \
  apt-transport-https software-properties-common \
  openssl bc netcat-openbsd postgresql-client apache2-utils
```

**Verification:**

```bash
which curl git jq openssl     # All should resolve
```

---

## Phase 1 — System Prep (Docker + k3s)

### Docker

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker "${SUDO_USER:-root}"
systemctl enable --now docker
```

**Verify:**

```bash
docker --version
docker info | grep -i "server version"
```

### k3s (Kubernetes)

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -
```

> `--disable traefik` is critical — the Platform stack uses ingress-nginx instead.

**Wait loop** (built into script):

```bash
for i in {1..30}; do
  kubectl get nodes >/dev/null 2>&1 && break
  sleep 2
done
```

**Kubeconfig setup:**

```bash
mkdir -p /root/.kube
cp /etc/rancher/k3s/k3s.yaml /root/.kube/config
chmod 600 /root/.kube/config
export KUBECONFIG=/root/.kube/config
```

**CoreDNS patch** — k3s ships with CoreDNS pointed at systemd-resolved (`127.0.0.53`) which doesn't work inside containers. The script rewrites upstream to `8.8.8.8` / `8.8.4.4` and adds ingress rewrite rules for the configured domain:

```bash
kubectl rollout restart -n kube-system deploy/coredns
kubectl wait --for=condition=Available deploy/coredns -n kube-system --timeout=60s
```

**Verify:**

```bash
kubectl get nodes -o wide
kubectl get pods -n kube-system
```

### Helm

```bash
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm repo add bitnami    https://charts.bitnami.com/bitnami
helm repo add grafana    https://grafana.github.io/helm-charts
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add argo       https://argoproj.github.io/argo-helm
helm repo add portainer  https://portainer.github.io/k8s/
helm repo add cert-manager https://charts.jetstack.io
helm repo update
```

**Verify:**

```bash
helm version --short
helm repo list
```

---

## Phase 2 — Namespaces & Helm Chart Deployments

### Namespaces

```bash
kubectl create namespace platform --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace databases --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace storage --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace portainer --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace infisical --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace cert-manager --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace ingress-nginx --dry-run=client -o yaml | kubectl apply -f -
```

### Ingress Controller (nginx)

```bash
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --set controller.service.type=LoadBalancer \
  --wait
```

**Verify:**

```bash
kubectl get pods -n ingress-nginx -w
kubectl get svc -n ingress-nginx
```

### cert-manager

```bash
helm upgrade --install cert-manager cert-manager/cert-manager \
  --namespace cert-manager \
  --set installCRDs=true \
  --wait
```

**Verify:**

```bash
kubectl get pods -n cert-manager
kubectl get crd | grep cert-manager
```

### Databases (Bitnami Helm Charts)

#### PostgreSQL

```bash
helm upgrade --install postgresql bitnami/postgresql \
  --namespace databases \
  --set auth.postgresPassword="$POSTGRES_PASSWORD" \
  --set auth.database=platform \
  --set primary.persistence.size=20Gi \
  --wait
```

Connection string: `postgresql://postgres:$POSTGRES_PASSWORD@postgresql.databases:5432/platform`

#### MongoDB

```bash
helm upgrade --install mongodb bitnami/mongodb \
  --namespace databases \
  --set auth.rootPassword="$MONGO_PASSWORD" \
  --set persistence.size=20Gi \
  --wait
```

Connection string: `mongodb://root:$MONGO_PASSWORD@mongodb.databases:27017/platform?authSource=admin`

#### Redis

```bash
helm upgrade --install redis bitnami/redis \
  --namespace databases \
  --set auth.password="$REDIS_PASSWORD" \
  --set replica.replicaCount=1 \
  --wait
```

Connection string: `redis://:$REDIS_PASSWORD@redis-master.databases:6379`

**Verify databases:**

```bash
kubectl get pods -n databases
kubectl exec -n databases postgresql-0 -- env PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -c "\l"
```

### MinIO (Object Storage)

Template interpolation first:

```bash
sed "s/{{DOMAIN}}/$DOMAIN/g" manifests/minio-values.yaml > /tmp/minio-values.yaml
```

Then install:

```bash
helm upgrade --install minio bitnami/minio \
  --namespace storage \
  -f /tmp/minio-values.yaml \
  --set auth.rootUser="$MINIO_ACCESS_KEY" \
  --set auth.rootPassword="$MINIO_SECRET_KEY" \
  --set persistence.size=50Gi \
  --set image.repository=bitnamilegacy/minio \
  --set console.image.repository=bitnamilegacy/minio-object-browser \
  --set defaultBuckets="platform-backups\,platform-logs" \
  --wait
```

**Verify:**

```bash
kubectl get pods -n storage
kubectl port-forward -n storage svc/minio 9001:9001 &  # MinIO Console
```

### ArgoCD

```bash
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  -f /tmp/argocd-values.yaml \
  --set configs.secret.argocdServerAdminPassword="$(htpasswd -bnBC 10 "" "$ARGOCD_PASSWORD" | tr -d ':\n')" \
  --set configs.params."server\.insecure"=true \
  --wait
```

> If Helm install fails, the script falls back to `kubectl apply -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml`

**Get initial password:**

```bash
kubectl -n argocd get secret argocd-secret -o jsonpath='{.data.admin\.password}' | base64 -d
```

### Prometheus Stack (kube-prometheus-stack)

```bash
helm upgrade --install kube-prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f /tmp/grafana-values.yaml \
  --set grafana.adminPassword="$GRAFANA_PASSWORD" \
  --set grafana.assertNoLeakedSecrets=false \
  --set prometheus.prometheusSpec.retention=30d \
  --set grafana.grafana\.ini.server.root_url="https://$DOMAIN/grafana/" \
  --set grafana.grafana\.ini.server.serve_from_sub_path=true \
  --wait --timeout=600s
```

### Grafana Loki

```bash
helm upgrade --install loki grafana/loki-stack \
  --namespace monitoring \
  --set grafana.enabled=false \
  --set prometheus.enabled=false \
  --set loki.persistence.enabled=true \
  --set loki.persistence.size=20Gi \
  --wait
```

Loki datasource is auto-configured in Grafana via ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-loki-datasource
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  loki-datasource.yaml: |
    apiVersion: 1
    datasources:
    - name: Loki
      type: loki
      access: proxy
      url: http://loki:3100
      isDefault: false
```

### Portainer

```bash
helm upgrade --install portainer portainer/portainer \
  --namespace portainer \
  -f /tmp/portainer-values.yaml \
  --set service.type=ClusterIP \
  --wait

# Wait for readiness
kubectl rollout status deployment/portainer -n portainer --timeout=120s

# Patch with --no-setup-token
kubectl patch deployment portainer -n portainer -p \
  '{"spec":{"template":{"spec":{"containers":[{"name":"portainer","args":["--no-setup-token"]}]}}}}'
kubectl rollout status deployment/portainer -n portainer --timeout=120s
```

Admin account is initialized via API before the 5-minute setup window expires:

```bash
PORTAINER_IP=$(kubectl get svc -n portainer portainer -o jsonpath='{.spec.clusterIP}')
curl -s -X POST "http://$PORTAINER_IP:9000/api/users/admin/init" \
  -H "Content-Type: application/json" \
  -d '{"Username":"admin","Password":"'"$ADMIN_PASS"'"}'
```

---

## Phase 3 — Wait for cert-manager & Create ClusterIssuer

After cert-manager is installed, two Let's Encrypt ClusterIssuers are created:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${LE_EMAIL}
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: ${LE_EMAIL}
    privateKeySecretRef:
      name: letsencrypt-staging
    solvers:
    - http01:
        ingress:
          class: nginx
```

**Verify:**

```bash
kubectl get clusterissuer
kubectl describe clusterissuer letsencrypt-prod
```

---

## Phase 4 — Build Docker Images, Import to k3s, Deploy Platform

### Build & Import API Image

```bash
docker build -t ghcr.io/your-org/platform-api:latest ../platform/api
docker save ghcr.io/your-org/platform-api:latest -o /tmp/platform-api.tar
k3s ctr images import /tmp/platform-api.tar
rm -f /tmp/platform-api.tar
```

### Build & Import Portal Image

```bash
docker build -t ghcr.io/your-org/platform-portal:latest ../platform/portal
docker save ghcr.io/your-org/platform-portal:latest -o /tmp/platform-portal.tar
k3s ctr images import /tmp/platform-portal.tar
rm -f /tmp/platform-portal.tar
```

> The `docker build` + `docker save` + `k3s ctr images import` pattern avoids needing a container registry for local deployments.

### Create Platform Secret

All environment variables are bundled into a Kubernetes secret:

```bash
kubectl create secret generic platform-env \
  --namespace platform \
  --from-literal=NODE_ENV=production \
  --from-literal=PORT=3000 \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=PLATFORM_WEBHOOK_SECRET="$PLATFORM_WEBHOOK_SECRET" \
  --from-literal=POSTGRES_HOST=postgresql.databases \
  --from-literal=POSTGRES_PORT=5432 \
  --from-literal=POSTGRES_DB=platform \
  --from-literal=POSTGRES_USER=postgres \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=MONGODB_URI="mongodb://root:$MONGO_PASSWORD@mongodb.databases:27017/platform?authSource=admin" \
  --from-literal=REDIS_HOST=redis-master.databases \
  --from-literal=REDIS_PORT=6379 \
  --from-literal=REDIS_PASSWORD="$REDIS_PASSWORD" \
  --from-literal=MINIO_ENDPOINT=http://minio.storage:9000 \
  --from-literal=MINIO_ACCESS_KEY="$MINIO_ACCESS_KEY" \
  --from-literal=MINIO_SECRET_KEY="$MINIO_SECRET_KEY" \
  --from-literal=GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  --from-literal=GITHUB_ORG="${GITHUB_ORG:-}" \
  --from-literal=GITHUB_WEBHOOK_SECRET="$PLATFORM_WEBHOOK_SECRET" \
  --from-literal=GITLAB_URL="${GITLAB_URL:-https://gitlab.com}" \
  --from-literal=GITLAB_TOKEN="${GITLAB_TOKEN:-}" \
  --from-literal=GITLAB_WEBHOOK_SECRET="$PLATFORM_WEBHOOK_SECRET" \
  --from-literal=CLICKUP_API_TOKEN="${CLICKUP_API_TOKEN:-}" \
  --from-literal=CLICKUP_TEAM_ID="${CLICKUP_TEAM_ID:-}" \
  --from-literal=CLICKUP_DEFAULT_LIST_ID="${CLICKUP_DEFAULT_LIST_ID:-}" \
  --from-literal=SMTP_PROVIDER="${SMTP_PROVIDER:-}" \
  --from-literal=SMTP_HOST="${SMTP_HOST:-}" \
  --from-literal=SMTP_PORT="${SMTP_PORT:-587}" \
  --from-literal=SMTP_USER="${SMTP_USER:-}" \
  --from-literal=SMTP_PASS="${SMTP_PASS:-}" \
  --from-literal=SENDGRID_API_KEY="${SENDGRID_API_KEY:-}" \
  --from-literal=MAILGUN_API_KEY="${MAILGUN_API_KEY:-}" \
  --from-literal=MAILGUN_DOMAIN="${MAILGUN_DOMAIN:-}" \
  --from-literal=SMTP_FROM_EMAIL="${SMTP_FROM_EMAIL:-noreply@$DOMAIN}" \
  --from-literal=SMTP_FROM_NAME="${SMTP_FROM_NAME:-Platform}" \
  --from-literal=PLATFORM_NAME="$PLATFORM_NAME" \
  --from-literal=DOMAIN="$DOMAIN" \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Deploy API + Portal

The script applies a single YAML manifest containing:
- `Deployment platform-api` — Node.js API (port 3000, `ghcr.io/your-org/platform-api:latest`)
- `Service platform-api` — ClusterIP on port 3000
- `Service api` — Alias service for convenience
- `Deployment platform-portal` — Angular portal served via nginx (port 80, `ghcr.io/your-org/platform-portal:latest`)
- `Service platform-portal` — ClusterIP on port 80
- `ClusterRoleBinding platform-api-admin-binding` — RBAC for cross-namespace operations
- ExternalName proxy services for: argoCD, Grafana, Portainer, Infisical, MinIO, oauth2-proxy
- `Ingress platform` — Single wildcard TLS ingress with `cert-manager.io/cluster-issuer: letsencrypt-prod`
- `Ingress portainer-ingress` — Separate ingress with oauth2-proxy auth annotations
- `Ingress minio-ingress` — Same pattern for MinIO Console
- `Ingress infisical-ingress` — Same pattern for Infisical

**Wait for readiness:**

```bash
kubectl wait --for=condition=Available deployment/platform-api \
  -n platform --timeout=300s

kubectl wait --for=condition=Ready certificate/platform-tls \
  -n platform --timeout=300s
```

---

## Phase 5 — Verification

### Pod Status

```bash
kubectl get pods -A
kubectl get pods --all-namespaces --field-selector=status.phase!=Running
```

### Health Check

```bash
# ClusterIP access
kubectl get svc -n platform platform-api
API_IP=$(kubectl get svc -n platform platform-api -o jsonpath='{.spec.clusterIP}')
curl -sf "http://$API_IP:3000/api/health"

# External access (if DNS is configured)
curl -sf "https://$DOMAIN/api/health"
```

### Database Connectivity

```bash
# PostgreSQL
kubectl exec -n databases postgresql-0 -- env PGPASSWORD="$POSTGRES_PASSWORD" \
  psql -U postgres -d platform -c "SELECT count(*) FROM information_schema.tables;"

# MongoDB
kubectl exec -n databases mongodb-0 -- mongosh \
  "mongodb://root:$MONGO_PASSWORD@localhost:27017/platform?authSource=admin" \
  --eval "db.getCollectionNames()"

# Redis
kubectl exec -n databases redis-master-0 -- redis-cli -a "$REDIS_PASSWORD" PING
```

### Ingress & Routes

```bash
# Check ingress rules
kubectl get ingress -n platform -o wide

# Check certificate status
kubectl get certificate -n platform
kubectl describe certificate platform-tls -n platform

# Verify ingress controller is serving
kubectl get svc -n ingress-nginx
curl -I "http://$DOMAIN" 2>/dev/null | head -5
```

### Seed Data

The bootstrap script finalizes by seeding the Platform database:

```bash
# Login and get token
TOKEN=$(curl -sf -X POST "$PLATFORM_API_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"devops@platform.io"}' | grep -o "\"token\":\"[^\"]*\"" | cut -d"\"" -f4)

# Register storage provider
curl -sf -X POST "$PLATFORM_API_URL/api/settings/storage" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"MinIO (bundled)","providerType":"minio","endpointUrl":"http://minio.storage:9000","bucketName":"platform-backups","isDefault":true,"credentials":{"accessKeyId":"'$MINIO_ACCESS_KEY'","secretAccessKey":"'$MINIO_SECRET_KEY'"}}'
```

### Summary Output

A successful bootstrap prints:

```
╔══════════════════════════════════════════════════════════════╗
║           Platform — Setup Complete                           ║
╚══════════════════════════════════════════════════════════════╝

  🌐 Platform URLs
  ┌─ Main Portal:   https://platform.dev
  ├─ API:           https://platform.dev/api
  ├─ ArgoCD:        https://argocd.platform.dev
  ├─ Grafana:       https://grafana.platform.dev
  ├─ Infisical:     https://infisical.platform.dev
  ├─ Portainer:     https://portainer.platform.dev
  └─ MinIO Console: https://minio.platform.dev
```

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `bootstrap.sh` fails at k3s install | Swap not disabled | `swapoff -a && sed -i '/ swap / s/^\(.*\)$/#\1/g' /etc/fstab` |
| CoreDNS crash loop | DNS upstream unreachable | Check `/etc/resolv.conf`, re-run CoreDNS patch |
| cert-manager stuck `Issuing` | Ingress not accessible from internet | Ensure DNS A records point to server IP, port 80/443 open |
| Pods in `ImagePullBackOff` | Image not imported to k3s | Re-run `docker save` + `k3s ctr images import` |
| Helm chart install timeout | No network to chart repos | Check `helm repo update`, proxy settings |
| PostgreSQL connection refused | Pod not ready | `kubectl logs -n databases postgresql-0` |
| SSL certificate not issued | Let's Encrypt rate limit or DNS | `kubectl describe certificate -n platform`, check `kubectl describe order -n platform` |

## Re-running

Delete the state file to re-run specific phases:

```bash
# Re-run everything
rm -f /etc/platform/.bootstrap_state
sudo ./bootstrap.sh

# Re-run from a specific phase (manually delete that phase from the state)
grep -v "platform" /etc/platform/.bootstrap_state > /tmp/state && mv /tmp/state /etc/platform/.bootstrap_state
sudo ./bootstrap.sh
```

State is tracked in `/etc/platform/.bootstrap_state`. Each phase marks completion:
```
prerequisites=done
config=done
docker=done
k3s=done
helm=done
namespaces=done
certmanager=done
databases=done
minio=done
argocd=done
monitoring=done
portainer=done
infisical=done
platform=done
seed=done
```
