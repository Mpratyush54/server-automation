#!/usr/bin/env bash
# =============================================================================
#  CAPS Platform — Full Server Bootstrap
#  Run this script once on a fresh Ubuntu 22.04+ server to get a fully
#  operational CAPS Platform with all integrations configured.
#
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/your-org/caps/main/caps-bootstrap/bootstrap.sh | bash
#    — or —
#    git clone <repo> && cd caps-bootstrap && chmod +x bootstrap.sh && sudo ./bootstrap.sh
# =============================================================================
set -Eeuo pipefail
trap 'echo "[CAPS] ❌ Bootstrap failed at line $LINENO — check /var/log/caps-bootstrap.log for details." >&2' ERR

# ─── Globals ─────────────────────────────────────────────────────────────────
CAPS_VERSION="2.0.0"
LOG_FILE="/var/log/caps-bootstrap.log"
STATE_FILE="/etc/caps/.bootstrap_state"
ENV_FILE="/etc/caps/.env"
CAPS_NAMESPACE="caps-platform"
CAPS_REPO_URL="${CAPS_REPO_URL:-}"      # Filled interactively if empty
CAPS_IMAGE_TAG="${CAPS_IMAGE_TAG:-latest}"
DOMAIN="${CAPS_DOMAIN:-}"
SKIP_K8S="${SKIP_K8S:-false}"
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"

