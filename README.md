# Cairn

**Run your apps on your own servers, and keep them running when one fails.**

Cairn turns one Ubuntu server, or a small group of them, into a place where your team
deploys apps from Git, gets databases, keeps secrets, and sees logs, errors and alerts —
without stitching the pieces together yourself. It installs and connects proven
open-source tools (k3s, Argo CD, CloudNativePG, Grafana and others) and gives you one
portal and one CLI to run them.

- Website and docs: <https://cairnpaas.dev>
- Install guide: [docs/getting-started/installation.md](docs/getting-started/installation.md)

## What you get

- **Deploy from Git.** Connect a GitHub or GitLab repository and pick a branch per
  environment. Each project gets development, staging and production, with their own
  addresses, deployment history and one-click rollback.
- **Databases and storage.** PostgreSQL per environment, plus MongoDB, Redis and
  S3-compatible file storage, with backups.
- **Secrets and settings.** Encrypted variables per environment, with history and
  rollback.
- **Monitoring.** Logs, metrics, traces, error tracking, uptime checks, status pages and
  alerts (email, Slack, Discord, PagerDuty, webhooks) in the same portal.
- **High availability.** The `ha` profile runs on three servers; tested by switching
  servers off under load.
- **Security.** Password sign-in with two-factor, roles and per-project access, GitHub
  and GitLab sign-in, project isolation, secret rotation and host hardening.
- **AI agents.** A built-in MCP server lets AI assistants read project state and run
  approved commands, with risky actions held for a person's approval.

## Install

On a fresh **Ubuntu 22.04 or later** server with `sudo` access (4 GB memory and 40 GB disk
minimum; 8 GB and 80 GB recommended), and a domain pointing at it — or use
`<server-ip>.sslip.io` if you don't have one yet:

```bash
curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash
sudo platformctl provision
```

`provision` asks for your domain and the first admin account, installs everything, and
prints the portal address when it is done. Profiles: `minimal`, `standard` (default),
`full` (complete telemetry) and `ha` (three servers). See the
[install guide](docs/getting-started/installation.md) for unattended installs and options.

Day-two commands live in the same CLI — `platformctl status`, `upgrade`, `backup`,
`restore`, `repair`, `harden`. Reference: [docs/getting-started/platformctl.md](docs/getting-started/platformctl.md).

## Documentation

| Start here | |
|---|---|
| [Install](docs/getting-started/installation.md) | Put Cairn on a server |
| [Your first project](docs/getting-started/first-project.md) | Create a project and connect a repository |
| [Deploy an app](docs/getting-started/deploy-your-app.md) | Ship a branch to an environment |
| [Backups and restore](docs/operations/backups.md) | Protect and recover your data |
| [High availability](docs/operations/ha.md) | Run on three servers |
| [AI agents and MCP](docs/mcp/overview.md) | Connect an AI assistant |
| [Troubleshooting](docs/troubleshooting/README.md) | Fixes for common errors |

The same docs are published at <https://cairnpaas.dev/docs>.

## SDKs

| Language | Package | Docs |
|---|---|---|
| Node.js | `@mpratyush54/sdk-node` | [sdk-node](sdk-node/README.md) |
| Python | `mpratyush54-sdk` | [sdk-python](sdk-python/README.md) |
| React | `@mpratyush54/sdk-react` | [sdk-react](sdk-react/README.md) |
| Angular | `@mpratyush54/sdk-angular` | [sdk-angular](sdk-angular/README.md) |

Backend SDKs read project settings and database credentials and send heartbeats, request
metrics and logs; frontend SDKs add error reporting and browser monitoring.

## Repository layout

```
platformctl/          Go CLI that installs, upgrades, backs up and repairs a server
platform/api/         Node.js + TypeScript API (Express, TypeORM/PostgreSQL, MongoDB, Redis)
platform/portal/      Angular portal, public site and docs viewer
platform/mcp-server/  MCP server for AI assistants
sdk-*/                SDKs for Node.js, Python, React and Angular
docs/                 Documentation (also served at /docs)
examples/             Example apps that use the SDKs
```

## Develop locally

You don't need Kubernetes to work on the API and portal:

```bash
git clone https://github.com/Mpratyush54/SERVER-automation.git
cd SERVER-automation
# 1. Local databases. Put POSTGRES_PASSWORD, MONGO_PASSWORD and REDIS_PASSWORD in ./.env first.
docker compose up -d postgres mongodb redis

# 2. API settings: copy the example and fill in the same database passwords,
#    plus JWT_SECRET (32+ random characters) and ADMIN_PASSWORD.
cp platform/api/.env.example platform/api/.env

# 3. Install and run
npm run install:all
npm run start        # API on :3000, portal on :4200
```

Sign in at <http://localhost:4200> with `ADMIN_EMAIL` and `ADMIN_PASSWORD` from
`platform/api/.env`. Tests: `cd platform/api && npm test`, `cd platform/portal && npx ng test`,
`cd platformctl && go test ./...`.

## Contributing

Bug reports and ideas are welcome in [Issues](https://github.com/Mpratyush54/SERVER-automation/issues).
Please report security problems privately through
[GitHub security advisories](https://github.com/Mpratyush54/SERVER-automation/security/advisories/new),
not in public issues. Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`).
