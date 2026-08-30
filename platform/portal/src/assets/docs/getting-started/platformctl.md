# platformctl CLI

`platformctl` is the host tool that installs and manages Platform on an Ubuntu server. It uses pre-built GHCR images — there is no on-server compile.

## Install

Copy this on the server (also on the [homepage](/landing)):

```bash
curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash
sudo platformctl provision
```

Non-interactive (CI / automation):

```bash
sudo DOMAIN=platform.example.com ADMIN_EMAIL=you@example.com platformctl provision --auto
```

`install.sh` puts the `platformctl` binary on `PATH`. Config lives in `/etc/platform/.env` (override with `--config`).

Requirements: Ubuntu 22.04+, sudo, ≥ 8 GB RAM, ≥ 80 GB free on `/var`, ports 80/443 open.

## Commands

| Command | What it does |
|---|---|
| `platformctl provision` | Full bootstrap: k3s, databases, ArgoCD, monitoring, Platform API + portal |
| `platformctl install <component>` | Install or re-run one component (see list below) |
| `platformctl status` | Health check of cluster components |
| `platformctl seed` | Seed the admin user from `/etc/platform/.env` |
| `platformctl update` | Pull newest GHCR images and roll Platform deployments |
| `platformctl recover` | Backup host files, persist passwords to disk, then restore API/Postgres login after a broken rotate |
| `platformctl backup` | Copy `/etc/platform/.env` and database secrets to `/var/lib/platform/backups/<timestamp>/` |
| `platformctl version` | Print CLI version and default image tag |
| `platformctl --help` | List commands |

Global flags:

| Flag | Meaning |
|---|---|
| `--config <path>` | Env file (default `/etc/platform/.env`) |
| `--auto` | Non-interactive; skip prompts |

Run as root (or with `sudo`) so the CLI can talk to k3s (`KUBECONFIG=/etc/rancher/k3s/k3s.yaml`).

## `install` components

```bash
sudo platformctl install platform
```

| Name | Installs |
|---|---|
| `ingress-nginx` | Kubernetes Ingress Controller |
| `cert-manager` | Let's Encrypt certificates |
| `postgresql` | PostgreSQL |
| `mongodb` | MongoDB |
| `redis` | Redis |
| `minio` | S3-compatible object storage |
| `argocd` | Argo CD GitOps |
| `monitoring` | Grafana + Prometheus + Loki |
| `oauth2-proxy` | OAuth2 proxy |
| `portainer` | Portainer UI with Platform SSO |
| `infisical` | Secret management |
| `platform` | Platform API + portal |
| `routing` | Ingress routes |
| `auto-update` | GHCR image updater + CronJob |

Provision is idempotent via `/etc/platform/.bootstrap_state`. To retry one step:

```bash
sudo sed -i '/^platform=/d' /etc/platform/.bootstrap_state
sudo platformctl install platform
```

## Day-2 operations

**Update images after a release:**

```bash
sudo platformctl update
```

**Secret rotate / wrong password:** run backup first, then recover. Recover writes passwords to `/etc/platform/.env` and `/etc/platform/credentials/` *before* any `ALTER USER`. Details: [DB WRONGPASS after rotate](/docs/troubleshooting/db-wrongpass-after-rotate).

```bash
sudo platformctl backup
sudo platformctl recover
sudo platformctl update
```

**Health:**

```bash
sudo platformctl status
sudo platformctl version
```

## Related

- [Installation](/docs/getting-started/installation) — local Docker vs server install
- [Bootstrap walkthrough](/docs/deployment/bootstrap)
- [MCP](/docs/mcp/overview) — agent tokens and guarded commands