# Colours
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ─── Logging ─────────────────────────────────────────────────────────────────
mkdir -p /var/log /etc/caps
log()     { echo -e "${GREEN}[CAPS $(date '+%H:%M:%S')]${NC} $*" | tee -a "$LOG_FILE"; }
warn()    { echo -e "${YELLOW}[WARN $(date '+%H:%M:%S')]${NC} $*" | tee -a "$LOG_FILE"; }
info()    { echo -e "${BLUE}[INFO $(date '+%H:%M:%S')]${NC} $*" | tee -a "$LOG_FILE"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" | tee -a "$LOG_FILE"; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}════════════════════════════════════════════════════════${NC}"; \
            echo -e "${BOLD}${CYAN}  $*${NC}"; \
            echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════${NC}"; }
done_()   { echo -e "${GREEN}  ✔ $*${NC}"; }

# ─── State tracking ──────────────────────────────────────────────────────────
mark_done()  { echo "$1=done" >> "$STATE_FILE"; }
is_done()    { grep -q "^$1=done$" "$STATE_FILE" 2>/dev/null; }

# ─── Utilities ───────────────────────────────────────────────────────────────
ask() {
  local prompt="$1" var="$2" default="${3:-}"
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    eval "$var='${default}'"
    return
  fi
  echo -ne "${BOLD}${CYAN}  ▶ $prompt${NC}"
  [[ -n "$default" ]] && echo -ne " ${YELLOW}[$default]${NC}"
  echo -ne ": "
  local input; read -r input
  eval "$var='${input:-$default}'"
}

ask_secret() {
  local prompt="$1" var="$2"
  if [[ "$NON_INTERACTIVE" == "true" ]]; then eval "$var=''"; return; fi
  echo -ne "${BOLD}${CYAN}  ▶ $prompt${NC}: "
  local input; read -rs input; echo
  eval "$var='$input'"
}

ask_yn() {
  local prompt="$1" var="$2" default="${3:-y}"
  if [[ "$NON_INTERACTIVE" == "true" ]]; then eval "$var='$default'"; return; fi
  echo -ne "${BOLD}${CYAN}  ▶ $prompt${NC} ${YELLOW}[y/n, default: $default]${NC}: "
  local input; read -r input
  eval "$var='${input:-$default}'"
}

write_env() { echo "$1='$2'" >> "$ENV_FILE"; }

gen_password() { openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 32; }
gen_secret()   { openssl rand -hex 32; }

require_root() {
  [[ $EUID -eq 0 ]] || error "Please run as root (sudo ./bootstrap.sh)"
}

require_ubuntu() {
  [[ -f /etc/lsb-release ]] && source /etc/lsb-release
  [[ "${DISTRIB_ID:-}" == "Ubuntu" ]] || warn "This script is optimized for Ubuntu. Proceeding anyway..."
}

# ─── Print banner ─────────────────────────────────────────────────────────────
print_banner() {
  echo -e "${BOLD}${CYAN}"
  cat << 'BANNER'
  ██████╗ █████╗ ██████╗ ███████╗
 ██╔════╝██╔══██╗██╔══██╗██╔════╝
 ██║     ███████║██████╔╝███████╗
 ██║     ██╔══██║██╔═══╝ ╚════██║
 ╚██████╗██║  ██║██║     ███████║
  ╚═════╝╚═╝  ╚═╝╚═╝     ╚══════╝
  PLATFORM — Full Server Bootstrap v2.0.0
BANNER
  echo -e "${NC}"
  echo -e "  ${YELLOW}This script will install and configure everything CAPS Platform needs."
  echo -e "  It is safe to re-run — already-completed steps are skipped.${NC}\n"
}

# =============================================================================
# PHASE 0 — Prerequisites
# =============================================================================
install_prerequisites() {
  is_done "prerequisites" && { done_ "Prerequisites already installed"; return; }
  header "Phase 0 — Installing Prerequisites"

  apt-get update -qq
  apt-get install -y -qq \
    curl wget git jq unzip gnupg lsb-release ca-certificates \
    apt-transport-https software-properties-common \
    openssl bc netcat-openbsd postgresql-client \
    2>&1 | tee -a "$LOG_FILE"

  mark_done "prerequisites"
  done_ "Prerequisites installed"
}

# =============================================================================
# PHASE 1 — Interactive Configuration
# =============================================================================
gather_config() {
  is_done "config" && { info "Config already gathered — loading from $ENV_FILE"; source "$ENV_FILE" 2>/dev/null || true; return; }
  header "Phase 1 — Platform Configuration"

  echo -e "${YELLOW}  Please answer the following questions to configure your CAPS Platform.${NC}"
  echo -e "${YELLOW}  Press Enter to accept defaults shown in [brackets].${NC}\n"

  # ── Server basics ──────────────────────────────────────────────────────────
  info "── Server & Domain ──"
  ask "Server hostname / domain (e.g. caps.company.com)" DOMAIN "$(hostname -f 2>/dev/null || echo 'caps.local')"
  ask "Admin email address" ADMIN_EMAIL "admin@${DOMAIN}"
  ask "Platform name (shown in UI)" PLATFORM_NAME "CAPS Platform"

  # ── Generate passwords ─────────────────────────────────────────────────────
  POSTGRES_PASSWORD="$(gen_password)"
  MONGO_PASSWORD="$(gen_password)"
  REDIS_PASSWORD="$(gen_password)"
  MINIO_SECRET_KEY="$(gen_password)"
  JWT_SECRET="$(gen_secret)"
  CAPS_WEBHOOK_SECRET="$(gen_secret)"
  MINIO_ACCESS_KEY="capsadmin"

  # ── ArgoCD ────────────────────────────────────────────────────────────────
  info "\n── ArgoCD GitOps ──"
  ask_yn "Install ArgoCD for GitOps deployments?" INSTALL_ARGOCD "y"
  if [[ "$INSTALL_ARGOCD" =~ ^[Yy] ]]; then
    ARGOCD_PASSWORD="$(gen_password)"
    log "  ArgoCD admin password: ${BOLD}$ARGOCD_PASSWORD${NC} (saved to $ENV_FILE)"
  fi

  # ── Monitoring ────────────────────────────────────────────────────────────
  info "\n── Monitoring ──"
  ask_yn "Install Grafana + Prometheus + Loki?" INSTALL_MONITORING "y"
  if [[ "$INSTALL_MONITORING" =~ ^[Yy] ]]; then
    GRAFANA_PASSWORD="$(gen_password)"
    log "  Grafana admin password: ${BOLD}$GRAFANA_PASSWORD${NC} (saved to $ENV_FILE)"
  fi

  # ── Portainer ─────────────────────────────────────────────────────────────
  ask_yn "Install Portainer (container management UI)?" INSTALL_PORTAINER "y"

  # ── Infisical ─────────────────────────────────────────────────────────────
  info "\n── Infisical (Secret Management) ──"
  ask_yn "Install Infisical (self-hosted secret management)?" INSTALL_INFISICAL "y"

  # ── SSL / Ingress ─────────────────────────────────────────────────────────
  info "\n── SSL & Ingress ──"
  ask_yn "Install cert-manager + Let's Encrypt for HTTPS?" INSTALL_CERTMANAGER "y"
  if [[ "$INSTALL_CERTMANAGER" =~ ^[Yy] ]]; then
    ask "Your email for Let's Encrypt certificates" LE_EMAIL "$ADMIN_EMAIL"
  fi

  # ── Write env ─────────────────────────────────────────────────────────────
  rm -f "$ENV_FILE"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  write_env "CAPS_VERSION" "$CAPS_VERSION"
  write_env "DOMAIN" "$DOMAIN"
  write_env "ADMIN_EMAIL" "$ADMIN_EMAIL"
  write_env "PLATFORM_NAME" "$PLATFORM_NAME"
  write_env "POSTGRES_PASSWORD" "$POSTGRES_PASSWORD"
  write_env "MONGO_PASSWORD" "$MONGO_PASSWORD"
  write_env "REDIS_PASSWORD" "$REDIS_PASSWORD"
  write_env "MINIO_ACCESS_KEY" "$MINIO_ACCESS_KEY"
  write_env "MINIO_SECRET_KEY" "$MINIO_SECRET_KEY"
  write_env "JWT_SECRET" "$JWT_SECRET"
  write_env "CAPS_WEBHOOK_SECRET" "$CAPS_WEBHOOK_SECRET"
  write_env "ARGOCD_PASSWORD" "${ARGOCD_PASSWORD:-}"
  write_env "GRAFANA_PASSWORD" "${GRAFANA_PASSWORD:-}"
  write_env "INSTALL_ARGOCD" "${INSTALL_ARGOCD:-y}"
  write_env "INSTALL_MONITORING" "${INSTALL_MONITORING:-y}"
  write_env "INSTALL_PORTAINER" "${INSTALL_PORTAINER:-y}"
  write_env "INSTALL_INFISICAL" "${INSTALL_INFISICAL:-y}"
  write_env "INSTALL_CERTMANAGER" "${INSTALL_CERTMANAGER:-y}"
  write_env "LE_EMAIL" "${LE_EMAIL:-$ADMIN_EMAIL}"

  mark_done "config"
  done_ "Configuration saved to $ENV_FILE"
}

# =============================================================================
# PHASE 2 — Integrations Menu
# =============================================================================
gather_integrations() {
  is_done "integrations" && { info "Integrations already configured"; source "$ENV_FILE" 2>/dev/null || true; return; }
  header "Phase 2 — Integrations Setup"

  echo -e "${YELLOW}  Configure third-party integrations. Press Enter to skip any optional item.${NC}\n"
  source "$ENV_FILE"

  # ── GitHub ────────────────────────────────────────────────────────────────
  info "── GitHub Integration ──"
  ask_yn "Configure GitHub integration?" SETUP_GITHUB "y"
  if [[ "$SETUP_GITHUB" =~ ^[Yy] ]]; then
    ask "GitHub Personal Access Token (scopes: repo, admin:org_hook, write:packages)" GITHUB_TOKEN ""
    ask "GitHub Organization or username (e.g. my-org)" GITHUB_ORG ""
    ask "GitHub Container Registry (ghcr.io or docker.io)" GITHUB_REGISTRY "ghcr.io"
    if [[ -n "$GITHUB_TOKEN" ]]; then
      write_env "GITHUB_TOKEN" "$GITHUB_TOKEN"
      write_env "GITHUB_ORG" "$GITHUB_ORG"
      write_env "GITHUB_REGISTRY" "$GITHUB_REGISTRY"
      done_ "GitHub configured (webhook: https://$DOMAIN/api/webhooks/github)"
    else
      warn "GitHub token not provided — integration skipped"
    fi
  fi

  # ── GitLab ────────────────────────────────────────────────────────────────
  info "\n── GitLab Integration ──"
  ask_yn "Configure GitLab integration?" SETUP_GITLAB "n"
  if [[ "$SETUP_GITLAB" =~ ^[Yy] ]]; then
    ask "GitLab instance URL" GITLAB_URL "https://gitlab.com"
    ask "GitLab Personal Access Token (scopes: api, read_repository)" GITLAB_TOKEN ""
    ask "GitLab Group ID or username" GITLAB_GROUP ""
    if [[ -n "$GITLAB_TOKEN" ]]; then
      write_env "GITLAB_URL" "$GITLAB_URL"
      write_env "GITLAB_TOKEN" "$GITLAB_TOKEN"
      write_env "GITLAB_GROUP" "$GITLAB_GROUP"
      done_ "GitLab configured (webhook: https://$DOMAIN/api/webhooks/gitlab)"
    else
      warn "GitLab token not provided — integration skipped"
    fi
  fi

  # ── ClickUp ───────────────────────────────────────────────────────────────
  info "\n── ClickUp Integration ──"
  ask_yn "Configure ClickUp integration (for task linking + bug reports)?" SETUP_CLICKUP "y"
  if [[ "$SETUP_CLICKUP" =~ ^[Yy] ]]; then
    ask "ClickUp API Token (User Settings → Apps → Generate)" CLICKUP_API_TOKEN ""
    ask "ClickUp Team ID (from workspace URL: app.clickup.com/XXXXX/...)" CLICKUP_TEAM_ID ""
    ask "Default ClickUp List ID for bug reports" CLICKUP_DEFAULT_LIST_ID ""
    if [[ -n "$CLICKUP_API_TOKEN" ]]; then
      write_env "CLICKUP_API_TOKEN" "$CLICKUP_API_TOKEN"
      write_env "CLICKUP_TEAM_ID" "$CLICKUP_TEAM_ID"
      write_env "CLICKUP_DEFAULT_LIST_ID" "$CLICKUP_DEFAULT_LIST_ID"
      done_ "ClickUp configured"
    else
      warn "ClickUp token not provided — integration skipped"
    fi
  fi

  # ── SMTP ──────────────────────────────────────────────────────────────────
  info "\n── SMTP / Email Notifications ──"
  ask_yn "Configure SMTP for deployment notifications?" SETUP_SMTP "y"
  if [[ "$SETUP_SMTP" =~ ^[Yy] ]]; then
    echo -e "  ${CYAN}Provider options:${NC} 1) Custom SMTP  2) AWS SES  3) SendGrid  4) Mailgun"
    ask "Choose provider [1-4]" SMTP_PROVIDER_CHOICE "1"
    case "$SMTP_PROVIDER_CHOICE" in
      1)
        ask "SMTP Host" SMTP_HOST ""
        ask "SMTP Port" SMTP_PORT "587"
        ask "SMTP Username" SMTP_USER ""
        ask_secret "SMTP Password" SMTP_PASS
        write_env "SMTP_PROVIDER" "custom"
        write_env "SMTP_HOST" "$SMTP_HOST"
        write_env "SMTP_PORT" "$SMTP_PORT"
        write_env "SMTP_USER" "$SMTP_USER"
        write_env "SMTP_PASS" "$SMTP_PASS"
        ;;
      2)
        ask "AWS Region (e.g. us-east-1)" SMTP_AWS_REGION "us-east-1"
        ask "AWS Access Key ID" SMTP_AWS_KEY ""
        ask_secret "AWS Secret Access Key" SMTP_AWS_SECRET
        write_env "SMTP_PROVIDER" "ses"
        write_env "SMTP_AWS_REGION" "$SMTP_AWS_REGION"
        write_env "SMTP_AWS_KEY" "$SMTP_AWS_KEY"
        write_env "SMTP_AWS_SECRET" "$SMTP_AWS_SECRET"
        ;;
      3)
        ask_secret "SendGrid API Key (sg.xxxx...)" SENDGRID_API_KEY
        write_env "SMTP_PROVIDER" "sendgrid"
        write_env "SENDGRID_API_KEY" "$SENDGRID_API_KEY"
        ;;
      4)
        ask "Mailgun Domain" MAILGUN_DOMAIN ""
        ask_secret "Mailgun API Key" MAILGUN_API_KEY
        write_env "SMTP_PROVIDER" "mailgun"
        write_env "MAILGUN_DOMAIN" "$MAILGUN_DOMAIN"
        write_env "MAILGUN_API_KEY" "$MAILGUN_API_KEY"
        ;;
    esac
    ask "From email address" SMTP_FROM_EMAIL "noreply@$DOMAIN"
    ask "From display name" SMTP_FROM_NAME "$PLATFORM_NAME"
    write_env "SMTP_FROM_EMAIL" "$SMTP_FROM_EMAIL"
    write_env "SMTP_FROM_NAME" "$SMTP_FROM_NAME"
    done_ "SMTP configured"
  fi

  # ── MinIO / Storage ───────────────────────────────────────────────────────
  info "\n── Backup Storage ──"
  ask_yn "Use external S3-compatible storage for backups? (or use bundled MinIO)" SETUP_EXTERNAL_S3 "n"
  if [[ "$SETUP_EXTERNAL_S3" =~ ^[Yy] ]]; then
    ask "S3 Endpoint URL (e.g. https://s3.us-east-1.amazonaws.com)" EXT_S3_ENDPOINT "https://s3.amazonaws.com"
    ask "S3 Bucket Name" EXT_S3_BUCKET "caps-backups"
    ask "S3 Access Key ID" EXT_S3_KEY ""
    ask_secret "S3 Secret Access Key" EXT_S3_SECRET
    ask "S3 Region" EXT_S3_REGION "us-east-1"
    write_env "EXT_S3_ENDPOINT" "$EXT_S3_ENDPOINT"
    write_env "EXT_S3_BUCKET" "$EXT_S3_BUCKET"
    write_env "EXT_S3_KEY" "$EXT_S3_KEY"
    write_env "EXT_S3_SECRET" "$EXT_S3_SECRET"
    write_env "EXT_S3_REGION" "$EXT_S3_REGION"
    done_ "External S3 configured"
  else
    info "Using bundled MinIO for backups (configured automatically)"
  fi

  mark_done "integrations"
  done_ "All integrations configured"
}

