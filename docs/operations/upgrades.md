# Release upgrades

Run on the Linux control-plane host as root. Use the release's `platformctl`
binary, or let `upgrade` download it and run the target binary. Downloads are
checked against `checksums.txt`; GitHub asset failures fall back to the GHCR
platformctl artifact, with layer digests verified as well.

```sh
sudo --preserve-env=PLATFORM_UPGRADE_TOKEN platformctl upgrade --to vX.Y.Z --dry-run
sudo --preserve-env=PLATFORM_UPGRADE_TOKEN platformctl upgrade --to vX.Y.Z
sudo platformctl upgrade --history
```

`--to` defaults to the latest stable GitHub release. `--yes` confirms the
displayed plan for automation. A saved successful upgrade takes precedence over
the saved image tag when determining the source version. For an installation
without upgrade history, ensure its saved `PLATFORM_IMAGE_TAG` reflects its
installed release. Development builds need a valid source release version.
Downgrades and skipping majors are refused. Without `upgrade.json`, only
same-major upgrades are allowed. Release maintainers edit
`platformctl/upgrade-policy.json` to set `minimumSource`, `breakingNotes`, and
`irreversibleMigrations`; the release workflow attaches `upgrade.json` containing
these rules and the target binary's chart pins and mirrors it to GHCR.

## Preflight and authentication

Provide an admin/devops bearer token in `PLATFORM_UPGRADE_TOKEN`, or in a
root-owned mode-0600 `/etc/platform/upgrade-token` file for scheduled upgrades.
Keep tokens out of shell history and logs. The token is sent through stdin to
an in-cluster request to `platform-api.platform.svc.cluster.local`; the public
ingress is never used. Expired or insufficient tokens stop upgrades.

Preflight requires 2 GiB free under `/var/lib`, 512 MiB available memory,
Ready pods in `platform`, `databases`, and `storage` (completed Jobs are allowed),
no active operations, and a readable configured backup destination. Repair the
reported resource or target before retrying. The current operations API has no
active filter or pagination and caps results at 100. Upgrade checks terminal
statuses (`succeeded`, `failed`, `compensated`) and refuses when the result
window reaches 100: an API follow-up must add a complete active-operation query
before such an installation can safely proceed. No unsafe bypass is provided.
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

Legacy digest-only schedules are suspended before the backup; a running legacy
Job must finish first. Failed upgrades restore the previous suspension setting.
After a successful transaction the target executable is installed atomically
at `/usr/local/bin/platformctl`, then the auto-update schedule is reconciled.
Failure of this final host/schedule maintenance is reported separately from the
successful release upgrade and needs operator repair.

## Automatic upgrades

Provision and successful upgrades install a CronJob running the **same**
`platformctl upgrade --patch-only --yes` path. It selects the newest stable patch
in the installed minor from the latest 100 GitHub releases. Minor/major changes
remain manual. An offline lookup retains the installed release and preserves
the shared resolver's existing local-image fallback. No changes means no backup
or migrations. The root host-maintenance boundary (`hostPID`/`nsenter`) matches
the existing backup CronJob; it has explicit resource limits and runs only on
control-plane nodes. There is no new always-running service. Supply the token
file before enabling the schedule; missing tokens fail closed. Disable scheduling
with the existing `AUTO_UPDATE=false` installation setting, or suspend the
CronJob. Upgrades never fall back to the legacy unguarded image updater.

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
