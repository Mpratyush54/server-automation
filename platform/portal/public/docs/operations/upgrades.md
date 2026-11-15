# Upgrade Cairn to a new release

This page helps you move your server to a newer Cairn release. Upgrades run on the server with the `platformctl` command line tool; there is no upgrade button in the portal.

`platformctl upgrade` backs up first, checks that everything is healthy, and rolls back on its own if the new release fails its checks.

## Upgrade

Run these on the server (the Linux host that runs the cluster):

1. See what would change, without changing anything:

   ```sh
   sudo platformctl upgrade --to v1.4.0 --dry-run
   ```

2. Run the upgrade. It shows the plan and asks you to confirm:

   ```sh
   sudo platformctl upgrade --to v1.4.0
   ```

3. Check the result:

   ```sh
   sudo platformctl status
   sudo platformctl upgrade --history
   ```

Leave out `--to` to upgrade to the latest stable release. Replace `v1.4.0` with a published release tag.

Pick a quiet time. Databases restart for about 30 seconds during some upgrades, and project connections drop briefly. Ask your team not to make changes in the portal while it runs.

## Before you start

The upgrade refuses to start until all of these are true:

- At least 2 GiB free under `/var/lib` and 512 MiB of free memory.
- All pods in the `platform`, `databases` and `storage` namespaces are ready.
- No deployment or other long task is running in Cairn.
- Your configured backup destination can be read.

It also refuses to go down a version or skip a major version.

> [!WARNING]
> If no encrypted backup is configured, the upgrade only keeps a copy of the database on the same disk. Set up encrypted off-site backups first: see [Backups and restore](backups.md).

## Options

| Option | What it does |
|---|---|
| `--to <tag>` | Target release. Default: the latest stable release. |
| `--dry-run` | Show the plan and change nothing. |
| `--yes` | Accept the plan without a prompt (for scripts). |
| `--patch-only` | Only take a newer patch in the installed minor version (for example 1.4.0 to 1.4.2). |
| `--history` | Print the local upgrade history. |
| `--allow-unreleased` | Accept a `--to` tag that is not published. Only for testing a local build whose binary and images are already on the server. The running images may then use a tag without a digest (for example from an install with local images), as long as they come from the same repository as the target and are on the server, so a rollback can restore them. |
| `--restore-failed-migration` | Allow restoring the database if a migration the release marks as irreversible fails. Reads the backup's private key on standard input. `--yes` never grants this. |

## If something goes wrong

