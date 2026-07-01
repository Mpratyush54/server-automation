# Platform — Server Bootstrap

Single command to go from a fresh Ubuntu 22.04+ server to a fully running Platform with all integrations configured.

## Quick Start

```bash
# On a fresh Ubuntu 22.04+ server (as root):
curl -fsSL https://raw.githubusercontent.com/your-org/platform/main/platform-bootstrap/bootstrap.sh -o bootstrap.sh
chmod +x bootstrap.sh
sudo ./bootstrap.sh
```

The script is **interactive** — it will guide you through every decision with prompts. Press `Enter` to accept defaults.

---

## What Gets Installed

| Phase | Component | Purpose |
|-------|-----------|---------|
| 0 | Prerequisites | curl, git, jq, openssl, pg-client |
| 1 | Configuration | Interactive prompts for domain, email, admin creds |
| 2 | **Integrations Menu** | GitHub, GitLab, ClickUp, SMTP, S3 — all prompted |
| 3 | Docker CE | Container runtime |
| 4 | k3s | Lightweight Kubernetes |
| 5 | Helm | Package manager |
| 6 | Namespaces | K8s namespace layout |
| 7 | ingress-nginx | HTTP routing |
| 8 | cert-manager | Automatic TLS via Let's Encrypt |
| 9 | PostgreSQL + MongoDB + Redis | Databases (Bitnami Helm charts) |
| 10 | MinIO | Object storage for backups |
| 11 | ArgoCD | GitOps deployments |
| 12 | Grafana + Prometheus + Loki | Observability stack |
| 13 | Portainer | Container management UI |
| 14 | Infisical | Self-hosted secret management |
| 15 | Platform | API + Portal deployment |
| 16 | ArgoCD App | Auto-sync GitOps application |
| 17 | First-run Seed | Admin user + default storage config |
| 18 | Health Check | Verify all pods are running |

---

## Integrations Menu (Phase 2)

The bootstrap will prompt for each integration. **Press Enter to skip** any you don't need yet — they can be added later from **⚙️ Settings → Integrations** in the portal.

### GitHub
- PAT scopes needed: `repo`, `admin:org_hook`, `write:packages`
- Webhook auto-configured: `https://YOUR_DOMAIN/api/webhooks/github`

### GitLab
- PAT scopes needed: `api`, `read_repository`
- Webhook auto-configured: `https://YOUR_DOMAIN/api/webhooks/gitlab`

### ClickUp
- Token from: ClickUp → User Settings → Apps → API Token
- Bug reports and deployment events create ClickUp tasks automatically

### SMTP / Email
- Supports: Custom SMTP, AWS SES, SendGrid, Mailgun
- Deployment success/failure emails auto-sent to DevOps users

### Backup Storage
- Default: bundled MinIO (inside the cluster)
- Optional: External AWS S3, Cloudflare R2, or any S3-compatible endpoint

---

## Non-Interactive Mode (CI/CD)

```bash
# Copy and fill .env.example
cp .env.example /etc/platform/.env
# Edit /etc/platform/.env with your values, then:
NON_INTERACTIVE=true sudo ./bootstrap.sh
```

---

## Re-running Safely

The script is **idempotent** — it tracks completed steps in `/etc/platform/.bootstrap_state`. Re-running skips already-done phases.

```bash
# To force re-run a specific phase (e.g. integrations):
sed -i '/^integrations=/d' /etc/platform/.bootstrap_state
sudo ./bootstrap.sh
```

To start completely fresh:
```bash
rm -f /etc/platform/.bootstrap_state /etc/platform/.env
sudo ./bootstrap.sh
```

---

## After Bootstrap

1. **Add DNS records** — the script prints the exact records at the end
2. **Visit your portal** — `https://YOUR_DOMAIN` (TLS takes 2–5 min to issue)
3. **Log in** with the admin credentials printed in the summary
4. **Go to ⚙️ Settings** → verify integrations and test SMTP
5. **Create your first project** and link it to GitHub/GitLab

---

## Generated Credentials

All secrets are written to `/etc/platform/.env` (mode 600, root only). **Back this file up immediately.**

---

## Required Server Specs

| | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Disk | 80 GB SSD | 200 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Ports | 80, 443 open | 80, 443 open |
