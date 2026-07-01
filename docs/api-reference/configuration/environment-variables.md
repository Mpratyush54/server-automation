# Environment Variables Reference

## API Server `platform/api/.env`

| Variable | Default | Description | Required |
|---|---|---|---|
| **Server** | | | |
| `PORT` | `3000` | API server listen port | |
| `DOMAIN` | `localhost:3000` | Public-facing domain (used for CORS, preview URLs, OIDC issuer) | |
| `PORTAL_URL` | `http://localhost:4200` | Portal URL for CORS and OAuth redirects | |
| `NODE_ENV` | `development` | Node.js environment (`development`, `production`) | |
| `PLATFORM_ENV` | `production` | Platform deployment environment name | |
| `PLATFORM_URL` | — | Full platform URL for portal builds | |
| `KUBECONFIG` | `~/.kube/config` | Path to Kubernetes kubeconfig | |
| **PostgreSQL** | | | |
| `PLATFORM_PG_HOST` | — | PostgreSQL hostname | ✓ |
| `PLATFORM_PG_PORT` | `5432` | PostgreSQL port | |
| `PLATFORM_PG_USER` | `platform` | PostgreSQL user | |
| `PLATFORM_PG_PASSWORD` | — | PostgreSQL password | ✓ |
| `PLATFORM_PG_DB` | `platform` | PostgreSQL database name | |
| `PLATFORM_PG_POOL` | `10` | Connection pool size | |
| **MongoDB** | | | |
| `PLATFORM_MONGO_URI` | — | MongoDB connection URI | ✓ |
| `PLATFORM_MONGO_POOL` | `5` | Connection pool size | |
| **Redis** | | | |
| `PLATFORM_REDIS_HOST` | — | Redis hostname | |
| `PLATFORM_REDIS_PORT` | `6379` | Redis port | |
| `PLATFORM_REDIS_PASSWORD` | — | Redis password | |
| `PLATFORM_REDIS_DB` | `0` | Redis database index | |
| **Secrets Encryption** | | | |
| `SECRETS_ENCRYPTION_KEY` | — | 32-byte master key for AES-256-GCM (base64 or hex) | ✓ |
| **JWT** | | | |
| `JWT_SECRET` | `plat-super-secret-key` | JWT signing secret | |
| **GitLab** | | | |
| `GITLAB_API_URL` | `https://gitlab.com/api/v4` | GitLab API base URL | |
| `GITLAB_TOKEN` | — | GitLab Personal Access Token (scopes: `api`, `read_repository`) | |
| `GITLAB_WEBHOOK_SECRET` | — | Secret token for GitLab webhook verification | |
| **GitHub** | | | |
| `GITHUB_TOKEN` | — | GitHub Personal Access Token (scopes: `repo`, `admin:org_hook`, `write:packages`) | |
| `GITHUB_ORG` | — | GitHub organization name | |
| `GITHUB_WEBHOOK_SECRET` | — | Secret for GitHub webhook HMAC-SHA256 verification | |
| **ClickUp** | | | |
| `CLICKUP_API_TOKEN` | — | ClickUp API token | |
| `CLICKUP_TEAM_ID` | — | ClickUp workspace team ID | |
| `CLICKUP_DEFAULT_LIST_ID` | — | Default list ID for bug reports | |
| **SMTP / Email** | | | |
| `SMTP_PROVIDER` | — | Provider type: `custom`, `ses`, `sendgrid`, `mailgun` | |
| `SMTP_HOST` | — | SMTP server hostname | |
| `SMTP_PORT` | `587` | SMTP server port | |
| `SMTP_USER` | — | SMTP username | |
| `SMTP_PASS` | — | SMTP password | |
| `SMTP_FROM_EMAIL` | `noreply@DOMAIN` | From email address | |
| `SMTP_FROM_NAME` | `Platform` | From display name | |
| `SMTP_AWS_REGION` | `us-east-1` | AWS SES region (when `SMTP_PROVIDER=ses`) | |
| `SMTP_AWS_KEY` | — | AWS SES access key | |
| `SMTP_AWS_SECRET` | — | AWS SES secret key | |
| `SENDGRID_API_KEY` | — | SendGrid API key (when `SMTP_PROVIDER=sendgrid`) | |
| `MAILGUN_DOMAIN` | — | Mailgun sending domain (when `SMTP_PROVIDER=mailgun`) | |
| `MAILGUN_API_KEY` | — | Mailgun API key | |
| **Integration Flags (for bootstrap status)** | | | |
| `ARGOCD_URL` | — | ArgoCD URL (alternative to auto-detect) | |
| `ARGOCD_TOKEN` | — | ArgoCD API token | |
| `INFISICAL_URL` | — | Infisical server URL | |
| `INFISICAL_TOKEN` | — | Infisical service token | |
| `GRAFANA_URL` | — | Grafana URL (alternative to auto-detect) | |
| `LOKI_URL` | `http://localhost:3100` | Loki push endpoint | |

