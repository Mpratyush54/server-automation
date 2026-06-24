#!/bin/bash
# CAPS Platform Bootstrap Script
# Single-command server and cluster provisioning
set -euo pipefail

CAPS_VERSION="1.0.0"
LOG_FILE="/var/log/caps-bootstrap.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
error() { log "ERROR: $*"; exit 1; }

log "CAPS Platform Bootstrap v${CAPS_VERSION}"
log "Starting provisioning..."

# --- Prerequisites ---
log "Checking prerequisites..."
command -v curl >/dev/null 2>&1 || error "curl is required"
command -v wget >/dev/null 2>&1 || error "wget is required"

# --- Docker ---
install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker already installed: $(docker --version)"
    return
  fi
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  log "Docker installed: $(docker --version)"
}

# --- Kubernetes (k3s) ---
install_kubernetes() {
  if command -v kubectl >/dev/null 2>&1; then
    log "Kubernetes already installed: $(kubectl version --client --short 2>/dev/null || true)"
    return
  fi
  log "Installing Kubernetes (k3s)..."
  curl -sfL https://get.k3s.io | sh -
  mkdir -p ~/.kube
  cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
  chmod 600 ~/.kube/config
  log "Kubernetes installed"
}

# --- Helm ---
install_helm() {
  if command -v helm >/dev/null 2>&1; then
    log "Helm already installed: $(helm version --short)"
    return
  fi
  log "Installing Helm..."
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  log "Helm installed: $(helm version --short)"
}

# --- ArgoCD ---
install_argocd() {
  if kubectl get namespace argocd >/dev/null 2>&1; then
    log "ArgoCD already installed"
    return
  fi
  log "Installing ArgoCD..."
  kubectl create namespace argocd
  kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
  log "ArgoCD installed"
}

# --- Prometheus + Grafana ---
install_monitoring() {
  if helm list -n monitoring | grep -q prometheus >/dev/null 2>&1; then
    log "Prometheus stack already installed"
    return
  fi
  log "Installing Prometheus + Grafana..."
  kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
  helm repo update
  helm install prometheus prometheus-community/kube-prometheus-stack -n monitoring
  log "Prometheus + Grafana installed"
}

# --- Loki ---
install_loki() {
  if helm list -n monitoring | grep -q loki >/dev/null 2>&1; then
    log "Loki already installed"
    return
  fi
  log "Installing Loki..."
  helm repo add grafana https://grafana.github.io/helm-charts
  helm repo update
  helm install loki grafana/loki-stack -n monitoring
  log "Loki installed"
}

# --- PostgreSQL ---
install_postgresql() {
  if helm list -n databases | grep -q postgresql >/dev/null 2>&1; then
    log "PostgreSQL already installed"
    return
  fi
  log "Installing PostgreSQL..."
  kubectl create namespace databases --dry-run=client -o yaml | kubectl apply -f -
  helm repo add bitnami https://charts.bitnami.com/bitnami
  helm repo update
  helm install postgresql bitnami/postgresql -n databases \
    --set auth.postgresPassword=caps \
    --set auth.database=caps_platform
  log "PostgreSQL installed"
}

# --- MongoDB ---
install_mongodb() {
  if helm list -n databases | grep -q mongodb >/dev/null 2>&1; then
    log "MongoDB already installed"
    return
  fi
  log "Installing MongoDB..."
  helm install mongodb bitnami/mongodb -n databases
  log "MongoDB installed"
}

# --- Redis ---
install_redis() {
  if helm list -n databases | grep -q redis >/dev/null 2>&1; then
    log "Redis already installed"
    return
  fi
  log "Installing Redis..."
  helm install redis bitnami/redis -n databases
  log "Redis installed"
}

# --- MinIO ---
install_minio() {
  if helm list -n storage | grep -q minio >/dev/null 2>&1; then
    log "MinIO already installed"
    return
  fi
  log "Installing MinIO..."
  kubectl create namespace storage --dry-run=client -o yaml | kubectl apply -f -
  helm repo add minio https://helm.min.io/
  helm repo update
  helm install minio minio/minio -n storage \
    --set accessKey=caps \
    --set secretKey=capsminio \
    --set persistence.size=10Gi
  log "MinIO installed"
}

# --- CAPS Platform ---
deploy_caps_platform() {
  if kubectl get deployment -n caps-platform | grep -q caps-api >/dev/null 2>&1; then
    log "CAPS Platform already deployed"
    return
  fi
  log "Deploying CAPS Platform..."
  kubectl create namespace caps-platform --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -n caps-platform -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: caps-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: caps-api
  template:
    metadata:
      labels:
        app: caps-api
    spec:
      containers:
      - name: api
        image: caps/platform-api:latest
        ports:
        - containerPort: 3000
        env:
        - name: POSTGRES_HOST
          value: postgresql.databases
        - name: MONGODB_URI
          value: mongodb://mongodb.databases:27017/caps_platform
        - name: REDIS_HOST
          value: redis-master.databases
---
apiVersion: v1
kind: Service
metadata:
  name: caps-api
spec:
  selector:
    app: caps-api
  ports:
  - port: 3000
    targetPort: 3000
  type: LoadBalancer
EOF
  log "CAPS Platform deployed"
}

# --- Execute ---
install_docker
install_kubernetes
install_helm
install_argocd
install_monitoring
install_loki
install_postgresql
install_mongodb
install_redis
install_minio
deploy_caps_platform

log "CAPS Platform Bootstrap completed successfully!"
log "Run 'kubectl get all -A' to verify all components."
