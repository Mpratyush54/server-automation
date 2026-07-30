# Platform

Self-hosted internal Platform-as-a-Service — a single control plane for deploying,
managing and monitoring applications on Kubernetes (k3s). One command turns a fresh
Ubuntu server into a production-shaped cluster with GitOps, secrets, observability,
storage and SSO all wired up.

- **Backend API** — Node.js + TypeScript + Express + TypeORM (Postgres) + Mongoose (Mongo) + ioredis
- **Portal** — Angular 19 dashboard with a built-in docs site
- **SDKs** — `@mpratyush54/sdk-node`, `platform-sdk-python`, `@mpratyush54/sdk-react`, `@mpratyush54/sdk-angular`
- **Bootstrap** — a single `bash` script that installs and configures the entire stack

The full documentation lives in [`docs/`](docs/) and is also rendered inside the portal
at `/docs`.

---

## Repository layout

```
SERVER-automation/
├── platform/
│   ├── api/                 # Express + TypeORM + Mongoose backend
│   └── portal/              # Angular 19 dashboard + docs
├── sdk-node/                # @mpratyush54/sdk-node
├── sdk-python/              # platform-sdk-python (PyPI)
├── sdk-react/               # @mpratyush54/sdk-react
├── sdk-angular/             # @mpratyush54/sdk-angular
├── platform-bootstrap/      # Server install script (bootstrap.sh / bootstrap.ps1)
├── docs/                    # Markdown docs (also served in-portal at /docs)
├── demo-app/                # A working example app that uses the SDKs
└── docker-compose.yml       # Local dev — Postgres + Mongo + Redis + MinIO + Loki + Prom + Grafana
```

---

## Install on a server (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/Mpratyush54/SERVER-automation/master/platform-bootstrap/bootstrap.sh -o bootstrap.sh
chmod +x bootstrap.sh
sudo ./bootstrap.sh
```

Full details, including Windows/WSL and non-interactive CI mode:
[`platform-bootstrap/README.md`](platform-bootstrap/README.md).

---

## Run locally (development)

You don't need Kubernetes to develop against Platform — `docker-compose.yml` at the
repo root spins up everything Platform depends on.

```bash
# 1. Clone
git clone https://github.com/Mpratyush54/SERVER-automation.git
cd SERVER-automation

# 2. Databases (Postgres 16 + Mongo 7 + Redis 7 + MinIO + Loki + Prom + Grafana)
docker compose up -d postgres mongodb redis
# Optional extras:
docker compose up -d minio loki prometheus grafana

# 3. API + Portal in parallel
npm install
npm run start        # runs platform/api (:3000) and platform/portal (:4200) together
```

Open `http://localhost:4200` and sign in with **`admin@pratyushes.dev`** (no password —
Platform uses passwordless JWT). Users are auto-seeded on first API boot; if you ever
need to re-seed, run:

```bash
npm --prefix platform/api run seed:db
```

Full walkthrough with per-OS notes:
[`docs/getting-started/installation.md`](docs/getting-started/installation.md).

---

## SDKs

| Language | Package | Docs |
|---|---|---|
| Node.js | `@mpratyush54/sdk-node` | [sdk-node/README.md](sdk-node/README.md) |
| Python  | `platform-sdk-python`   | [sdk-python/README.md](sdk-python/README.md) |
| React   | `@mpratyush54/sdk-react`  | [sdk-react/README.md](sdk-react/README.md) |
| Angular | `@mpratyush54/sdk-angular`| [sdk-angular/README.md](sdk-angular/README.md) |

Each SDK auto-registers the running app with the Platform on start, ships request
metrics, wires an error boundary that files bug reports back to the portal, and can
pull config/secrets from the Platform without any extra infrastructure like Infisical.

---

## Common issues (fresh install)

Every one of these has bitten a real install. Each has a dedicated page in
[`docs/troubleshooting/`](docs/troubleshooting/):

- **Pods stuck in `ImagePullBackOff`** — the images live at `ghcr.io/mpratyush54/*`.
  If you're on a fork, set `PLATFORM_IMAGE_REGISTRY=ghcr.io/your-user` before running
  the bootstrap.
- **`sslip.io` name won't resolve inside the cluster** — CoreDNS gets patched by
  the bootstrap to send `*.$DOMAIN` to the ingress controller. If you skipped that
  patch, see [`sslip-io-dns.md`](docs/troubleshooting/sslip-io-dns.md).
- **Portainer "Administrator initialization timeout"** — the bootstrap now runs
  Portainer with `--no-setup-token` and creates the admin over the API. If you
  installed manually, see [`portainer-setup-token.md`](docs/troubleshooting/portainer-setup-token.md).
- **`WRONGPASS` in the API logs** — a database password was rotated but the
  `platform-env` secret still has the old one. See
  [`db-wrongpass-after-rotate.md`](docs/troubleshooting/db-wrongpass-after-rotate.md).
- **ArgoCD "Invalid redirect URL"** — path-based (`/argocd`) vs subdomain
  (`argocd.$DOMAIN`) mismatch in the OIDC RP config. See
  [`argocd-oidc-redirect.md`](docs/troubleshooting/argocd-oidc-redirect.md).

Full list: [`docs/troubleshooting/`](docs/troubleshooting/).

---

## Contributing

Read [`docs/contribution-guide.md`](docs/contribution-guide.md). Short version:

- Fork, branch off `master`
- Conventional Commits (`feat:`, `fix:`, `docs:` …) — semver is computed from commit
  messages by [`.github/workflows/publish-packages.yml`](.github/workflows/publish-packages.yml)
- Run `npm test` before opening a PR

---

## License

MIT — see [`LICENSE`](LICENSE).