---

## Docker / Bootstrap `platform-bootstrap/.env`

| Variable | Default | Description | Required |
|---|---|---|---|
| **Domain & Identity** | | | |
| `DOMAIN` | — | Primary domain (e.g. `platform.company.com`) | ✓ |
| `ADMIN_EMAIL` | — | Admin email for Let's Encrypt + notifications | ✓ |
| `PLATFORM_NAME` | `Platform` | Display name for the platform | |
| **Bootstrap Behaviour** | | | |
| `NON_INTERACTIVE` | `false` | Skip all prompts (CI mode) | |
| `SKIP_K8S` | `false` | Skip Kubernetes install (use existing cluster) | |
| `PLATFORM_IMAGE_TAG` | `latest` | Docker image tag to deploy | |
| `PLATFORM_REPO_URL` | — | Container registry URL | |
| **Component Toggles** | | | |
| `INSTALL_ARGOCD` | `y` | Install ArgoCD | |
| `INSTALL_MONITORING` | `y` | Install Grafana + Prometheus + Loki | |
| `INSTALL_PORTAINER` | `y` | Install Portainer | |
| `INSTALL_INFISICAL` | `y` | Install Infisical | |
| `INSTALL_CERTMANAGER` | `y` | Install cert-manager | |
| **Let's Encrypt** | | | |
| `LE_EMAIL` | — | Email for Let's Encrypt certificate registration | ✓ |
| **Generated Secrets** | | | |
| `POSTGRES_PASSWORD` | — | PostgreSQL admin password (auto-generated if blank) | |
| `MONGO_PASSWORD` | — | MongoDB root password | |
| `REDIS_PASSWORD` | — | Redis password | |
| `MINIO_ACCESS_KEY` | `platformadmin` | MinIO access key | |
| `MINIO_SECRET_KEY` | — | MinIO secret key | |
| `JWT_SECRET` | — | JWT signing secret | |
| `PLATFORM_WEBHOOK_SECRET` | — | Webhook shared secret | |
| `ARGOCD_PASSWORD` | — | ArgoCD admin password | |
| `GRAFANA_PASSWORD` | — | Grafana admin password | |
| `INFISICAL_ENCRYPTION_KEY` | — | Infisical master encryption key | |
| `INFISICAL_JWT_SECRET` | — | Infisical JWT secret | |
| **GitHub Integration** | | | |
| `GITHUB_TOKEN` | — | PAT with `repo`, `admin:org_hook`, `write:packages` | |
| `GITHUB_ORG` | — | GitHub organization name | |
| `GITHUB_REGISTRY` | `ghcr.io` | Container registry (e.g. `ghcr.io`) | |
| **GitLab Integration** | | | |
| `GITLAB_URL` | `https://gitlab.com` | GitLab instance URL | |
| `GITLAB_TOKEN` | — | PAT with `api`, `read_repository` | |
| `GITLAB_GROUP` | — | GitLab group namespace | |
| **ClickUp Integration** | | | |
| `CLICKUP_API_TOKEN` | — | ClickUp API token | |
| `CLICKUP_TEAM_ID` | — | Workspace team ID | |
| `CLICKUP_DEFAULT_LIST_ID` | — | Default list for bug reports | |
| **External S3 / Backup Storage** | | | |
| `EXT_S3_ENDPOINT` | — | External S3 endpoint URL | |
| `EXT_S3_BUCKET` | `platform-backups` | External S3 bucket name | |
| `EXT_S3_KEY` | — | External S3 access key | |
| `EXT_S3_SECRET` | — | External S3 secret key | |
| `EXT_S3_REGION` | `us-east-1` | External S3 region | |

