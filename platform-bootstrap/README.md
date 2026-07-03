# Platform — Server Bootstrap

Single command to go from a **fresh Ubuntu 22.04+ server** to a fully running Platform
(k3s, Postgres/Mongo/Redis, ingress-nginx with Let's Encrypt, oauth2-proxy SSO gateway,
ArgoCD, Grafana/Prometheus/Loki, Portainer, Infisical, and the Platform API + Portal).

---

## Quick Start (fresh Ubuntu server)

```bash
# On a fresh Ubuntu 22.04+ server, as a user with sudo:
curl -fsSL https://raw.githubusercontent.com/Mpratyush54/SERVER-automation/master/platform-bootstrap/bootstrap.sh -o bootstrap.sh
chmod +x bootstrap.sh
sudo ./bootstrap.sh
```

The script is **interactive** — it will guide you through every decision with prompts. Press `Enter` to accept defaults.

If the domain is a bare IP (or an `sslip.io` name that resolves to it), the script
serves everything from path-based routes (`/argocd`, `/grafana`, `/portainer`) instead of
subdomains, so you don't need DNS to try it out.

---

## Windows

The Platform itself runs on Linux — the Windows script (`bootstrap.ps1`) is a **launcher** that
runs `bootstrap.sh` inside WSL2. Right-click PowerShell → **Run as Administrator**, then:

```powershell
.\bootstrap.ps1
```

For **local development on Windows** you don't need any of this — use `docker compose` at the
repo root (see the [Installation guide](../docs/getting-started/installation.md)).

---

## What Gets Installed

| Phase | Component | Purpose |
|-------|-----------|---------|
| pre‑flight | RAM / disk / port / DNS / apt‑lock check | Fail fast on the things people always hit |
| 0 | Prerequisites | curl, git, jq, python3, openssl, htpasswd, pg-client |
| 1 | Configuration | Interactive prompts for domain, email, admin creds |
| 2 | **Integrations Menu** | GitHub, GitLab, ClickUp, SMTP, external S3 — each optional |
| 3 | Docker CE | Container runtime |
| 4 | k3s + CoreDNS patch | Lightweight Kubernetes with `$DOMAIN` rewrite rule |
| 5 | Helm + repos | All Helm chart repos added *once*, up front |
| 6 | Namespaces | `platform`, `databases`, `monitoring`, `storage`, `argocd`, `portainer`, `infisical`, `cert-manager`, `ingress-nginx`, `oauth2-proxy` |
| 7 | ingress-nginx | HTTP(S) routing |
| 8 | cert-manager | Automatic TLS via Let's Encrypt (`letsencrypt-prod` + `-staging` issuers) |
| 9 | PostgreSQL + MongoDB + Redis | All in a single `databases` namespace (Bitnami charts) |
| 10 | MinIO | Object storage for backups and preview artefacts |
| 11 | ArgoCD | GitOps deployments |
| 12 | Grafana + Prometheus + Loki | Observability stack |
| 12b | oauth2-proxy | SSO gateway for services that don't ship SSO in their OSS build (Portainer, MinIO, Infisical) |
| 13 | Portainer | Container management UI — auto‑initialised via `--no-setup-token` |
| 14 | Infisical | Self-hosted secret management (creates its own DB in Postgres) |
| 15 | Platform | API + Portal deployment |
| 16 | ArgoCD App | Auto-sync GitOps application |
| 17 | First-run Seed | Passwordless admin user + default storage config |
| 18 | Health Check | Verify all pods are running |

---

## Integrations Menu (Phase 2)

Every integration is prompted for and every one is **optional** — press Enter to skip.
Whatever you skip can be added later from **⚙️ Settings → Integrations** in the portal.

Personal Access Tokens (GitHub, GitLab, ClickUp) are asked with hidden input — they're
never echoed to the terminal or written to the log.

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

All the same variables can be exported in your environment instead of the file.
The most useful overrides:

| Env var | Default | What it does |
|---|---|---|
| `PLATFORM_IMAGE_REGISTRY` | `ghcr.io/mpratyush54` | Point to your own fork's images |
| `PLATFORM_IMAGE_TAG` | `latest` | Pin to a specific release |
| `SKIP_K8S` | `false` | Use an existing k8s cluster instead of installing k3s |
| `SKIP_PREFLIGHT` | `false` | Skip the RAM/disk/port/DNS check |
| `NON_INTERACTIVE` | `false` | Never prompt; empty values are accepted |

