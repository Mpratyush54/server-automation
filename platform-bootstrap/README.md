# Platform — Server Bootstrap

Go from a **fresh Ubuntu 22.04+ server** to a running Platform stack using pre-built
images from GitHub Actions. **Do not clone this repo on the server** and do not run
`npm install` / `docker build` there.

---

## Quick Start

```bash
curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | sh
sudo platformctl provision
```

`platformctl` is interactive and resumable (`/etc/platform/.bootstrap_state`).
Re-run the same command after a failure to continue.

Non-interactive:

```bash
sudo DOMAIN=platform.example.com ADMIN_EMAIL=ops@example.com platformctl provision --auto
```

| Env var | Default | Purpose |
|---|---|---|
| `PLATFORM_IMAGE_REGISTRY` | `ghcr.io/mpratyush54` | Image registry prefix |
| `PLATFORM_IMAGE_TAG` | release version or `latest` | API + portal tag |
| `SKIP_K8S` | `false` | Skip k3s install |
| `SKIP_PREFLIGHT` | `false` | Skip RAM/disk/port checks |

---

## What gets installed

Same stack as before (k3s, ingress-nginx, cert-manager, Postgres/Mongo/Redis,
MinIO, ArgoCD, monitoring, Portainer, Infisical, Platform API + Portal). Images for
API/Portal are **pulled** from GHCR — they are built by `.github/workflows/docker-build.yml`.

---

## Legacy bash bootstrap

`bootstrap.sh` is a thin wrapper that installs `platformctl` and runs `provision`.
The previous all-in-one bash installer is kept as `bootstrap-legacy.sh` for emergency
use only:

```bash
PLATFORM_BOOTSTRAP_LEGACY=1 sudo ./bootstrap-legacy.sh
```

---

## Windows

`bootstrap.ps1` still launches Ubuntu under WSL2; inside WSL use `platformctl` as above.

For **local development on Windows**, use `docker compose` at the repo root — see
[Installation](../docs/getting-started/installation.md).

---

## After provision

1. Point DNS (or use `YOUR_IP.sslip.io`)
2. Open `https://YOUR_DOMAIN` (login page — no landing/docs on the server portal)
3. Sign in with `admin@dev.io` and the generated `ADMIN_PASSWORD` from `/etc/platform/.env`
4. Back up `/etc/platform/.env` (mode 600)
5. Docs / marketing: https://platform.pratyushes.dev only

---

## Required specs

| | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Disk | 80 GB SSD | 200 GB SSD |
| OS | Ubuntu 22.04+ | Ubuntu 22.04/24.04 |
| Ports | 80, 443 open; 6443 free | same |
