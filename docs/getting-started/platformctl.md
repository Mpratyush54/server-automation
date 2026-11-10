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
| `platform` | Platform API + portal |
| `routing` | Ingress routes |
| `auto-update` | GHCR image updater + CronJob |

Provision is idempotent via `/etc/platform/.bootstrap_state`. To retry one step:

```bash
sudo sed -i '/^platform=/d' /etc/platform/.bootstrap_state
sudo platformctl install platform
```

## Install speed, logs and timings

`provision` installs cluster components in parallel, respecting dependencies (databases before the Platform API, ingress before routing):

```bash
sudo platformctl provision --auto              # default: 4 steps at a time
sudo platformctl provision --auto --parallel 2 # gentler on small servers
sudo platformctl provision --auto --parallel 1 # serial, live output (old behaviour)
```

- Per-step logs: `/var/log/platformctl/<step>.log` (the last lines are printed if a step fails)
- Background image pre-pull log: `/var/log/platformctl/prepull.log`
- Timing summary: printed at the end and saved to `/var/log/platformctl/timings.txt`

Docker is **not** installed on the server; k3s uses its own containerd. For private GHCR images set `GITHUB_TOKEN` before provisioning; it is written to `/etc/rancher/k3s/registries.yaml`.

## Install profiles

Set `PLATFORM_PROFILE` (or pass `--profile`) to `minimal`, `standard` (default)
or `full`:

- `minimal` ? core only; no monitoring, Portainer or ArgoCD.
- `standard` ? the existing Grafana/Prometheus/Loki stack, Portainer and ArgoCD.
- `full` ? standard services plus Alloy, S3-backed Loki, Tempo, Pyroscope and
  blackbox-exporter. See [Full-profile telemetry](../operations/telemetry.md) for
  memory estimates, token/CORS integration and the required legacy Loki migration.

Saved explicit profiles remain in effect. Existing `loki-stack` installations
must follow the telemetry migration procedure before selecting full.

Browser synthetic checks (headless Chromium CronJobs) are an extra opt-in on the
full profile: `SYNTHETICS_BROWSER=true`. See [Synthetic monitoring](../operations/synthetics.md).

Explicit `INSTALL_*` variables override the profile. The profile is saved as
`PLATFORM_PROFILE` in `/etc/platform/.env`; choosing a new profile explicitly ignores the
`INSTALL_*` values saved by an earlier run.

The profile also sets the Platform API replica count: `1` on `minimal`, `2` otherwise
(rolling updates with `maxUnavailable: 0` and a PodDisruptionBudget). Override it with
`API_REPLICAS=<1-10>`; see [Scaling](../deployment/scaling.md#api-replicas-shared-state-and-zero-downtime-deploys).

## Offline bundle

Releases include `platform-bundle-<version>-<arch>.tar.zst` and a `.sha256` file:
k3s airgap images, all pinned Helm charts (`platformctl charts --json`) and the platform
container images. The bundle is larger than GitHub's 2 GiB per-asset limit, so a release
carries it as `.tar.zst.part00`, `.part01`, …; `--bundle auto` downloads and reassembles the
parts and checks the result against the `.sha256`. To fetch it manually, download every part
and the `.sha256`, then `cat platform-bundle-<version>-<arch>.tar.zst.part* >
platform-bundle-<version>-<arch>.tar.zst` and `sha256sum -c` before `--bundle <path>`. `--bundle <path|auto>` verifies the checksum and extracts it before k3s is
installed — images into `/var/lib/rancher/k3s/agent/images/`, charts into
`/var/lib/platform/charts/` — so provisioning needs little or no network for images and charts.

```bash
sudo platformctl provision --bundle auto
```

To build a bundle locally (needs curl, jq, helm 3, docker, zstd):

```bash
scripts/build-bundle.sh v1.0.0 amd64   # writes dist/platform-bundle-v1.0.0-amd64.tar.zst
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
