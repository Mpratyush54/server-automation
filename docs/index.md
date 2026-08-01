# Platform Documentation

**Platform** is an open-source, self-hosted internal Platform-as-a-Service that
provides a unified control plane for deploying, managing, and monitoring your
applications on Kubernetes (k3s).

## Quick Links

| Section | Description |
|---|---|
| [Getting Started](getting-started/installation.md) | Set up Platform locally in 5 minutes |
| [API Reference](api-reference/platform-api/auth.md) | Complete API endpoint documentation |
| [SDK Reference](api-reference/sdk-node/PlatformClient.md) | Node.js, Python, React, Angular SDKs |
| [Architecture](architecture/overview.md) | System design, data flow, auth flow |
| [Deployment Guide](deployment/bootstrap.md) | Production deployment on k3s |
| [Troubleshooting](troubleshooting/dns-ipv6-timeout.md) | Solutions to known issues |
| [Guides](guides/authentication.md) | Authentication, secrets, monitoring, CI/CD |
| [Contributing](contribution-guide.md) | How to contribute to Platform |

## What is Platform?

Platform is a self-hosted PaaS control center that brings together:

- **Deployment automation** — Preview environments on every Git push, staging/production on `main`
- **Secrets management** — AES-256-GCM encrypted secrets with versioning, rollback and audit trails; usable without Infisical
- **Database provisioning** — One-click PostgreSQL, MongoDB and Redis instances with automated backups
- **Observability** — Real-time metrics (p50/p95/p99), Loki log aggregation, Grafana dashboards
- **Multi-SDK support** — Node.js, Python, React and Angular SDKs with auto-registration, metrics and bug reporting
- **RBAC & permissions** — Granular role-based access control with custom role definitions
- **SSO / OIDC** — OAuth2 + OpenID Connect via oauth2-proxy for any service that doesn't ship SSO in its OSS build

## Architecture at a glance

```
                    ┌─────────────────────┐
                    │    Browser / SDK    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Nginx Ingress     │
                    │  (TLS termination)  │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼──────┐  ┌─────▼──────┐  ┌──────▼─────┐
     │ Platform API  │  │  Portal    │  │  ArgoCD    │
     │ (Node/TS)     │  │ (Angular)  │  │ (GitOps)   │
     └────────┬──────┘  └────────────┘  └────────────┘
              │
    ┌─────────┼──────────┐
    │         │          │
    ▼         ▼          ▼
┌────────┐ ┌───────┐ ┌───────┐
│Postgres│ │Mongo  │ │Redis  │      (all in the `databases` namespace)
└────────┘ └───────┘ └───────┘
```

## SDK Ecosystem

| SDK | Package | Quickstart | Examples |
|---|---|---|---|
| Node.js | `@mpratyush54/sdk-node` | [Quickstart](getting-started/node-sdk-quickstart.md) | [`sdk-node/examples`](../sdk-node/examples) |
| React   | `@mpratyush54/sdk-react`  | [Quickstart](getting-started/react-sdk-quickstart.md) | [`sdk-react/examples`](../sdk-react/examples) |
| Angular | `@mpratyush54/sdk-angular`| [Quickstart](getting-started/angular-sdk-quickstart.md) | [`sdk-angular/examples`](../sdk-angular/examples) |
| Python  | `mpratyush54-sdk`     | [Quickstart](getting-started/python-sdk-quickstart.md) | [`sdk-python/examples`](../sdk-python/examples) |

See also the [SDK examples index](getting-started/sdk-examples.md) and the cluster demo [`examples/sdk-apps`](../examples/sdk-apps).

## Quick Start (local dev)

```bash
git clone https://github.com/Mpratyush54/SERVER-automation.git
cd SERVER-automation

# Start Postgres + Mongo + Redis via docker-compose
docker compose up -d postgres mongodb redis

# Install deps and run both API (:3000) and Portal (:4200)
npm install
npm run start
```

Then sign in at `http://localhost:4200` with **`admin@pratyushes.dev`** — no password
required (Platform uses passwordless email-based JWT). Demo users are auto-seeded
on first API startup; if you ever need to re-seed manually:

```bash
npm --prefix platform/api run seed:db
```

Server / production install is a single command — see [Getting Started](getting-started/installation.md#deploy-to-a-server-single-command).

## Demo Accounts (local dev)

| Name | Email | Role |
|---|---|---|
| Admin | admin@pratyushes.dev | Admin (full access) |
| DevOps Boss | devops@pratyushes.dev | DevOps Engineer |
| Sarah Lead | sarah@pratyushes.dev | Tech Lead |
| John Dev | john@pratyushes.dev | Developer |

## License

MIT