---

## Legacy CAPS Variables (Backward Compat)

The following legacy `CAPS_*` variables are kept for backward compatibility with the original CAPS naming convention. They are read in the bootstrap and deployment configurations.

| Legacy Variable | Maps To | Notes |
|---|---|---|
| `CAPS_POSTGRES_HOST` | `POSTGRES_HOST` / `PLATFORM_PG_HOST` | |
| `CAPS_POSTGRES_PORT` | `POSTGRES_PORT` / `PLATFORM_PG_PORT` | |
| `CAPS_POSTGRES_DB` | `POSTGRES_DB` / `PLATFORM_PG_DB` | |
| `CAPS_POSTGRES_USER` | `POSTGRES_USER` / `PLATFORM_PG_USER` | |
| `CAPS_POSTGRES_PASSWORD` | `POSTGRES_PASSWORD` | |
| `CAPS_MONGODB_URI` | `MONGO_URI` / `PLATFORM_MONGO_URI` | |
| `CAPS_REDIS_HOST` | `REDIS_HOST` / `PLATFORM_REDIS_HOST` | |
| `CAPS_REDIS_PORT` | `REDIS_PORT` / `PLATFORM_REDIS_PORT` | |
| `CAPS_REDIS_PASSWORD` | `REDIS_PASSWORD` | |
| `CAPS_JWT_SECRET` | `JWT_SECRET` | |
| `CAPS_ENCRYPTION_KEY` | `SECRETS_ENCRYPTION_KEY` | |
| `CAPS_DOMAIN` | `DOMAIN` | |
| `CAPS_SMTP_HOST` | `SMTP_HOST` | |
| `CAPS_SMTP_PORT` | `SMTP_PORT` | |
| `CAPS_SMTP_USER` | `SMTP_USER` | |
| `CAPS_SMTP_PASS` | `SMTP_PASS` | |
| `CAPS_MINIO_ENDPOINT` | `S3_ENDPOINT` / `MINIO_ENDPOINT` | |
| `CAPS_MINIO_ACCESS_KEY` | `MINIO_ACCESS_KEY` | |
| `CAPS_MINIO_SECRET_KEY` | `MINIO_SECRET_KEY` | |
| `CAPS_GITLAB_TOKEN` | `GITLAB_TOKEN` | |
| `CAPS_CLICKUP_TOKEN` | `CLICKUP_API_TOKEN` | |
| `CAPS_CLICKUP_TEAM_ID` | `CLICKUP_TEAM_ID` | |
| `CAPS_CLICKUP_LIST_ID` | `CLICKUP_DEFAULT_LIST_ID` | |

---

## Kubernetes Secret Mapping

When deployed to Kubernetes, the `platform-env` Secret is created from the bootstrap `.env` file. The key names in the K8s Secret correspond directly to the environment variable names above. See `platform-bootstrap/bootstrap.sh` lines 409--448 for the complete mapping.

```bash
# Example: creating K8s secret from env vars
kubectl create secret generic platform-env \
  --namespace platform \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=POSTGRES_HOST=postgresql.databases \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=SECRETS_ENCRYPTION_KEY="$SECRETS_ENCRYPTION_KEY" \
  # ... all other vars
```