# =============================================================================
# PHASE 3 — Docker
# =============================================================================
install_docker() {
  is_done "docker" && { done_ "Docker already installed"; return; }
  header "Phase 3 — Docker"

  if command -v docker >/dev/null 2>&1; then
    done_ "Docker already installed: $(docker --version)"
  else
    log "Installing Docker CE..."
    curl -fsSL https://get.docker.com | sh 2>&1 | tee -a "$LOG_FILE"
    usermod -aG docker "${SUDO_USER:-root}" || true
    systemctl enable --now docker
    done_ "Docker installed: $(docker --version)"
  fi
  mark_done "docker"
}

# =============================================================================
# PHASE 4 — Kubernetes (k3s)
# =============================================================================
install_kubernetes() {
  if [[ "$SKIP_K8S" == "true" ]]; then
    warn "Skipping Kubernetes installation (SKIP_K8S=true)"
    return
  fi
  is_done "k3s" && { done_ "k3s already installed"; return; }
  header "Phase 4 — Kubernetes (k3s)"

  if command -v kubectl >/dev/null 2>&1 && kubectl cluster-info >/dev/null 2>&1; then
    done_ "Kubernetes already running: $(kubectl version --client --short 2>/dev/null || true)"
  else
    log "Installing k3s (lightweight Kubernetes)..."
    curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh - 2>&1 | tee -a "$LOG_FILE"
    # Wait for k3s to be ready
    for i in {1..30}; do
      kubectl get nodes >/dev/null 2>&1 && break
      sleep 2
    done
    mkdir -p /root/.kube
    cp /etc/rancher/k3s/k3s.yaml /root/.kube/config
    chmod 600 /root/.kube/config
    export KUBECONFIG=/root/.kube/config
    if [[ -n "${SUDO_USER:-}" ]]; then
      mkdir -p "/home/$SUDO_USER/.kube"
      cp /etc/rancher/k3s/k3s.yaml "/home/$SUDO_USER/.kube/config"
      chown "$SUDO_USER:$SUDO_USER" "/home/$SUDO_USER/.kube/config"
      chmod 600 "/home/$SUDO_USER/.kube/config"
    fi
    done_ "k3s installed and running"
  fi
  mark_done "k3s"
}

