# Bootstrap Deployment Walkthrough

Tool: `platformctl provision`  
Target: Ubuntu 22.04+ with k3s  
Images: `ghcr.io/mpratyush54/platform-api` + `platform-portal` (built on GitHub Actions)

## Overview

```bash
curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash
sudo platformctl provision
```

Idempotent via `/etc/platform/.bootstrap_state`. No git clone and no on-server image build.

Full command list: [platformctl CLI](../getting-started/platformctl.md).

For the legacy bash phases (reference only), see `platform-bootstrap/bootstrap-legacy.sh`.

## High-level phases

1. Apt prerequisites  
2. Docker CE  
3. k3s (`--disable traefik`) + CoreDNS patch  
4. Helm repos  
5. Namespaces  
6. ingress-nginx, cert-manager  
7. Postgres / Mongo / Redis (`databases`)  
8. MinIO (`storage`)  
9. ArgoCD, monitoring, oauth2-proxy, Portainer, Infisical  
10. Pull GHCR images → deploy Platform API + Portal  
11. Seed admin (`ADMIN_PASSWORD` required — printed at end / saved in `/etc/platform/.env`)

## Resume after failure

```bash
sudo platformctl provision --auto
# or clear one step:
sudo sed -i '/^platform=/d' /etc/platform/.bootstrap_state
sudo platformctl install platform
```

## Image updates

See [rebuild-and-deploy.md](./rebuild-and-deploy.md) — retag/pull from GHCR; do not `docker build` on the server.