- **A check fails during the upgrade:** it rolls back on its own to the previous images and Helm releases, then checks health again. Read the error. It says if the rollback itself needs your attention.
- **A component fails after the release succeeded:** fix the cause and run the same `upgrade` command again. At the installed release it only repeats the component step.
- **The server lost power or the process was killed:** rollback could not run. See [Interrupted upgrades](#interrupted-upgrades) below.

For other problems, see [Recover a broken install](recover.md).

## Turn on automatic upgrades

Automatic patch upgrades are off by default.

1. Set `AUTO_UPGRADE=true` in `/etc/platform/.env`.
2. Run `sudo platformctl install auto-update`.

Every day at 04:20 UTC the server runs `platformctl upgrade --patch-only --yes`. Minor and major upgrades stay manual. To stop it later, suspend or delete the `platform-auto-upgrade` CronJob; setting the flag back to `false` does not remove an installed schedule.

## Upgrade from an older release

Upgrades work from **v1.3.0-rc.3**, the first release that contains `platformctl upgrade`, onwards. Releases from before the `upgrade` command existed (v1.3.0-rc.2, v1.2.0 and earlier) cannot upgrade themselves. Install the **target** release's `platformctl` with its installer, then upgrade the existing cluster. Do not run `provision` again.

```sh
curl -fsSL https://github.com/Mpratyush54/server-automation/releases/download/<target>/install.sh -o install.sh
sudo env PLATFORMCTL_VERSION=<target> bash install.sh
sudo platformctl upgrade --to <target> --yes
```

Replace `<target>` with a published release tag that has the `upgrade` command. The installer replaces the command line tool; `upgrade` changes the cluster.

On these older installs, also run `sudo platformctl update` once first, so images are pinned to exact versions and a rollback can restore them. Development builds (version `dev` or empty) must be replaced with a release binary.

## Backup settings that name an mc alias

Older releases copied encrypted archives with the MinIO `mc` program, and `/etc/platform/backup.json` could name an `mc` alias: `"target": "s3://<alias>/<bucket>/<prefix>"`, or `"minioAlias": "<alias>"` for a MinIO that Cairn did not install. platformctl no longer needs `mc`. It reads the alias's address and keys from root's `~/.mc/config.json` (or `$MC_CONFIG_DIR/config.json`, or an `MC_HOST_<alias>` variable), so these settings keep working after the upgrade, and archives made by older releases restore as before.

If the alias is gone (for example, `mc` was removed together with its settings), `backup`, `backup list` and `restore` stop with an error that names the alias. Switch to the off-site backup target instead:

```sh
sudo platformctl backup target set --endpoint https://<s3 endpoint> --bucket <bucket> --region <region> --prefix <prefix>
```

Then set `"target": "external"` in `/etc/platform/backup.json`. The off-site target keeps archives under `<prefix>/archives/`, so archives already stored at the old alias path are not listed there. To restore one of them, recreate the alias in `~/.mc/config.json` and pass `--target s3://<alias>/<bucket>/<prefix>` to `restore`, or copy the archive folders into `<prefix>/archives/` with any S3 tool.

Remove `minioAlias` from `backup.json` when the files are in the bundled MinIO; it is only for a MinIO outside the cluster.

## Uploaded files on v1.2.0 and earlier

Up to v1.2.0, files uploaded through the API were stored inside the API container, with no volume. Every API restart loses them, including `platformctl update` and the upgrade's own rollout. Files already lost cannot be recovered.

The upgrade saves a copy from every API pod before it changes anything, to `/var/lib/platform/backups/uploads-<timestamp>/<pod>.tar`. To take your own copy before anything restarts the API:

```sh
for p in $(sudo kubectl -n platform get pods -l app=platform-api -o name); do
  sudo kubectl -n platform exec "$p" -c api -- tar -C /app -cf - uploads > "upload-${p#pod/}.tar"
done
```

Each API pod has its own folder; a file exists only on the pod that received it. The file records stay in the database, but the files are not moved to the new storage. Upload again what you need.

## How it works

### Finding and checking the release

- Run as root on the control-plane host. Use the release's `platformctl`, or let `upgrade` download the target release's binary and hand over to it.
- Downloads are checked against `checksums.txt`. If GitHub release assets fail, it falls back to the copy on GHCR (GitHub's container registry) and verifies layer digests too.
- `--to` must name a published release: a tag GitHub reports as missing (404) is refused. During a GitHub outage the release must exist in the GHCR mirror.
- The source version comes from the last successful upgrade in the history; without history, from `PLATFORM_IMAGE_TAG` in `/etc/platform/.env`. Make sure that value matches the installed release on servers without history.
- Each release includes `upgrade.json`, built from `platformctl/upgrade-policy.json` (`minimumSource`, `breakingNotes`, `irreversibleMigrations`) plus the target's chart versions. Without `upgrade.json`, only upgrades within the same major version are allowed.

### Preflight details

- Active operations are counted by querying the `platform` database directly in the PostgreSQL pod (`kubectl -n databases exec` and `psql`). The password is read inside the container from `POSTGRES_PASSWORD` or `POSTGRES_PASSWORD_FILE`. No API token is needed.
- It counts `pending`, `running` and `compensating` operations. A refusal shows the count and the five newest operations. Older installs without the operations table count as zero. Connection, permission and other query errors stop the upgrade.
- The installer lock keeps other installer and backup runs out, but it does not block new API operations. That is why you should pause portal changes.
- Existing images must already be pinned by digest, so rollback can restore the exact images.

### The upgrade itself

- The plan lists changed chart releases and platform images. Releases are matched to pinned charts by exact chart name (`loki-stack-2.10.3` is the `loki-stack` chart, never `loki`). k3s and Helm themselves are not upgraded.
- Charts come from the local chart cache, with upstream and GHCR as fallback. Existing values are kept and each chart is upgraded with `--atomic`. Check the changelog for chart major-version notes before you confirm.
- With backups configured, it runs the encrypted `backup --all` and records the backup ID. Otherwise it warns and keeps a **local-only** database dump and credential snapshot.
- The migration Job takes its own local pre-migration dump, applies pending migrations, then compares the schema with what the API needs. Missing objects are re-created by re-running the idempotent migrations. If anything is still missing, the Job fails and the upgrade stops. Other differences (types, defaults) are logged, never applied. This Job runs on every `upgrade`, `provision` and `platformctl update`.
- Health gates wait for the API and portal rollouts, API readiness, the API schema check (`/api/health/schema`), portal HTTP 200, sign-in (OIDC discovery) HTTP 200, and Argo CD HTTP 200 when it is installed. All gates have time limits. Against an older API after a rollback, a missing `/api/health/ready` falls back to `/api/health`, and a missing schema check is skipped.
- On success, `PLATFORM_IMAGE_TAG` in `/etc/platform/.env` is rewritten to the new release, so later `install` or `provision` runs use the new images. A failed or rolled-back upgrade leaves it at the old release. Running `upgrade` again at the installed release fixes a tag an older `platformctl` left behind.
- On any chart, image or health failure, previous image digests and Helm revisions are restored in reverse order and the gates run again. Schema migrations stay in place when images roll back.
- The digest-refresh schedule (`platform-auto-update`) is paused before the backup; a running refresh Job must finish first. A failed upgrade restores the previous setting.
- After success the new binary is installed at `/usr/local/bin/platformctl` and schedules are reconciled. A failure here is reported separately from the release upgrade and needs a manual fix.

### Rolling back to v1.2.0

Releases such as v1.2.0 adjust the schema when the API starts. They drop columns, indexes and constraints they do not know, while the migrations table still lists them as applied. The next `platformctl upgrade` re-runs the migration Job, which finds the missing objects and re-creates them (log lines `schema drift: ... missing` and `schema repaired`). Data in the dropped columns is gone; restore the pre-upgrade backup if you need it.

### Database restore after a failed migration

Restore is considered only when a migration **failed** and the release marks it irreversible. Interactive runs ask separately. `--yes` never grants it; pass `--restore-failed-migration` and supply the backup's age private key on standard input. With encrypted backups, the PostgreSQL restore covers the whole PostgreSQL component, including project databases, so stop project writers first. With only a local dump, the same consent allows stopping the API and restoring the recorded platform database dump; no key is needed. Test recovery before relying on unattended upgrades.

### Interrupted upgrades

A power loss or killed process cannot run rollback. Find the last `started` record, its plan and backup, then restore the recorded Helm revisions and images by hand before retrying. Do not delete evidence of a partial upgrade.

History is an append-only log in `/var/lib/platformctl/state/upgrade-history.json`, copied to the `platform-upgrade-history` ConfigMap (`history.json`) in the `platform` namespace. The ConfigMap keeps recent events under the Kubernetes size limit; the local file keeps everything. A failure to write history is reported instead of claiming success.

### Components after the release

Once the release is healthy, `upgrade` brings the install up to the component set of its profile (`PLATFORM_PROFILE` in `/etc/platform/.env`), using the same steps as `provision`:

- installs components the profile now includes but the server lacks (for example full-profile telemetry and synthetics on an install from v1.2.0);
- reconciles PostgreSQL, MongoDB and Redis when their Helm values changed (each records a values fingerprint; older installs reconcile once), for example to add metrics exporters;
- re-applies the platform step (secrets, RBAC and the new Deployment spec, with the same pinned images) and the ingress, telemetry, synthetics and Kyverno steps.

`--dry-run` and the prompt list these changes and what each restarts, for example:

```text
Components (profile full) reconciled after the release is healthy:
  - postgresql     reconcile (Helm values changed); restarts: postgresql-0 (connections drop for ~30s; the API reconnects)
  - redis          reconcile (Helm values changed); restarts: redis-master-0, redis-replicas-0 (project Redis users are re-created by the API)
  - platform       re-apply; restarts: platform-api and platform-portal (rolling, one pod at a time) when the Deployment spec or configuration changed
  - telemetry      install; restarts: Grafana and Prometheus (kube-prometheus values change); legacy loki-stack without a volume is replaced
```

- The alerting and synthetics permissions the new API needs are applied before the API rollout.
- A legacy `loki-stack` release is replaced by the telemetry step only when it has no persistent volume; see [Turn on full monitoring](telemetry.md#upgrade-from-loki-stack).
- Project Redis users are re-created by the API within about 15 seconds of a Redis restart (Redis keeps them in memory only).
- No manual editing of `/etc/platform/.bootstrap_state` is needed.
- Running `provision` again on an existing server re-applies the host security baseline; it prints a notice first, and interactive runs ask. Set `SKIP_HARDENING=true` (or `PLATFORM_HARDEN=false`) to leave host security as it is.

### Uploads storage today

Current releases store uploads in the bundled object storage (`platform-uploads` bucket in MinIO) or the default storage provider. On v1.2.0 and earlier they lived in `/app/uploads` in the API container.

### Automatic schedules

- `platform-auto-update` is the digest-refresh CronJob: it pulls newer images for the same tag. `AUTO_UPDATE=true` (the default) installs it. It keeps the `ALLOW_LOCAL_IMAGES` local-image fallback.
- `platform-auto-upgrade` is the release CronJob, installed only with `AUTO_UPGRADE=true`. It picks the newest stable patch in the installed minor from the latest 100 GitHub releases. If it cannot reach GitHub, it keeps the installed release. No change means no backup and no migrations. It needs no token.
- Provision and successful upgrades reconcile both schedules independently.
- The release Job uses the same root host access (`hostPID`, `nsenter`) as the backup CronJob, has resource limits, runs on a control-plane node, uses `concurrencyPolicy: Forbid`, and takes the shared provision and upgrade lock.

### Release testing (maintainers)

- The `upgrade` job in `e2e-vm.yml` tests a minimal-profile VM on release tag pushes and on manual runs that target a release. `upgrade_from` picks the source tag; empty picks the highest published version below the target, including pre-releases.
- The source binary is checksum-verified, provisions its own image tag, then upgrades to the target. A source without the command reports an explicit skip. Download, checksum, provisioning, upgrade and verification failures fail the job.
- It seeds an admin session, a project, a project secret and a stored object through the API, runs the standard checks after the upgrade, then verifies the project, the secret record, the object bytes, a fresh login and the original session. It does not verify secret decryption or two-factor sign-in. See [End-to-end CI](e2e-ci.md).
- Manual release validation on Ubuntu 24.04 (4 vCPU, 8 GiB): provision the previous minor, configure and test encrypted backups, seed data, upgrade, and verify data, chart revisions, digests, readiness and both history copies. Repeat with a failing target health endpoint and check that rollback restores health and data. Also test low disk or memory, an unhealthy pod, an active operation, an unreachable backup target, offline cached images and charts, and a failed irreversible migration with restore denied and approved. Local fake-runner tests do not prove zero data loss.