# =============================================================================
# PHASE 5 — Helm
# =============================================================================
install_helm() {
  is_done "helm" && { done_ "Helm already installed"; return; }
  header "Phase 5 — Helm"

  if command -v helm >/dev/null 2>&1; then
    done_ "Helm already installed: $(helm version --short)"
  else
    log "Installing Helm..."
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash 2>&1 | tee -a "$LOG_FILE"
    done_ "Helm installed: $(helm version --short)"
  fi

  # Add commonly needed repos
  helm repo add bitnami    https://charts.bitnami.com/bitnami 2>/dev/null || true
  helm repo add grafana    https://grafana.github.io/helm-charts 2>/dev/null || true
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
  helm repo add argo       https://argoproj.github.io/argo-helm 2>/dev/null || true
  helm repo add portainer  https://portainer.github.io/k8s/ 2>/dev/null || true
  helm repo add cert-manager https://charts.jetstack.io 2>/dev/null || true
  helm repo update 2>&1 | tee -a "$LOG_FILE"
  mark_done "helm"
}

# =============================================================================
# PHASE 6 — Namespaces & RBAC
# =============================================================================
setup_namespaces() {
  is_done "namespaces" && { done_ "Namespaces already created"; return; }
  header "Phase 6 — Kubernetes Namespaces"

  for ns in caps-platform databases monitoring storage argocd portainer infisical cert-manager ingress-nginx; do
    kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - 2>&1 | tee -a "$LOG_FILE"
    done_ "Namespace: $ns"
  done

  mark_done "namespaces"
}

# =============================================================================
# PHASE 7 — Ingress Controller (nginx)
# =============================================================================
install_ingress() {
  is_done "ingress" && { done_ "Ingress already installed"; return; }
  header "Phase 7 — Ingress Controller (nginx)"

  if helm list -n ingress-nginx 2>/dev/null | grep -q ingress-nginx; then
    done_ "ingress-nginx already installed"
  else
    helm install ingress-nginx ingress-nginx/ingress-nginx \
      --namespace ingress-nginx \
      --set controller.service.type=LoadBalancer \
      --wait 2>&1 | tee -a "$LOG_FILE" || \
    kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.10.1/deploy/static/provider/cloud/deploy.yaml 2>&1 | tee -a "$LOG_FILE"
    # Add nginx ingress repo if not present
    helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx 2>/dev/null || true
    helm repo update 2>/dev/null || true
    done_ "ingress-nginx installed"
  fi
  mark_done "ingress"
}

# =============================================================================
# PHASE 8 — cert-manager + Let's Encrypt
# =============================================================================
install_certmanager() {
  source "$ENV_FILE"
  [[ "$INSTALL_CERTMANAGER" =~ ^[Yy] ]] || { info "Skipping cert-manager (not selected)"; return; }
  is_done "certmanager" && { done_ "cert-manager already installed"; return; }
  header "Phase 8 — cert-manager (Let's Encrypt TLS)"

  helm install cert-manager cert-manager/cert-manager \
    --namespace cert-manager \
    --set installCRDs=true \
    --wait 2>&1 | tee -a "$LOG_FILE"

  # Create ClusterIssuer for Let's Encrypt
  kubectl apply -f - <<EOF
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
EOF
  mark_done "certmanager"
  done_ "cert-manager installed with ClusterIssuers (prod + staging)"
}

# =============================================================================
# PHASE 9 — Databases (PostgreSQL, MongoDB, Redis)
# =============================================================================
install_databases() {
  source "$ENV_FILE"
  is_done "databases" && { done_ "Databases already installed"; return; }
  header "Phase 9 — Databases"

  # PostgreSQL
  if ! helm list -n databases 2>/dev/null | grep -q postgresql; then
    log "Installing PostgreSQL..."
    helm install postgresql bitnami/postgresql \
      --namespace databases \
      --set auth.postgresPassword="$POSTGRES_PASSWORD" \
      --set auth.database=caps_platform \
      --set primary.persistence.size=20Gi \
      --wait 2>&1 | tee -a "$LOG_FILE"
    done_ "PostgreSQL installed"
  else
    done_ "PostgreSQL already running"
  fi

  # MongoDB
  if ! helm list -n databases 2>/dev/null | grep -q mongodb; then
    log "Installing MongoDB..."
    helm install mongodb bitnami/mongodb \
      --namespace databases \
      --set auth.rootPassword="$MONGO_PASSWORD" \
      --set persistence.size=20Gi \
      --wait 2>&1 | tee -a "$LOG_FILE"
    done_ "MongoDB installed"
  else
    done_ "MongoDB already running"
  fi

  # Redis
  if ! helm list -n databases 2>/dev/null | grep -q redis; then
    log "Installing Redis..."
    helm install redis bitnami/redis \
      --namespace databases \
      --set auth.password="$REDIS_PASSWORD" \
      --set replica.replicaCount=1 \
      --wait 2>&1 | tee -a "$LOG_FILE"
    done_ "Redis installed"
  else
    done_ "Redis already running"
  fi

  mark_done "databases"
}

# =============================================================================
# PHASE 10 — MinIO (Object Storage for Backups)
# =============================================================================
install_minio() {
  source "$ENV_FILE"
  is_done "minio" && { done_ "MinIO already installed"; return; }
  header "Phase 10 — MinIO (Object Storage)"

  if ! helm list -n storage 2>/dev/null | grep -q minio; then
    log "Interpolating MinIO configuration templates..."
    sed "s/{{DOMAIN}}/$DOMAIN/g" manifests/minio-values.yaml > /tmp/minio-values.yaml

    log "Installing MinIO..."
    helm install minio bitnami/minio \
      --namespace storage \
      -f /tmp/minio-values.yaml \
      --set auth.rootUser="$MINIO_ACCESS_KEY" \
      --set auth.rootPassword="$MINIO_SECRET_KEY" \
      --set persistence.size=50Gi \
      --set image.repository=bitnamilegacy/minio \
      --set console.image.repository=bitnamilegacy/minio-object-browser \
      --set defaultBuckets="caps-backups\,caps-logs" \
      --wait 2>&1 | tee -a "$LOG_FILE"
    done_ "MinIO installed (bucket: caps-backups)"
  else
    done_ "MinIO already running"
  fi

  mark_done "minio"
}

