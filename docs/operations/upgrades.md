# Release upgrades

Run on the Linux control-plane host as root. Use the release's `platformctl`
binary, or let `upgrade` download it and run the target binary. Downloads are
checked against `checksums.txt`; GitHub asset failures fall back to the GHCR
platformctl artifact, with layer digests verified as well.

```sh
sudo platformctl upgrade --to vX.Y.Z --dry-run
sudo platformctl upgrade --to vX.Y.Z
sudo platformctl upgrade --history
```

`--to` defaults to the latest stable GitHub release and must name a published
release: a tag that GitHub reports as missing (404) is refused, and during a
GitHub outage the release must exist in the GHCR mirror. `--allow-unreleased`
skips that check for testing a local build whose binary and images are already
on the host. `--yes` confirms the displayed plan for automation. A saved successful upgrade takes precedence over
the saved image tag when determining the source version. For an installation
without upgrade history, ensure its saved `PLATFORM_IMAGE_TAG` reflects its
installed release. Unstamped development builds must be replaced with a release binary.
Downgrades and skipping majors are refused. Without `upgrade.json`, only
same-major upgrades are allowed. Release maintainers edit
`platformctl/upgrade-policy.json` to set `minimumSource`, `breakingNotes`, and
`irreversibleMigrations`; the release workflow attaches `upgrade.json` containing
these rules and the target binary's chart pins and mirrors it to GHCR.

## First upgradable release

Release upgrades work from the first published release containing `platformctl
upgrade` onwards. Releases published before #27 do not contain that command;
a target without it cannot perform the target-binary handoff. No published
release contained it when #115 was opened. Confirm the release contents rather
than assuming a particular rc number is the first upgradable release.

For an older installation, install the **target** release's platformctl using
`install.sh`, then upgrade the existing cluster (do not provision it again):

```sh
curl -fsSL https://github.com/Mpratyush54/server-automation/releases/download/<target>/install.sh -o install.sh
sudo env PLATFORMCTL_VERSION=<target> bash install.sh
sudo platformctl upgrade --to <target> --yes
```

Replace `<target>` with a published release tag containing `upgrade`. The
installer changes the CLI; `upgrade` changes the cluster. Older mutable images
must first be digest-pinned with `platformctl update`, as described below.
Unstamped builds (`dev`, empty, or other non-release versions) must also be
replaced with a release binary before using upgrade.

The `upgrade` job in `e2e-vm.yml` tests a minimal-profile VM on release tag
pushes and manual dispatches targeting a release. `upgrade_from` selects the
source tag; empty selects the highest published version below the target from
the paginated GitHub releases API, including pre-releases. The source binary
is checksum-verified, provisions its own image tag, and performs the upgrade
to the target. A source without the command emits an explicit skip notice;
download, checksum, provisioning, upgrade and verification failures fail the job.
It seeds an admin session, project, project secret and MinIO object through the
API, runs the standard checks after upgrade, then verifies the project, secret
record, object bytes, fresh login and original session. This does not verify
secret decryption or MFA. Logs are redacted, artifacts uploaded and VM teardown
always attempted. Promotion requires fresh-install tests and a successful or
skipped upgrade job. See [e2e CI](e2e-ci.md) for inputs and remaining VM tests.

## Preflight

Preflight requires 2 GiB free under `/var/lib`, 512 MiB available memory,
Ready pods in `platform`, `databases`, and `storage` (completed Jobs are allowed),
no active operations, and a readable configured backup destination. Repair the
reported resource or target before retrying. Root queries the `platform`
database directly using `kubectl -n databases exec` and `psql` in the PostgreSQL
pod. The password is resolved inside that container from `POSTGRES_PASSWORD`
or `POSTGRES_PASSWORD_FILE`, using the same helper as backups. No API token is
needed. The query counts all `pending`, `running`, and `compensating` operations;
a refusal includes the count and five newest operations' type, status, and
`updatedAt`. Older installations without the operations table count as zero;
connection, permission, and other query errors stop the upgrade.
Arrange a maintenance window and prevent new administrative mutations during
the upgrade; the installer lock excludes other installer/backup processes,
but does not lock new API operations.

Existing images must already use digests so rollback can restore exact images.
Use the existing `platformctl update` once to adopt digest pins on an older
installation. Confirm backup recovery before upgrading that installation.

## Transaction and recovery

The plan lists changed installed chart releases and platform images. Releases
are matched to pinned charts by exact chart name (`loki-stack-2.10.3` is the
`loki-stack` chart, never `loki`). Components missing from the cluster are
handled after the transaction (see below); k3s/Helm themselves are not upgraded.
Charts use provision's local chart cache and upstream/GHCR fallback, preserve
existing values, and upgrade with `--atomic`. Review chart major-version
migration requirements in the changelog before confirming.

