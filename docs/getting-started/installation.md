# Install

This page helps you install Cairn on a Linux server and sign in to the portal.

## Before you start

You need:

- A server running **Ubuntu 22.04 or later**, with `sudo` access.
- At least **4 GB of memory and 40 GB of free disk**. 8 GB and 80 GB are better for real use.
- Ports **80 and 443** open to the internet, and port 6443 free.
- A domain name that points at the server. No domain yet? Use `<server-ip>.sslip.io`, which works without any DNS setup.
- **Somewhere to keep backups off the server:** a bucket in S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, or MinIO on another machine) and an access key that can list, read, write and delete in it. The installer asks for it, because losing the server must not lose your backups. Just trying Cairn out? You can choose to keep backups on the server instead and add a bucket later.

## Install in two commands

Run these on the server:

```bash
curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash
sudo platformctl provision
```

The first command downloads `platformctl`, the Cairn installer, and checks it against the release checksums. The second command sets up the whole platform.

`provision` asks a few questions. Press Enter to accept the value in brackets:

| Question | What to enter |
|---|---|
| Domain | Your domain, or the suggested `<server-ip>.sslip.io` |
| Admin email | The email you will sign in with. It is also used for Let's Encrypt certificates. |
| Platform display name | The name shown in the portal and in emails, for example `Cairn` or your team's name. |
| Admin password | A password, or press Enter to generate one |
| Optional components | Argo CD, monitoring, Portainer, HTTPS certificates, automatic image updates and daily patch upgrades. Keep the defaults unless you have a reason. |
| Backups | Answer yes, then enter the bucket's endpoint (press Enter for AWS S3), bucket name, region, an optional folder, and the access key and secret. The secret is not shown as you type. Answer no only to keep backups on this server (not recommended). |

Before it installs anything, the installer writes a small test file to the bucket, reads it back and deletes it. If that fails, it tells you why (for example a wrong key or region) and asks again.

The install takes a while. When it finishes, it prints the portal address and your sign-in details:

```text
Access URLs:
  Portal:    https://platform.example.com
  ...
Login (password required):
  Email:    you@example.com
  Password: ...
```

## Sign in

Open the portal address in a browser and sign in with the admin email and password. The password is also saved on the server in `/etc/platform/.env` as `ADMIN_PASSWORD`.