# =============================================================================
# PHASE 11 — ArgoCD
# =============================================================================
install_argocd() {
  source "$ENV_FILE"
  [[ "$INSTALL_ARGOCD" =~ ^[Yy] ]] || { info "Skipping ArgoCD (not selected)"; return; }
  is_done "argocd" && { done_ "ArgoCD already installed"; return; }
  header "Phase 11 — ArgoCD (GitOps)"

  if ! kubectl get deployment -n argocd argocd-server >/dev/null 2>&1; then
    log "Interpolating ArgoCD configuration templates..."
    sed "s/{{DOMAIN}}/$DOMAIN/g" manifests/argocd-values.yaml > /tmp/argocd-values.yaml

    log "Installing ArgoCD..."
    helm install argocd argo/argo-cd \
      --namespace argocd \
      -f /tmp/argocd-values.yaml \
      --set configs.secret.argocdServerAdminPassword="$(echo -n "$ARGOCD_PASSWORD" | bcrypt-hash 2>/dev/null || htpasswd -bnBC 10 "" "$ARGOCD_PASSWORD" | tr -d ':\n')" \
      --wait 2>&1 | tee -a "$LOG_FILE" || {
      # Fallback: apply official manifests
      kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
      kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
      log "Waiting for ArgoCD to be ready..."
      kubectl wait --for=condition=Available deployment --all -n argocd --timeout=300s 2>&1 | tee -a "$LOG_FILE" || true
      # Set admin password
      ARGOCD_ADMIN_HASH="$(echo -n "$ARGOCD_PASSWORD" | htpasswd -bnBC 10 "" - 2>/dev/null | tr -d ':\n' || echo "$ARGOCD_PASSWORD")"
      kubectl -n argocd patch secret argocd-secret \
        -p "{\"stringData\": {\"admin.password\": \"$ARGOCD_ADMIN_HASH\", \"admin.passwordMtime\": \"$(date +%FT%T%Z)\"}}" 2>&1 | tee -a "$LOG_FILE" || true
      done_ "ArgoCD installed via manifests"
    }
  else
    done_ "ArgoCD already running"
  fi

  mark_done "argocd"
}

# =============================================================================
# PHASE 12 — Grafana + Prometheus + Loki
# =============================================================================
install_monitoring() {
  source "$ENV_FILE"
  [[ "$INSTALL_MONITORING" =~ ^[Yy] ]] || { info "Skipping monitoring stack (not selected)"; return; }
  is_done "monitoring" && { done_ "Monitoring already installed"; return; }
  header "Phase 12 — Monitoring (Grafana + Prometheus + Loki)"

  if ! helm list -n monitoring 2>/dev/null | grep -q kube-prometheus; then
    log "Interpolating Grafana configuration templates..."
    sed "s/{{DOMAIN}}/$DOMAIN/g" manifests/grafana-values.yaml > /tmp/grafana-values.yaml

    log "Installing Prometheus + Grafana stack..."
    helm install kube-prometheus prometheus-community/kube-prometheus-stack \
      --namespace monitoring \
      -f /tmp/grafana-values.yaml \
      --set grafana.adminPassword="$GRAFANA_PASSWORD" \
      --set prometheus.prometheusSpec.retention=30d \
      --wait --timeout=600s 2>&1 | tee -a "$LOG_FILE"
    done_ "Prometheus + Grafana installed"
  else
    done_ "Prometheus stack already running"
  fi

  # Loki
  if ! helm list -n monitoring 2>/dev/null | grep -q loki; then
    log "Installing Loki (log aggregation)..."
    helm install loki grafana/loki-stack \
      --namespace monitoring \
      --set grafana.enabled=false \
      --set prometheus.enabled=false \
      --set loki.persistence.enabled=true \
      --set loki.persistence.size=20Gi \
      --wait 2>&1 | tee -a "$LOG_FILE"
    done_ "Loki installed"
  else
    done_ "Loki already running"
  fi

  # Add Loki as Grafana datasource
  log "Configuring Loki datasource in Grafana..."
  kubectl apply -n monitoring -f - <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-loki-datasource
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
EOF
  mark_done "monitoring"
}

# =============================================================================
# PHASE 13 — Portainer
# =============================================================================
install_portainer() {
  source "$ENV_FILE"
  [[ "$INSTALL_PORTAINER" =~ ^[Yy] ]] || { info "Skipping Portainer (not selected)"; return; }
  is_done "portainer" && { done_ "Portainer already installed"; return; }
  header "Phase 13 — Portainer (Container Management)"

  if ! helm list -n portainer 2>/dev/null | grep -q portainer; then
    log "Interpolating Portainer configuration templates..."
    sed "s/{{DOMAIN}}/$DOMAIN/g" manifests/portainer-values.yaml > /tmp/portainer-values.yaml

    log "Installing Portainer..."
    helm install portainer portainer/portainer \
      --namespace portainer \
      -f /tmp/portainer-values.yaml \
      --set service.type=ClusterIP \
      --wait 2>&1 | tee -a "$LOG_FILE"
    done_ "Portainer installed"
  else
    done_ "Portainer already running"
  fi
  mark_done "portainer"
}

# =============================================================================
# PHASE 14 — Infisical
# =============================================================================
install_infisical() {
  source "$ENV_FILE"
  [[ "$INSTALL_INFISICAL" =~ ^[Yy] ]] || { info "Skipping Infisical (not selected)"; return; }
  is_done "infisical" && { done_ "Infisical already installed"; return; }
  header "Phase 14 — Infisical (Secret Management)"

  if ! kubectl get deployment -n infisical infisical >/dev/null 2>&1; then
    log "Deploying Infisical..."
    INFISICAL_ENCRYPTION_KEY="$(gen_secret)"
    INFISICAL_JWT_SECRET="$(gen_secret)"
    write_env "INFISICAL_ENCRYPTION_KEY" "$INFISICAL_ENCRYPTION_KEY"
    write_env "INFISICAL_JWT_SECRET" "$INFISICAL_JWT_SECRET"

    kubectl create secret generic infisical-secrets \
      --namespace infisical \
      --from-literal=ENCRYPTION_KEY="$INFISICAL_ENCRYPTION_KEY" \
      --from-literal=JWT_AUTH_SECRET="$INFISICAL_JWT_SECRET" \
      --from-literal=MONGO_URL="mongodb://root:$MONGO_PASSWORD@mongodb.databases:27017/infisical?authSource=admin" \
      --dry-run=client -o yaml | kubectl apply -f - 2>&1 | tee -a "$LOG_FILE"

    log "Interpolating Infisical configuration templates..."
    sed "s/{{DOMAIN}}/$DOMAIN/g" manifests/infisical.yaml > /tmp/infisical.yaml

    kubectl apply -f /tmp/infisical.yaml 2>&1 | tee -a "$LOG_FILE"
    done_ "Infisical installed"
  else
    done_ "Infisical already running"
  fi
  mark_done "infisical"
}

