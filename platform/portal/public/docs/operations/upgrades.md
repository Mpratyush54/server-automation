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

`--to` defaults to the latest stable GitHub release. `--yes` confirms the
displayed plan for automation. A saved successful upgrade takes precedence over
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

The plan lists changed installed chart releases and platform images. It does
not install optional charts absent from the cluster or upgrade k3s/Helm itself.
Charts use provision's local chart cache and upstream/GHCR fallback, preserve
existing values, and upgrade with `--atomic`. Review chart major-version
migration requirements in the changelog before confirming.

Upgrade uses the same encrypted `backup --all` engine when backup configuration
exists and records its backup ID. Otherwise it warns and records a **local-only**
database dump/credential snapshot. The existing migration Job path also takes
its own local pre-migration dump and waits for the target API migrations.
Readiness gates wait for API/portal rollouts, API readiness, portal HTTP 200,
OIDC discovery HTTP 200, and Argo CD HTTP 200 when its Service exists. All gates
have finite command/request timeouts.

Any chart, image or health failure restores previous image digests and Helm
revisions in reverse order, then repeats health gates. Errors include rollback
failures requiring operator attention. Forward-compatible schema migrations
remain in place when images roll back.

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
