# Platform Documentation

**Platform** is an open-source, self-hosted internal Platform-as-a-Service that provides a unified control plane for deploying, managing, and monitoring your applications on Kubernetes (k3s).

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

- **Deployment Automation** — Preview environments on every Git push, staging/production on main branch
- **Secrets Management** — AES-256-GCM encrypted secrets with versioning, rollback, and audit trails
- **Database Provisioning** — One-click PostgreSQL, MongoDB, and Redis instances with automated backups
- **Observability** — Real-time metrics (p50/p95/p99), distributed tracing, Loki log aggregation, Grafana dashboards
- **Multi-SDK Support** — Node.js, Python, React, Angular SDKs with auto-registration, metrics, and bug reporting
- **RBAC & Permissions** — Granular role-based access control with custom role definitions
- **SSO / OIDC** — OAuth2 + OpenID Connect support for single sign-on

## Architecture Overview

```
                    ┌─────────────────────┐
                    │     Browser/Client   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Nginx Ingress     │
                    │  (SSL termination)  │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼──────┐  ┌─────▼──────┐  ┌──────▼─────┐
     │   Platform    │  │   Portal   │  │   ArgoCD   │
     │   API (3000)  │  │  Angular   │  │  (CD tool) │
     └────────┬──────┘  └────────────┘  └────────────┘
              │
    ┌─────────┼──────────┐
    │         │          │
    ▼         ▼          ▼
┌───────┐ ┌──────┐ ┌────────┐
│PostgreSQL│MongoDB│  Redis │
└───────┘ └──────┘ └────────┘
```

## SDK Ecosystem

| SDK | Package | Docs |
|---|---|---|
| Node.js | `@mpratyush54/sdk-node` | [Node.js SDK](api-reference/sdk-node/PlatformClient.md) |
| Python | `platform-sdk-python` | [Python SDK](api-reference/sdk-python/PlatformClient.md) |
| React | `@mpratyush54/sdk-react` | [React SDK](api-reference/sdk-react/PlatformProvider.md) |
| Angular | `@mpratyush54/sdk-angular` | [Angular SDK](api-reference/sdk-angular/PlatformModule.md) |

## Quick Start

```bash
# Clone the repository
git clone https://github.com/your-org/platform.git
cd platform

# Start the API
cd api
npm install
npm run dev

# In another terminal, start the Portal
cd portal
npm install
ng serve

# Seed demo users
curl http://localhost:3000/api/users/init-demo

# Login at http://localhost:4200 with admin@dev.io
```

## Demo Accounts

| Name | Email | Role |
|---|---|---|
| Admin | admin@dev.io | Admin (full access) |
| DevOps Boss | devops@dev.io | DevOps Engineer |
| Sarah Lead | sarah@dev.io | Tech Lead |
| John Dev | john@dev.io | Developer |

## Production Server

The Platform is deployed at [https://148.113.58.205.sslip.io/](https://148.113.58.205.sslip.io/).

## License

MIT