# =============================================================================
# PHASE 15 — CAPS Platform
# =============================================================================
deploy_caps_platform() {
  source "$ENV_FILE"
  is_done "caps-platform" && { done_ "CAPS Platform already deployed"; return; }
  header "Phase 15 — CAPS Platform"

  log "Building CAPS Platform environment config..."

  # Combine all env vars into a K8s secret
  kubectl create secret generic caps-platform-env \
    --namespace caps-platform \
    --from-literal=NODE_ENV=production \
    --from-literal=PORT=3000 \
    --from-literal=JWT_SECRET="$JWT_SECRET" \
    --from-literal=CAPS_WEBHOOK_SECRET="$CAPS_WEBHOOK_SECRET" \
    --from-literal=POSTGRES_HOST="postgresql.databases" \
    --from-literal=POSTGRES_PORT=5432 \
    --from-literal=POSTGRES_DB=caps_platform \
    --from-literal=POSTGRES_USER=postgres \
    --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    --from-literal=MONGODB_URI="mongodb://root:$MONGO_PASSWORD@mongodb.databases:27017/caps_platform?authSource=admin" \
    --from-literal=REDIS_HOST="redis-master.databases" \
    --from-literal=REDIS_PORT=6379 \
    --from-literal=REDIS_PASSWORD="$REDIS_PASSWORD" \
    --from-literal=MINIO_ENDPOINT="http://minio.storage:9000" \
    --from-literal=MINIO_ACCESS_KEY="$MINIO_ACCESS_KEY" \
    --from-literal=MINIO_SECRET_KEY="$MINIO_SECRET_KEY" \
    --from-literal=GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
    --from-literal=GITHUB_ORG="${GITHUB_ORG:-}" \
    --from-literal=GITHUB_WEBHOOK_SECRET="$CAPS_WEBHOOK_SECRET" \
    --from-literal=GITLAB_URL="${GITLAB_URL:-https://gitlab.com}" \
    --from-literal=GITLAB_TOKEN="${GITLAB_TOKEN:-}" \
    --from-literal=GITLAB_WEBHOOK_SECRET="$CAPS_WEBHOOK_SECRET" \
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
    --from-literal=SMTP_FROM_NAME="${SMTP_FROM_NAME:-CAPS Platform}" \
    --from-literal=PLATFORM_NAME="$PLATFORM_NAME" \
    --from-literal=DOMAIN="$DOMAIN" \
    --dry-run=client -o yaml | kubectl apply -f - 2>&1 | tee -a "$LOG_FILE"

  # Deploy CAPS API + Portal
  kubectl apply -n caps-platform -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: caps-api
  namespace: caps-platform
  labels:
    app: caps-api
    version: "${CAPS_IMAGE_TAG}"
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
        image: ${CAPS_REPO_URL:-ghcr.io/your-org/caps-platform-api}:${CAPS_IMAGE_TAG}
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 3000
        envFrom:
        - secretRef:
            name: caps-platform-env
        readinessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 15
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 20
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
---
apiVersion: v1
kind: Service
metadata:
  name: caps-api
  namespace: caps-platform
spec:
  selector:
    app: caps-api
  ports:
  - name: http
    port: 3000
    targetPort: 3000
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: caps-portal
  namespace: caps-platform
  labels:
    app: caps-portal
spec:
  replicas: 1
  selector:
    matchLabels:
      app: caps-portal
  template:
    metadata:
      labels:
        app: caps-portal
    spec:
      containers:
      - name: portal
        image: ${CAPS_REPO_URL:-ghcr.io/your-org/caps-platform-portal}:${CAPS_IMAGE_TAG}
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 80
        resources:
          requests:
            memory: "64Mi"
            cpu: "50m"
          limits:
            memory: "256Mi"
            cpu: "200m"
---
apiVersion: v1
kind: Service
metadata:
  name: caps-portal
  namespace: caps-platform
spec:
  selector:
    app: caps-portal
  ports:
  - name: http
    port: 80
    targetPort: 80
---
# Deploy Cross-Namespace Proxy Services (ExternalName)
apiVersion: v1
kind: Service
metadata:
  name: argocd-proxy
  namespace: caps-platform
spec:
  type: ExternalName
  externalName: argocd-server.argocd.svc.cluster.local
---
apiVersion: v1
kind: Service
metadata:
  name: grafana-proxy
  namespace: caps-platform
spec:
  type: ExternalName
  externalName: kube-prometheus-grafana.monitoring.svc.cluster.local
---
apiVersion: v1
kind: Service
metadata:
  name: portainer-proxy
  namespace: caps-platform
spec:
  type: ExternalName
  externalName: portainer.portainer.svc.cluster.local
---
apiVersion: v1
kind: Service
metadata:
  name: infisical-proxy
  namespace: caps-platform
spec:
  type: ExternalName
  externalName: infisical.infisical.svc.cluster.local
---
apiVersion: v1
kind: Service
metadata:
  name: minio-proxy
  namespace: caps-platform
spec:
  type: ExternalName
  externalName: minio.storage.svc.cluster.local
---
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
    - $DOMAIN
    - api.$DOMAIN
    secretName: caps-platform-tls
  rules:
  - host: $DOMAIN
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
      - path: /portainer
        pathType: Prefix
        backend:
          service:
            name: portainer-proxy
            port:
              number: 9000
      - path: /infisical
        pathType: Prefix
        backend:
          service:
            name: infisical-proxy
            port:
              number: 8080
      - path: /minio
        pathType: Prefix
        backend:
          service:
            name: minio-proxy
            port:
              number: 9001
      - path: /
        pathType: Prefix
        backend:
          service:
            name: caps-portal
            port:
              number: 80
EOF

  log "Waiting for CAPS Platform to become ready..."
  kubectl wait --for=condition=Available deployment/caps-api \
    -n caps-platform --timeout=300s 2>&1 | tee -a "$LOG_FILE" || \
    warn "CAPS API not ready within timeout — check: kubectl get pods -n caps-platform"

  mark_done "caps-platform"
  done_ "CAPS Platform deployed"
}

# =============================================================================
# PHASE 16 — ArgoCD Application for CAPS (GitOps)
# =============================================================================
setup_argocd_app() {
  source "$ENV_FILE"
  [[ "$INSTALL_ARGOCD" =~ ^[Yy] ]] || return
  is_done "argocd-app" && { done_ "ArgoCD app already configured"; return; }
  [[ -z "${GITHUB_TOKEN:-}" && -z "${GITLAB_TOKEN:-}" ]] && { info "No Git token — skipping ArgoCD app setup"; return; }

  header "Phase 16 — ArgoCD Application Setup"

  REPO_URL="${CAPS_REPO_URL:-}"
  [[ -z "$REPO_URL" ]] && { info "CAPS_REPO_URL not set — skipping ArgoCD app"; return; }

  kubectl apply -n argocd -f - <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: caps-platform
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: $REPO_URL
    targetRevision: HEAD
    path: k8s/overlays/production
  destination:
    server: https://kubernetes.default.svc
    namespace: caps-platform
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
EOF
  mark_done "argocd-app"
  done_ "ArgoCD GitOps app created — will auto-sync from $REPO_URL"
}