Upgrade uses the same encrypted `backup --all` engine when backup configuration
exists and records its backup ID. Otherwise it warns and records a **local-only**
database dump/credential snapshot. The existing migration Job path also takes
its own local pre-migration dump and waits for the target API migrations.
Readiness gates wait for API/portal rollouts, API readiness, the API schema
check (`/api/health/schema`: every table, column, index and constraint the API
needs exists), portal HTTP 200, OIDC discovery HTTP 200, and Argo CD HTTP 200
when its Service exists. All gates have finite command/request timeouts. When
the gate runs against an older API (after a rollback), a missing
`/api/health/ready` falls back to `/api/health` and a missing schema check is
skipped, so a rollback to a release such as v1.2.0 can pass its gate.

The migration Job runs on every upgrade, provision and `platformctl update`
(it is idempotent), not only when the API image changed. After applying
pending migrations it compares the schema with the API's entities. Missing
objects are repaired by re-running the idempotent migrations; if anything is
still missing the Job fails, the upgrade stops and is not reported as
succeeded. Other differences (types, defaults) are logged, never applied.

On success, `PLATFORM_IMAGE_TAG` in `/etc/platform/.env` is rewritten
atomically to the new release after the health gate passes, so later
`platformctl install ...` or `provision` runs use the upgraded images. A failed
or rolled-back upgrade leaves the file at the previous release. Re-running
`upgrade` at the installed release repairs a tag left behind by an older
platformctl.

Any chart, image or health failure restores previous image digests and Helm
revisions in reverse order, then repeats health gates. Errors include rollback
failures requiring operator attention. Forward-compatible schema migrations
remain in place when images roll back.

**Rolling back to v1.2.0 (or any release that synchronizes its schema on
boot)**: when that API starts, it drops columns, indexes and constraints it does
not know, while the migrations table still lists them as applied. The next
`platformctl upgrade` re-runs the migration Job, which detects the missing
objects and re-creates them (log lines `schema drift: ... missing` and
`schema repaired`). Data that lived in the dropped columns is gone; restore
the pre-upgrade backup if it matters.

Database restore is considered only when a migration **failed** and the release
declares it irreversible. Interactive runs ask separately. `--yes` never grants
restore permission: use `--restore-failed-migration` explicitly and supply the
backup's age identity on stdin. This uses the existing PostgreSQL restore engine
and checks recovery health. With encrypted backups, PostgreSQL recovery restores
the configured PostgreSQL component, including project databases; stop project
writers beforehand. With only a local dump, the same separate consent permits
stopping API writers and restoring the recorded platform database dump; no age
identity is needed. The password and archive are streamed through stdin to
`pg_restore`, and the API resumes afterward. Test recovery before unattended
use, and prefer encrypted off-site backups for protection against disk loss.

An interruption (power loss/process kill) cannot execute rollback. Inspect the
last `started` record, its plan and backup, then restore the recorded Helm
revisions/images manually before retrying. Do not delete evidence of a partial
upgrade. History is an append-only event log in
`/var/lib/platformctl/state/upgrade-history.json`, mirrored to
`platform/platform-upgrade-history` (`history.json`). The ConfigMap retains
recent events below Kubernetes size limits; the local file keeps all events.
History write failures are reported, rather than claiming an unaudited success.

Digest-refresh schedules are suspended before the backup; a running digest-refresh
Job must finish first. Failed upgrades restore the previous suspension setting.
After a successful transaction the target executable is installed atomically
at `/usr/local/bin/platformctl`, then the auto-update schedule is reconciled.
Failure of this final host/schedule maintenance is reported separately from the
successful release upgrade and needs operator repair.

## Components after the release

The release transaction only changes what is installed. After it is healthy,
`upgrade` brings the installation to the component set of its configured
profile (`PLATFORM_PROFILE` in `/etc/platform/.env`), using the same steps as
`provision`:

- installs components the profile now includes but the host lacks (for
  example full-profile telemetry and synthetics on an install from v1.2.0);
- reconciles PostgreSQL, MongoDB and Redis when their rendered Helm values
  changed (each records a values fingerprint next to its done marker; installs
  from before fingerprints reconcile once), e.g. to add metrics exporters;
- re-applies the platform step (secrets, RBAC and Deployment spec of the new
  release, with the same digest-pinned images) and the idempotent ingress,
  telemetry, synthetics and Kyverno steps.