If you kept backups on the server, the portal and `platformctl status` say **Backups are stored only on this server** until you add a bucket with `sudo platformctl backup target set`. See [Backups and restore](../operations/backups.md#choose-where-backups-go).

## Next steps

- [Create your first project](first-project.md), then [deploy your app](deploy-your-app.md).
- Connect an AI assistant such as Claude, ChatGPT, Cursor or VS Code: paste `https://<your-domain>/mcp` into it and sign in. See [Connect an AI assistant](../mcp/setup.md).
- Want Cairn to build images from your source code? Builds are off by default; see [Build from Git](../guides/builds.md) to turn them on.

## Install without questions

For scripts and CI, pass the answers as environment variables and add `--auto`. A backup target is required: either give the bucket, or pass `--local-backups` to keep backups only on this server.

Type the backup access key and secret into your shell first and pass them on with `sudo -E`, so they never appear on the command line (anything typed after `sudo` is saved in the system log):

```bash
read -rp 'Access key ID: ' BACKUP_S3_ACCESS_KEY
read -rsp 'Secret access key: ' BACKUP_S3_SECRET_KEY; echo
export BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY
sudo -E env DOMAIN=platform.example.com ADMIN_EMAIL=you@example.com \
  BACKUP_S3_BUCKET=cairn-backups BACKUP_S3_REGION=us-east-1 \
  platformctl provision --auto
```

For Cloudflare R2, Backblaze B2 or MinIO, also set `BACKUP_S3_ENDPOINT`. For a quick test server without a bucket:

```bash
sudo DOMAIN=platform.example.com ADMIN_EMAIL=you@example.com platformctl provision --auto --local-backups
```

A password is generated when you do not set `ADMIN_PASSWORD`. It is printed once and saved in `/etc/platform/.env`.

## Choose what to install

A profile picks a set of components. Pass it with `--profile`:

```bash
sudo platformctl provision --profile minimal
```

| Profile | What you get |
|---|---|
| `minimal` | The core platform only. No monitoring stack, Portainer or Argo CD. |
| `standard` | The default. Adds Grafana, Prometheus and Loki, Portainer and Argo CD. |
| `full` | Everything in standard, plus traces, profiles and uptime probes. See [Turn on full monitoring](../operations/telemetry.md). |
| `ha` | Everything in full, on several servers. See [High availability](../operations/ha.md). |

On `ha`, `provision` also asks how the database copies writes between servers: `sync` (the default; no confirmed write is lost when a server dies, but writes pause during failover) or `async` (faster failover, but the last few seconds of writes can be lost). [Which one to choose](../operations/postgres-replication.md). Pass `--postgres-replication sync|async` to answer it in advance.

## If something goes wrong

- **Run it again.** `provision` remembers finished steps in `/etc/platform/.bootstrap_state` and picks up where it stopped.
- **Read the step log.** Each step writes to `/var/log/platformctl/<step>.log`. The last lines are printed when a step fails.
- **Check health.** `sudo platformctl status` checks every component.
- **Look up the error.** See [Troubleshooting](../troubleshooting/README.md).

## Details

### What the installer changes

`provision` installs k3s (a small Kubernetes) and its own container runtime. Docker is not installed. It also applies a host security baseline: firewall, SSH safeguards and automatic security updates. See [Host hardening](../guides/host-hardening.md). To leave host security to yourself, add `--skip-hardening`.

Configuration is saved in `/etc/platform/.env`. Use `--config <path>` to read another file. For a step-by-step view of the install, see [What the installer does](../deployment/bootstrap.md).

### Useful settings

Set these as environment variables before `provision`:

| Variable | Default | What it does |
|---|---|---|
| `PLATFORM_PROFILE` | `standard` | Same as `--profile` |
| `PLATFORM_IMAGE_REGISTRY` | `ghcr.io/mpratyush54` | Where Cairn images come from, for example your fork |
| `PLATFORM_IMAGE_TAG` | The release version | Pins the API and portal image version |
| `AUTO_UPDATE` | `true` | Keeps images on the newest release tag |
| `GITHUB_TOKEN` | Not set | Lets the server pull private images from GHCR |
| `SKIP_PREFLIGHT` | `false` | Skips the memory, disk and port checks |

More options, such as install speed and offline installs, are on the [CLI](platformctl.md) page.

### Windows and macOS

Cairn runs on Linux. On Windows or macOS, use an Ubuntu virtual machine or a cloud server.

## Run Cairn on your laptop

This is for contributors and SDK developers. It runs the API and portal from source, with the databases in Docker.

You need Node.js 18 or later, npm 9 or later, and Docker 24 or later.

1. Clone the repository:

   ```bash
   git clone https://github.com/Mpratyush54/SERVER-automation.git
   cd SERVER-automation
   ```

2. Create a `.env` file next to `docker-compose.yml` with random passwords. Compose refuses to start without them:

   ```bash
   cat > .env <<EOT
   POSTGRES_PASSWORD=$(openssl rand -hex 24)
   MONGO_PASSWORD=$(openssl rand -hex 24)
   REDIS_PASSWORD=$(openssl rand -hex 24)
   MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
   GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 24)
   JWT_SECRET=$(openssl rand -hex 32)
   ADMIN_PASSWORD=$(openssl rand -base64 18)
   EOT
   chmod 600 .env
   ```

3. Start the databases:

   ```bash
   docker compose up -d postgres mongodb redis
   ```

4. Give the API the same values in `platform/api/.env`:

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

5. Start the API and portal:

   ```bash
   npm install
   npm run start
   ```

6. Open <http://localhost:4200> and sign in as `admin@pratyushes.dev` with your `ADMIN_PASSWORD`.

The API runs on port 3000. On first start it creates its tables and demo users. If sign-in says the user was not found, run `npm --prefix platform/api run seed:db`. It is safe to run more than once.

All database ports are bound to `127.0.0.1` only. To try the monitoring stack locally, also run `docker compose up -d minio loki prometheus grafana`.

The compose file uses the same major versions the platform runs in production (PostgreSQL 18, Redis 8, Grafana 13, Loki 3). If you have a `pgdata` volume from an older compose file (PostgreSQL 16), PostgreSQL 18 won't use it. Dump what you need, then run `docker compose down -v` and start again.

## Use existing S3 object storage

Fresh installs on any profile can use AWS S3, R2, GCS interoperability storage or
another S3-compatible endpoint instead of bundled MinIO. Set
`OBJECT_STORAGE_MODE=external`, `OBJECT_STORAGE_ENDPOINT`,
`OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_BUCKET_PREFIX` and
`OBJECT_STORAGE_FORCE_PATH_STYLE` (default `true`). Pass credentials only with
`--object-storage-credentials-stdin` (two lines: access key ID, secret access key)
or an existing `platform/platform-object-storage` Kubernetes Secret. Interactive
`ha` installs ask about object storage and can prompt for credentials.

The installer creates/checks purpose buckets and probes write/read/delete access
before installing k3s. The API, app default storage, telemetry and registry all
use those buckets. Existing installations cannot migrate through this setting.
See [external object storage](../operations/ha.md#external-object-storage-fresh-installs-only)
for a complete command, permissions, lifecycle prerequisites and backup behavior.