# =============================================================================
# PHASE 17 — First-Run Seed (Admin user + SMTP + Integrations → CAPS API)
# =============================================================================
seed_caps_platform() {
  source "$ENV_FILE"
  is_done "seed" && { done_ "Platform already seeded"; return; }
  header "Phase 17 — Seeding Platform (Admin User + Integrations)"

  # Wait for API to be fully ready
  CAPS_API_URL="http://caps-api.caps-platform.svc.cluster.local:3000"
  log "Waiting for CAPS API to respond at $CAPS_API_URL..."
  for i in {1..30}; do
    if curl -sf "$CAPS_API_URL/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 5
  done

  # Build SMTP payload conditionally
  SMTP_PAYLOAD=""
  if [[ -n "${SMTP_PROVIDER:-}" ]]; then
    if [[ "$SMTP_PROVIDER" == "custom" ]]; then
      SMTP_PAYLOAD="{\"name\":\"Bootstrap SMTP\",\"provider\":\"custom\",\"host\":\"${SMTP_HOST:-}\",\"port\":${SMTP_PORT:-587},\"secure\":false,\"username\":\"${SMTP_USER:-}\",\"password\":\"${SMTP_PASS:-}\",\"fromEmail\":\"${SMTP_FROM_EMAIL:-}\",\"fromName\":\"${SMTP_FROM_NAME:-}\",\"isDefault\":true}"
    elif [[ "$SMTP_PROVIDER" == "ses" ]]; then
      SMTP_PAYLOAD="{\"name\":\"Bootstrap SES\",\"provider\":\"ses\",\"host\":\"${SMTP_AWS_REGION:-us-east-1}\",\"username\":\"${SMTP_AWS_KEY:-}\",\"password\":\"${SMTP_AWS_SECRET:-}\",\"fromEmail\":\"${SMTP_FROM_EMAIL:-}\",\"fromName\":\"${SMTP_FROM_NAME:-}\",\"isDefault\":true}"
    elif [[ "$SMTP_PROVIDER" == "sendgrid" ]]; then
      SMTP_PAYLOAD="{\"name\":\"Bootstrap SendGrid\",\"provider\":\"sendgrid\",\"apiKey\":\"${SENDGRID_API_KEY:-}\",\"fromEmail\":\"${SMTP_FROM_EMAIL:-}\",\"fromName\":\"${SMTP_FROM_NAME:-}\",\"isDefault\":true}"
    elif [[ "$SMTP_PROVIDER" == "mailgun" ]]; then
      SMTP_PAYLOAD="{\"name\":\"Bootstrap Mailgun\",\"provider\":\"mailgun\",\"username\":\"${MAILGUN_DOMAIN:-}\",\"apiKey\":\"${MAILGUN_API_KEY:-}\",\"fromEmail\":\"${SMTP_FROM_EMAIL:-}\",\"fromName\":\"${SMTP_FROM_NAME:-}\",\"isDefault\":true}"
    fi
  fi

  # Build Storage payload conditionally
  STORAGE_PAYLOAD=""
  if [[ -n "${EXT_S3_KEY:-}" ]]; then
    STORAGE_PAYLOAD="{\"name\":\"External S3 (Bootstrap)\",\"providerType\":\"s3\",\"endpointUrl\":\"${EXT_S3_ENDPOINT:-}\",\"bucketName\":\"${EXT_S3_BUCKET:-}\",\"isDefault\":true,\"credentials\":{\"accessKeyId\":\"${EXT_S3_KEY:-}\",\"secretAccessKey\":\"${EXT_S3_SECRET:-}\",\"region\":\"${EXT_S3_REGION:-us-east-1}\"}}"
  else
    STORAGE_PAYLOAD="{\"name\":\"MinIO (bundled)\",\"providerType\":\"minio\",\"endpointUrl\":\"http://minio.storage:9000\",\"bucketName\":\"caps-backups\",\"isDefault\":true,\"credentials\":{\"accessKeyId\":\"${MINIO_ACCESS_KEY:-}\",\"secretAccessKey\":\"${MINIO_SECRET_KEY:-}\"}}"
  fi

  # Run seed via one-shot pod
  kubectl run caps-seed \
    --namespace caps-platform \
    --image=curlimages/curl:latest \
    --restart=Never \
    --env="ADMIN_EMAIL=$ADMIN_EMAIL" \
    --env="POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
    --env="SMTP_PAYLOAD=$SMTP_PAYLOAD" \
    --env="STORAGE_PAYLOAD=$STORAGE_PAYLOAD" \
    --env="CAPS_API_URL=$CAPS_API_URL" \
    --rm \
    --attach \
    --quiet \
    -- sh -c '
      echo "Seeding CAPS Platform..."
      # Register admin user
      curl -sf -X POST "$CAPS_API_URL/api/auth/register" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$POSTGRES_PASSWORD\",\"name\":\"Platform Admin\",\"role\":\"devops\"}" || true

      # Login to get Token
      TOKEN=$(curl -sf -X POST "$CAPS_API_URL/api/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$POSTGRES_PASSWORD\"}" | grep -o "\"token\":\"[^\"]*\"" | cut -d"\"" -f4 || echo "")

      if [ -n "$TOKEN" ]; then
        # Register Storage provider if payload exists
        if [ -n "$STORAGE_PAYLOAD" ]; then
          echo "Registering storage provider..."
          curl -sf -X POST "$CAPS_API_URL/api/settings/storage" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $TOKEN" \
            -d "$STORAGE_PAYLOAD" || echo "Warning: Storage provider registration failed"
        fi

        # Register SMTP if payload exists
        if [ -n "$SMTP_PAYLOAD" ]; then
          echo "Registering SMTP configuration..."
          curl -sf -X POST "$CAPS_API_URL/api/settings/smtp" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $TOKEN" \
            -d "$SMTP_PAYLOAD" || echo "Warning: SMTP registration failed"
        fi

        echo "Seed complete."
      else
        echo "Error: Failed to obtain auth token for seeding."
      fi
    ' 2>&1 | tee -a "$LOG_FILE" || warn "Seed pod failed (non-fatal, can be done via UI)"

  mark_done "seed"
  done_ "Platform seeded with admin user and default configurations"
}

