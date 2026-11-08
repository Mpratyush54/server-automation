# Installation

Two install paths, pick the one you need:

- **[Local development](#local-development)** — you're a contributor or app developer using the SDKs. Docker on your laptop is enough.
- **[Deploy to a server](#deploy-to-a-server-single-command)** — you want a real, TLS-terminated Platform on a Linux server. Download `platformctl` and provision (images are pre-built on GitHub Actions).

---

## Local Development

### Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | ≥ 18 | API and SDK development |
| npm | ≥ 9 | Package management |
| Angular CLI | ≥ 19 | Portal development (installed automatically via `npm install`) |
| Docker | ≥ 24 | Containerized databases |

### 1. Clone

```bash
git clone https://github.com/Mpratyush54/SERVER-automation.git
cd SERVER-automation
```

### 2. Start the databases with Docker Compose

The repo ships a `docker-compose.yml` at the root for **local development only**.
Every port is bound to `127.0.0.1`, every datastore requires a password, and there
are no default secrets: compose refuses to start until they are set in a
git-ignored `.env` file next to `docker-compose.yml`. Generate one with random
values (hex keeps them URL-safe for the Mongo connection string):

```bash
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
MONGO_PASSWORD=$(openssl rand -hex 24)
REDIS_PASSWORD=$(openssl rand -hex 24)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -base64 18)
EOF
chmod 600 .env
```

All variables are required even if you only start some services, because compose
validates the whole file. Then start the databases:

```bash
docker compose up -d postgres mongodb redis
```

| Service | Port (localhost only) | Credentials |
|---|---|---|
| PostgreSQL 16 | 5432 | user `platform`, password `POSTGRES_PASSWORD`, db `platform` |
| MongoDB 7 | 27017 | root user `platform`, password `MONGO_PASSWORD` (`authSource=admin`) |
| Redis 7 | 6379 | password `REDIS_PASSWORD` |

When you run the API on your host (step 4) against these containers, give it the
same credentials in `platform/api/.env` (git-ignored):

```bash
POSTGRES_HOST=localhost
POSTGRES_USER=platform
POSTGRES_PASSWORD=<POSTGRES_PASSWORD from .env>
POSTGRES_DB=platform
MONGODB_URI=mongodb://platform:<MONGO_PASSWORD>@localhost:27017/platform?authSource=admin
REDIS_HOST=localhost
REDIS_PASSWORD=<REDIS_PASSWORD from .env>
JWT_SECRET=<JWT_SECRET from .env>
ADMIN_PASSWORD=<ADMIN_PASSWORD from .env>
```

`docker compose up -d api portal` builds and runs the API (port 3000) and portal
(port 4200, nginx on 8080 inside the container) with these values wired in.

Optional extras — start these if you want to test the observability paths:

```bash
docker compose up -d minio loki prometheus grafana
```

Verify:

```bash
docker compose ps
```

### 3. Environment file (optional)

The compose datastores require passwords, so the API needs the
`platform/api/.env` values shown in step 2. If you're customising ports or pointing
at real services, start from the template:

```bash
cp platform/api/.env.example platform/api/.env
$EDITOR platform/api/.env
```

Generate a real JWT secret for anything but local dev:

```bash
openssl rand -hex 32
```

### 4. Run the API + Portal

The root `package.json` has a `start` script that boots both together:

```bash
npm install
npm run start
```

Or run them separately:

```bash
# terminal 1
cd platform/api && npm install && npm run dev

# terminal 2
cd platform/portal && npm install && npx ng serve
```

- API: <http://localhost:3000>
- Portal: <http://localhost:4200>

On first API startup the tables auto-sync and the demo users are seeded.

### 5. Sign in

Open <http://localhost:4200> and sign in with email **and password**.

Local/demo seed (`init-demo`) creates accounts with password from `ADMIN_PASSWORD`
(with docker compose: the `ADMIN_PASSWORD` you put in `.env`):

| Email | Role | Password |
|---|---|---|
| `admin@pratyushes.dev` | Admin | `ADMIN_PASSWORD` / `Admin@123` |
| `devops@pratyushes.dev` | DevOps Engineer | same |
| `sarah@pratyushes.dev` | Tech Lead | same |
| `john@pratyushes.dev` | Developer | same |

Server installs generate a random `ADMIN_PASSWORD` into `/etc/platform/.env` — there is **no passwordless login**.

Landing page and documentation live on the public site only:
**https://platform.pratyushes.dev** — not on self-hosted portals.

### 6. Re-seed (only if the auto-seed didn't run)

If the portal shows **"User email not found. Run init-demo first."** the API's
first-boot seeder didn't run (usually because it started before Postgres was ready).
Run it manually:

```bash
npm --prefix platform/api run seed:db
```

That script is idempotent — safe to run any number of times.

---

## Deploy to a Server (single command)

Requirements:

- **Ubuntu 22.04+** with sudo access
- **≥ 8 GB RAM, ≥ 80 GB free disk on `/var`, ports 80/443 open**
- Your domain pointing at the server (or run with a bare IP + sslip.io for testing)

**No repo clone. No on-server `npm` / `docker build`.** GitHub Actions builds multi-arch images to GHCR and releases the `platformctl` binary.

```bash
curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash
sudo platformctl provision
```

Non-interactive (CI / automation):

```bash
sudo DOMAIN=platform.example.com ADMIN_EMAIL=you@example.com platformctl provision --auto
```

Useful overrides:

| Env var | Default | What it does |
|---|---|---|
| `PLATFORM_IMAGE_REGISTRY` | `ghcr.io/mpratyush54` | Point at your fork's images |
| `PLATFORM_IMAGE_TAG` | release version / `latest` | Pin API + portal images |
| `AUTO_UPDATE` | `true` | CronJob + Argo Image Updater keep envs on newest GHCR tags |
| `SKIP_K8S` | `false` | Use an existing cluster |
| `SKIP_PREFLIGHT` | `false` | Skip RAM/disk/port checks |

The installer is interactive, idempotent, and resumable via `/etc/platform/.bootstrap_state`. Command list: [platformctl CLI](platformctl.md). Details: [`platform-bootstrap/README.md`](../../platform-bootstrap/README.md).

### Windows / macOS

- **Windows**: the Platform runs on Linux (k3s). Run `bootstrap.ps1` from an
  elevated PowerShell — it installs WSL2 + Ubuntu-22.04 and runs `bootstrap.sh`
  inside it.
- **macOS**: no supported native install path. Use a cloud Ubuntu VM (Hetzner,
  Oracle Cloud free tier, DigitalOcean, etc.).

---

## Manual database setup (no Docker)

If you can't use Docker locally, install the databases natively.

### PostgreSQL

```bash
# macOS (Homebrew)
brew install postgresql@16 && brew services start postgresql@16
psql postgres -c "CREATE USER platform WITH PASSWORD 'platform' SUPERUSER;"
psql postgres -c "CREATE DATABASE platform OWNER platform;"

# Ubuntu/Debian
sudo apt install postgresql && sudo systemctl start postgresql
sudo -u postgres psql -c "CREATE USER platform WITH PASSWORD 'platform' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE platform OWNER platform;"
```

### MongoDB

```bash
# macOS
brew tap mongodb/brew && brew install mongodb-community@7
brew services start mongodb-community@7

# Ubuntu
sudo apt install -y mongodb-org && sudo systemctl start mongod
```

### Redis

```bash
# macOS
brew install redis && brew services start redis

# Ubuntu
sudo apt install redis-server && sudo systemctl start redis-server
```

---

## Common Issues

### `Cannot connect to Postgres`

The API can't reach `localhost:5432`. Usually `docker compose` isn't running or the
port is bound by a system Postgres.

```bash
docker compose ps            # is the container up and healthy?
sudo ss -tlnp | grep 5432    # find who else owns the port
```

### `User email not found. Run init-demo first.`

The demo users weren't seeded. Run:

```bash
npm --prefix platform/api run seed:db
```

If that also fails, check the API logs — the seeder blocks until Postgres is ready
but crashes if `PLATFORM_PG_DB` doesn't exist. Create it (`CREATE DATABASE platform;`)
and try again.

### `WRONGPASS` in the API startup logs

A database password was rotated but `platform/api/.env` (or the k8s `platform-env`
Secret) still has the old one. See
[troubleshooting/db-wrongpass-after-rotate.md](../troubleshooting/db-wrongpass-after-rotate.md).

### Portal shows a blank page in dev

Angular 19 needs Node ≥ 18.19. Check with `node -v` and upgrade if needed
(`nvm install 20 && nvm use 20`).

### `ng serve` fails with `Cannot find module '@angular-devkit/build-angular'`

Corrupted `node_modules`. Nuke and reinstall:

```bash
rm -rf platform/portal/node_modules platform/portal/package-lock.json
cd platform/portal && npm install
```

### Server install: pods stuck in `ImagePullBackOff`

You're running a fork whose images aren't published to `ghcr.io/mpratyush54`.
See [troubleshooting/image-pull-backoff.md](../troubleshooting/image-pull-backoff.md).

### Server install: `dial tcp: lookup <name>.sslip.io … server misbehaving`

CoreDNS inside the cluster can't resolve `sslip.io`. The bootstrap patches this
automatically; if you skipped that step, see
[troubleshooting/sslip-io-dns.md](../troubleshooting/sslip-io-dns.md).

### Server install: bootstrap fails on `apt install`

`unattended-upgrades` is holding the dpkg lock. Wait for it or:

```bash
sudo systemctl stop unattended-upgrades
sudo ./bootstrap.sh
```

Full doc: [troubleshooting/apt-lock.md](../troubleshooting/apt-lock.md).

For the full catalogue, browse [`docs/troubleshooting/`](../troubleshooting/).