---

## Re-running Safely

The script is **idempotent** — it tracks completed steps in `/etc/platform/.bootstrap_state`
and skips them on re-run. If it fails halfway, just re-run the same command and it will
resume from the failed step.

```bash
# To force one phase to re-run (e.g. integrations):
sudo sed -i '/^integrations=/d' /etc/platform/.bootstrap_state
sudo ./bootstrap.sh
```

To start completely fresh:
```bash
sudo rm -f /etc/platform/.bootstrap_state /etc/platform/.env
sudo ./bootstrap.sh
```

Full log is at `/var/log/platform-bootstrap.log`. On failure the last 30 lines are
printed to your terminal automatically — you don't need to `tail` it manually.

---

## After Bootstrap

1. **Add DNS records** — the script prints the exact records at the end
2. **Visit your portal** — `https://YOUR_DOMAIN` (TLS takes 2–5 min to issue)
3. **Log in** with email `admin@dev.io` — no password (passwordless JWT)
4. **Go to ⚙️ Settings → Integrations** — verify webhook connections and test SMTP
5. **Create your first project** and link it to GitHub/GitLab

---

## Generated Credentials

All secrets are written to `/etc/platform/.env` (mode 600, root only).
**Back this file up immediately** — losing it means losing access to Postgres, Mongo,
Redis, MinIO, Portainer's local admin, ArgoCD, and Grafana.

---

## Required Server Specs

|   | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Disk | 80 GB SSD | 200 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Ports | 80, 443 open inbound; 6443 free for k3s | same |

The pre-flight step will refuse to continue if RAM is below 4 GB, free disk on `/var`
is below 40 GB, or if ports 80/443/6443 are already bound.

---

## Common Issues on First Install

Every one of these has come up during real installs and each has a dedicated
troubleshooting page in [`docs/troubleshooting/`](../docs/troubleshooting/):

| Symptom | Fix / doc |
|---|---|
| `ImagePullBackOff` on `platform-api` or `platform-portal` | [image-pull-backoff.md](../docs/troubleshooting/image-pull-backoff.md) |
| Portainer shows "Administrator initialization timeout" | [portainer-setup-token.md](../docs/troubleshooting/portainer-setup-token.md) |
| Portainer OIDC → `tls: failed to verify certificate` | [portainer-oidc-ssl.md](../docs/troubleshooting/portainer-oidc-ssl.md) |
| ArgoCD login → `Invalid redirect URL` | [argocd-oidc-redirect.md](../docs/troubleshooting/argocd-oidc-redirect.md) |
| `dial tcp: lookup <domain>.sslip.io … server misbehaving` | [sslip-io-dns.md](../docs/troubleshooting/sslip-io-dns.md) |
| Helm `TLS handshake timeout` on any repo add | [dns-ipv6-timeout.md](../docs/troubleshooting/dns-ipv6-timeout.md) |
| `apt` hangs at "Waiting for cache lock" | [apt-lock.md](../docs/troubleshooting/apt-lock.md) |
| k3s fails to start — port 6443 or 80/443 already in use | [k3s-port-conflict.md](../docs/troubleshooting/k3s-port-conflict.md) |
| `toomanyrequests: You have reached your pull rate limit` | [dockerhub-rate-limit.md](../docs/troubleshooting/dockerhub-rate-limit.md) |
| Pods evicted, `DiskPressure` on the node | [disk-pressure.md](../docs/troubleshooting/disk-pressure.md) |
| `WRONGPASS` in `platform-api` logs after rotating a DB password | [db-wrongpass-after-rotate.md](../docs/troubleshooting/db-wrongpass-after-rotate.md) |
| Infisical pod crash-loops with `database "infisical" does not exist` | [infisical-db-missing.md](../docs/troubleshooting/infisical-db-missing.md) |
| MinIO Helm error `key caps-logs has no value` | [minio-template-error.md](../docs/troubleshooting/minio-template-error.md) |
| Bootstrap seed prints `Failed to obtain auth token for seeding` | [api-seed-failure.md](../docs/troubleshooting/api-seed-failure.md) |