# =============================================================================
# PHASE 18 — Health Check & Summary
# =============================================================================
health_check() {
  source "$ENV_FILE"
  header "Phase 18 — Health Check"

  echo
  kubectl get nodes 2>/dev/null | head -5 | tee -a "$LOG_FILE"
  echo
  echo -e "${BOLD}Namespace Status:${NC}"
  for ns in caps-platform databases monitoring storage argocd portainer infisical; do
    POD_COUNT=$(kubectl get pods -n "$ns" --field-selector=status.phase=Running 2>/dev/null | grep -c Running || echo 0)
    TOTAL=$(kubectl get pods -n "$ns" 2>/dev/null | tail -n +2 | wc -l || echo 0)
    if [[ $POD_COUNT -gt 0 ]]; then
      echo -e "  ${GREEN}✔${NC} $ns — $POD_COUNT/$TOTAL pods running"
    else
      echo -e "  ${YELLOW}⚠${NC} $ns — $POD_COUNT/$TOTAL pods running"
    fi
  done | tee -a "$LOG_FILE"
}

print_summary() {
  source "$ENV_FILE"
  header "🎉 Bootstrap Complete!"

  echo -e "${BOLD}${GREEN}"
  cat << EOF
  ╔══════════════════════════════════════════════════════════════╗
  ║           CAPS Platform — Setup Complete                     ║
  ╚══════════════════════════════════════════════════════════════╝
EOF
  echo -e "${NC}"

  echo -e "${BOLD}  🌐 Platform URLs${NC}"
  echo -e "  ┌─ Main Portal:   ${CYAN}https://$DOMAIN${NC}"
  echo -e "  ├─ API:           ${CYAN}https://$DOMAIN/api${NC}"
  [[ "$INSTALL_ARGOCD"    =~ ^[Yy] ]] && echo -e "  ├─ ArgoCD:        ${CYAN}https://argocd.$DOMAIN${NC}"
  [[ "$INSTALL_MONITORING" =~ ^[Yy] ]] && echo -e "  ├─ Grafana:       ${CYAN}https://grafana.$DOMAIN${NC}"
  [[ "$INSTALL_INFISICAL"  =~ ^[Yy] ]] && echo -e "  ├─ Infisical:     ${CYAN}https://infisical.$DOMAIN${NC}"
  [[ "$INSTALL_PORTAINER"  =~ ^[Yy] ]] && echo -e "  └─ Portainer:     ${CYAN}https://portainer.$DOMAIN${NC}"

  echo
  echo -e "${BOLD}  🔐 Credentials${NC} ${RED}(KEEP THESE SAFE — stored in $ENV_FILE)${NC}"
  echo -e "  ┌─ CAPS Admin Email:      ${YELLOW}$ADMIN_EMAIL${NC}"
  echo -e "  ├─ CAPS Admin Password:   ${YELLOW}$POSTGRES_PASSWORD${NC}"
  echo -e "  ├─ PostgreSQL Password:   ${YELLOW}$POSTGRES_PASSWORD${NC}"
  echo -e "  ├─ MongoDB Password:      ${YELLOW}$MONGO_PASSWORD${NC}"
  echo -e "  ├─ Redis Password:        ${YELLOW}$REDIS_PASSWORD${NC}"
  echo -e "  ├─ MinIO User:            ${YELLOW}$MINIO_ACCESS_KEY${NC}"
  echo -e "  ├─ MinIO Password:        ${YELLOW}$MINIO_SECRET_KEY${NC}"
  [[ "$INSTALL_ARGOCD"    =~ ^[Yy] ]] && echo -e "  ├─ ArgoCD Admin:          ${YELLOW}$ARGOCD_PASSWORD${NC}"
  [[ "$INSTALL_MONITORING" =~ ^[Yy] ]] && echo -e "  └─ Grafana Admin:         ${YELLOW}$GRAFANA_PASSWORD${NC}"

  echo
  echo -e "${BOLD}  🔗 Integrations Configured${NC}"
  [[ -n "${GITHUB_TOKEN:-}"   ]] && echo -e "  ✔  GitHub  (webhook: https://$DOMAIN/api/webhooks/github)"
  [[ -n "${GITLAB_TOKEN:-}"   ]] && echo -e "  ✔  GitLab  (webhook: https://$DOMAIN/api/webhooks/gitlab)"
  [[ -n "${CLICKUP_API_TOKEN:-}" ]] && echo -e "  ✔  ClickUp (team: ${CLICKUP_TEAM_ID:-not set})"
  [[ -n "${SMTP_PROVIDER:-}"  ]] && echo -e "  ✔  SMTP / Email ($SMTP_PROVIDER)"
  echo -e "  ✔  MinIO storage (backup target: caps-backups)"

  echo
  echo -e "${BOLD}  📋 DNS — Add these records to your DNS provider${NC}"
  SERVER_IP="$(curl -sf https://icanhazip.com 2>/dev/null || echo '<YOUR_SERVER_IP>')"
  echo -e "  $DOMAIN              A  $SERVER_IP"
  [[ "$INSTALL_ARGOCD"    =~ ^[Yy] ]] && echo -e "  argocd.$DOMAIN       A  $SERVER_IP"
  [[ "$INSTALL_MONITORING" =~ ^[Yy] ]] && echo -e "  grafana.$DOMAIN      A  $SERVER_IP"
  [[ "$INSTALL_INFISICAL"  =~ ^[Yy] ]] && echo -e "  infisical.$DOMAIN    A  $SERVER_IP"
  [[ "$INSTALL_PORTAINER"  =~ ^[Yy] ]] && echo -e "  portainer.$DOMAIN    A  $SERVER_IP"

  echo
  echo -e "${BOLD}  📁 Key Files${NC}"
  echo -e "  $ENV_FILE          — All generated secrets"
  echo -e "  $LOG_FILE  — Full bootstrap log"
  echo -e "  $STATE_FILE        — Step completion state (delete to re-run)"

  echo
  echo -e "${BOLD}  🛠  Next Steps${NC}"
  echo -e "  1. Point your DNS records above to: ${YELLOW}$SERVER_IP${NC}"
  echo -e "  2. Visit ${CYAN}https://$DOMAIN${NC} (may take 5–10 min for TLS)"
  echo -e "  3. Log in with admin email + password above"
  echo -e "  4. Go to ⚙️ Settings → Integrations to verify webhook connections"
  echo -e "  5. Create your first project and link it to a GitHub/GitLab repo"
  echo
  echo -e "${GREEN}${BOLD}  Full log: $LOG_FILE${NC}"
  echo
}

# =============================================================================
# MAIN — Orchestration
# =============================================================================
main() {
  require_root
  require_ubuntu
  print_banner

  install_prerequisites
  gather_config
  gather_integrations
  install_docker
  install_kubernetes
  install_helm
  setup_namespaces
  install_ingress
  install_certmanager
  install_databases
  install_minio
  install_argocd
  install_monitoring
  install_portainer
  install_infisical
  deploy_caps_platform
  setup_argocd_app
  seed_caps_platform
  health_check
  print_summary
}

main "$@"