`--dry-run` and the confirmation prompt print this list with the workloads each
change restarts, for example:

```text
Components (profile full) reconciled after the release is healthy:
  - postgresql     reconcile (Helm values changed); restarts: postgresql-0 (connections drop for ~30s; the API reconnects)
  - redis          reconcile (Helm values changed); restarts: redis-master-0, redis-replicas-0 (project Redis users are re-created by the API)
  - platform       re-apply; restarts: platform-api and platform-portal (rolling, one pod at a time) when the Deployment spec or configuration changed
  - telemetry      install; restarts: Grafana and Prometheus (kube-prometheus values change); legacy loki-stack without a volume is replaced
```

Database restarts interrupt project connections briefly; schedule the upgrade
in a maintenance window. A component failure is reported after the release
succeeded; fix the cause and run the same `upgrade` command again (at the
installed release it only runs the component reconcile). No manual editing of
`/etc/platform/.bootstrap_state` is needed.

The alerting and synthetics RBAC the new API uses is applied before the API
rollout, so it does not answer 403 until the telemetry step runs. A legacy
`loki-stack` release (default monitoring before the full profile) is replaced
by the telemetry step only when it has no persistent volume; see
[telemetry](telemetry.md#upgrade-from-loki-stack).

Project Redis users are re-created by the API within about 15 seconds of a
Redis restart (Redis keeps ACL users in memory only).

Re-running `provision` on an existing server re-applies the host security
baseline; it prints a notice first (interactive runs ask). Set
`SKIP_HARDENING=true` (or `PLATFORM_HARDEN=false`) to leave host security as is.

## Uploads stored in the API container (v1.2.0 and earlier)

Releases up to v1.2.0 store uploaded files in `/app/uploads` inside the API
container, without a volume. Every API pod replacement loses them, including
`platformctl update` and the upgrade's own rollout. Files already lost cannot be
recovered. Current releases store uploads in the bundled MinIO
(`platform-uploads` bucket) or the default storage provider.

`upgrade` archives `/app/uploads` of every API pod to
`/var/lib/platform/backups/uploads-<timestamp>/<pod>.tar` before changing
anything. To keep a copy yourself before running anything that restarts the
API (including `platformctl update`):

```sh
for p in $(sudo kubectl -n platform get pods -l app=platform-api -o name); do
  sudo kubectl -n platform exec "$p" -c api -- tar -C /app -cf - uploads > "upload-${p#pod/}.tar"
done
```

Each API replica has its own directory; a file exists only on the pod that
received it. The file records stay in the database, but their content is not
moved to MinIO; re-upload what you need through the API or portal.

## Automatic upgrades

The existing `platform-auto-update` CronJob remains the digest-refresh path,
including `ALLOW_LOCAL_IMAGES` and its local-image fallback. `AUTO_UPDATE=true`
(the default) installs it with its existing manifest and schedule.

Release upgrades use a separate, opt-in `platform-auto-upgrade` CronJob.
Set `AUTO_UPGRADE=true` (default **false**) in the host's platform configuration
and run `platformctl install auto-update` to install it. Provision
and successful upgrades reconcile enabled schedules independently: either flag
can be enabled without the other. Setting a flag false skips installation; to
stop an already installed schedule, suspend or delete its CronJob explicitly.

The release job runs `platformctl upgrade --patch-only --yes` daily at 04:20 UTC,
selecting the newest stable patch in the installed minor from the latest 100
GitHub releases. Minor/major changes remain manual. An offline lookup retains
the installed release and preserves the resolver's local-image fallback. No
changes means no backup or migrations. It needs no token. Its root host boundary
(`hostPID`/`nsenter`) matches the backup CronJob, with explicit resource limits
and control-plane node selection. `concurrencyPolicy: Forbid` prevents overlapping
scheduled Jobs, and upgrades retain the shared provision/upgrade lock. The
digest-refresh schedule is suspended during a release transaction, and a running
digest-refresh Job must finish before it can proceed.

## VM release validation

On Ubuntu 24.04 (4 vCPU/8 GiB), provision the previous minor, configure and test
encrypted backups, seed platform/project data, and run a candidate upgrade.
Verify data, chart revisions, digests, readiness, and both history copies.
Repeat with a deliberately failing target health endpoint; verify previous
digests/revisions become healthy and seeded data survives. Exercise insufficient
disk/RAM, an unhealthy pod, an active operation, an unreachable backup target,
offline cached images/charts, and a failed irreversible migration with denied
and explicitly approved restore. These require a real k3s VM and release assets;
local fake-runner tests do not establish the zero-data-loss acceptance criterion.
