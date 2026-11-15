# Install

This page helps you install Platform on a Linux server and sign in to the portal.

## Before you start

You need:

- A server running **Ubuntu 22.04 or later**, with `sudo` access.
- At least **4 GB of memory and 40 GB of free disk**. 8 GB and 80 GB are better for real use.
- Ports **80 and 443** open to the internet, and port 6443 free.
- A domain name that points at the server. No domain yet? Use `<server-ip>.sslip.io`, which works without any DNS setup.

## Install in two commands

Run these on the server:

```bash
curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash
sudo platformctl provision
```

The first command downloads `platformctl`, the Platform installer, and checks it against the release checksums. The second command sets up the whole platform.

`provision` asks a few questions. Press Enter to accept the value in brackets:

| Question | What to enter |
|---|---|
| Domain | Your domain, or the suggested `<server-ip>.sslip.io` |
| Admin email | The email you will sign in with. It is also used for Let's Encrypt certificates. |
| Platform display name | Any name. `Platform` is fine. |
| Admin password | A password, or press Enter to generate one |
| Optional components | Argo CD, monitoring, Portainer, HTTPS certificates and automatic updates. Keep the defaults unless you have a reason. |

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

Next: [create your first project](first-project.md).

## Install without questions

For scripts and CI, pass the answers as environment variables and add `--auto`:

```bash
sudo DOMAIN=platform.example.com ADMIN_EMAIL=you@example.com platformctl provision --auto
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

`provision` installs k3s (a small Kubernetes) and its own container runtime. Docker is not installed. It also applies a host security baseline: firewall, SSH safeguards and automatic security updates. See [Host hardening](../host-hardening.md). To leave host security to yourself, add `--skip-hardening`.

Configuration is saved in `/etc/platform/.env`. Use `--config <path>` to read another file. For a step-by-step view of the install, see [What the installer does](../deployment/bootstrap.md).

### Useful settings

Set these as environment variables before `provision`:

| Variable | Default | What it does |
|---|---|---|
| `PLATFORM_PROFILE` | `standard` | Same as `--profile` |
| `PLATFORM_IMAGE_REGISTRY` | `ghcr.io/mpratyush54` | Where Platform images come from, for example your fork |
| `PLATFORM_IMAGE_TAG` | The release version | Pins the API and portal image version |
| `AUTO_UPDATE` | `true` | Keeps images on the newest release tag |
| `GITHUB_TOKEN` | Not set | Lets the server pull private images from GHCR |
| `SKIP_PREFLIGHT` | `false` | Skips the memory, disk and port checks |

More options, such as install speed and offline installs, are on the [CLI](platformctl.md) page.

### Windows and macOS

Platform runs on Linux. On Windows or macOS, use an Ubuntu virtual machine or a cloud server.

## Run Platform on your laptop

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
