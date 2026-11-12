# Encrypted server backups and disaster recovery

`platformctl backup --all` is opt-in. It uses installed database tools through
`kubectl exec`, SQLite's online backup API (or k3s embedded-etcd snapshots), `mc`,
and age encryption compiled into platformctl. No resident backup controller is
installed. Plain `platformctl backup` retains the older local credential-copy
behavior for compatibility; those copies are **not encrypted or off-site**.

## Setup

On the Ubuntu k3s server install `sqlite3` and `jq` (`apt-get install -y sqlite3 jq`)
and the MinIO `mc` client. platformctl and `kubectl` must be on root's PATH
(`/usr/local/bin/platformctl` for the scheduled job). Every backup/restore checks
for the tools it needs before touching anything and names any that are missing.
Configure a root `mc` alias for the destination S3/R2/B2 endpoint, using
provider-scoped credentials. Use a dedicated destination bucket/prefix and allow
list, get, put, and delete there. B2 must use its S3-compatible endpoint. No
credentials belong in target URLs.

Generate an age identity on a trusted workstation; retain it in an off-server
password manager. Supply only its **public recipient** to the server:

```sh
sudo platformctl backup init --target s3://offsite/platform-recovery/server-a \
  --recipient age1YOUR_PUBLIC_RECIPIENT
```

Alternatively, omit `--recipient`: setup prints a newly generated private
identity **once** and saves only the recipient. Do this in a private terminal
without session logging and move the identity off-server immediately. The
command refuses to overwrite existing configuration.

The bundled MinIO is the default object **source**: platformctl derives a
temporary `mc` alias from the `minio` Secret and its ClusterIP (reachable from
the k3s host), held only in the process environment. To use a different source,
add `"minioAlias": "<root mc alias>"` to `/etc/platform/backup.json` (0600); never
point it at the backup destination. Components default to `config, postgres, mongo,
redis, minio, k3s`. Remove components absent from your install profile using
`backup init --components config,postgres,k3s`, or edit the JSON. Missing required
components/tools cause failure; they are never silently omitted. Minimal installs
need no backup controller or monitoring stack. Scheduling is explicitly enabled
on any profile, not part of provision by default.

```sh
sudo platformctl backup --all
sudo platformctl backup list
sudo platformctl backup schedule
```

`backup schedule` installs the CronJob and, when the monitoring stack is present
(PrometheusRule CRD exists), the `monitoring/platform-backups` alert rules.

`--target` overrides the configured target for a one-off backup/list/restore.
`file:///var/lib/platform/encrypted-backups` is supported for local staging;
the CLI warns that local storage cannot survive disk loss. An `s3://` URL uses
an **mc alias**, not a raw hostname: the operator must verify that alias points
off-site. Bundled MinIO is local-only even when addressed through S3.

The nightly `platform-backup-nightly` CronJob runs at 02:15 UTC, forbids overlap,
has a four-hour deadline, low PriorityClass, 50m/64Mi requests and 1 CPU/512Mi
limits, and invokes `nice`/`ionice` on the host. It uses a privileged hostPID pod
to enter the host namespaces for k3s snapshots and installer credentials. This
is host maintenance with root authority; restrict who can modify this CronJob.
Database exec processes share the database pods' existing resource limits.
It takes the installer's shared lock so backup, restore, provision and repair
cannot run together. Schedule installation requires the default config path.

## Contents and format

Each backup has a unique UTC ID. `backup.json` is a version-1 JSON manifest:
`version`, `id`, `createdAt`, `platformVersion`, and `artifacts` (component,
filename, SHA-256 of ciphertext, ciphertext byte length). Each artifact is an
age-encrypted tar, named `<component>.tar.age`. No private identity is stored.
All selected artifacts upload before the manifest, which acts as the completion
marker. Failed uploads are not listed or retained as successful recovery points;
uncommitted partial artifacts can be removed manually from the dedicated prefix.
Retain a trusted copy of manifests or use bucket object locking/versioning:
checksums detect damage, but a manifest is not a digital signature.

Database passwords are read inside the database containers, from the env var or
the Bitnami `*_FILE` password file, never on the host or in command arguments.

* **Postgres:** `pg_dumpall --globals-only` (including original role passwords),
  plus one `pg_dump -Fc` per non-template database, using container-native tools.
* **Mongo:** `mongodump --archive --gzip` including users/auth data.
* **Redis:** `BGSAVE`, wait for successful completion, copy `/data/dump.rdb`.
* **MinIO:** `mc mirror` of source buckets, excluding `platform-backups` to avoid
  recursively backing up backup history. Objects and bucket names are captured;
  bucket policies, lifecycle, object versions, IAM and external providers are
  not captured by `mc mirror`. Reapply these separately.
* **Config:** installer `.env` and credential files; Secrets from platform,
  databases, storage, argocd and cert-manager namespaces; ArgoCD Applications;
  cert-manager Issuers and ClusterIssuers; the public-only `backup.json`.
  Service-account tokens and Helm release records are omitted on restore. Application secrets' original encryption key and JWT key are in `.env`
  and `platform-env`, so existing encrypted project secrets remain readable.
* **k3s:** single-node SQLite uses `sqlite3 .backup`, including committed WAL
  transactions without stopping k3s. Embedded-etcd uses `k3s etcd-snapshot save`.
  The server token is encrypted alongside the datastore; it is required to decrypt
  k3s bootstrap data. External SQL datastores are not supported by this driver.

Captures are consistent per database, not a distributed transaction across
databases and buckets. Quiesce application writers for a coordinated recovery
point. Provision the same chart/database major versions before logical restore.
Allow disk space for the largest plaintext component plus encrypted artifacts;
temporary directories are 0700, artifacts 0600, and removed on normal exit.
Use encrypted host disks; unlinking files is not secure erasure after crashes.

Retention defaults to 7 daily, 4 weekly, 12 monthly. It keeps the newest backup
in each of the newest N distinct UTC dates, M ISO weeks, and K months and takes
their union. Daily must be at least one. Old completed backups are pruned only
after a new manifest is uploaded. Deletion is limited to manifest-declared
objects. Use a dedicated prefix; incomplete uploads need separate cleanup.

## Restore on a fresh VM

Use the same platform/chart versions and domain as the backed-up server. On the
fresh Ubuntu 24.04 VM, configure root's `mc` alias for the off-site target (same
alias name as in the backup target URL). Keep the age identity on your
workstation and stream it over SSH; it is read from stdin, held in memory and
never written to the server.

**One step** (provision and restore):

```sh
cat /secure/off-server/identity.txt | ssh operator@fresh-server \
  'sudo -n env DOMAIN=example.com ADMIN_EMAIL=ops@example.com platformctl provision --auto \
     --restore-from s3://offsite/platform-recovery/server-a BACKUP_ID'
```

The identity is validated before provisioning starts. `--restore-id BACKUP_ID`
is equivalent to the positional ID. `--restore-from` requires `--auto` because
stdin carries the identity.

**Two steps** (restore onto an already provisioned server):

```sh
cat /secure/off-server/identity.txt | ssh operator@fresh-server \
  'sudo -n platformctl restore --target s3://offsite/platform-recovery/server-a --from BACKUP_ID --confirm'
```

`--target` is only needed while `/etc/platform/backup.json` does not exist (the
config artifact restores it). `--component postgres` (or config, mongo, redis,
minio) selects one component.

All selected ciphertext sizes/checksums and age streams are verified in private
staging **before** any live service is modified. Then platformctl:

1. scales `platform-api` to zero (the main writer; stop project workloads that
   write to platform databases yourself);
2. restores data with the fresh cluster's credentials: Postgres (roles,
   databases, then the original `postgres` password last), Mongo (`--drop`,
   including users), Redis (RDB into the PVC, AOF rebuilt), MinIO objects;
3. restores config **last**: Secrets, ArgoCD Applications, cert-manager issuers,
   `/etc/platform/.env` and credentials, then restarts MinIO and Redis so they
   use the restored credentials;
4. scales `platform-api` back and restarts the platform deployments so every
   pod reads the restored Secrets.

Users, projects, encrypted project secrets (the original encryption/JWT keys are
in `.env` and `platform-env`), DB rows and MinIO objects come back, and logins
work with the old credentials. Full restore skips the k3s artifact: the fresh
cluster is kept and logical data/config is restored into it.

Restore is destructive and not transactional. Postgres expects a newly
provisioned server; pre-existing non-bootstrap roles may conflict and correctly
fail recovery. If a restore fails after a database step, credentials may no
longer match the Secrets: run `sudo platformctl recover`, then retry the restore.
On the `ha` profile, Mongo is dumped from and restored to the replica set primary, Redis is captured from the current Sentinel master and restored onto every node's volume, and MinIO is mirrored through the `minio` Service (see [High availability](ha.md#datastores)). Bucket
policies/IAM are not captured by `mc mirror`; recreate them separately. Re-enable
GitOps auto-sync and project workloads afterwards, and verify old user login,
project list, decrypted secret values, DB seed rows and an uploaded object before
accepting the new server.

### Optional offline k3s datastore restore

Use this separately from logical restore, with k3s **stopped** and no running
cluster consumers. Ensure the same k3s version, original node identity and
compatible network configuration. Stream the identity to
`platformctl restore --from ID --component k3s --confirm`. The command refuses
to replace an active k3s datastore. SQLite's existing DB directory is moved to
`db.before-restore-<timestamp>`; etcd uses `k3s server --cluster-reset` and the
captured snapshot. Both restore the original server token. Start k3s afterward,
verify the cluster and storage, then restore logical data. Datastore snapshots
do **not** include PVC contents. Multi-server recovery is tracked by #53.

## Restore tests, notifications, and alerts

`platformctl backup restore-test [--from ID]` reads an age identity from stdin,
fetches the latest completed backup by default, authenticates its Postgres
artifact, and restores each dump into a unique scratch database. It does not
apply role SQL, ownership or ACLs. It queries the system catalog and requires a
platform schema with at least one user and the projects table. Scratch databases
and container temporary files are cleaned on both pass and failure. Allow spare
Postgres disk/CPU; this is an opt-in maintenance action, not a resident service.

The weekly GitHub workflow `backup-restore-drill.yml` streams the identity from
the `backup-drill` environment. Set repository variable `BACKUP_DRILL_ENABLED`
to `true` and configure `BACKUP_SSH_HOST` (`user@host`), `BACKUP_SSH_KEY`, pinned
`BACKUP_SSH_KNOWN_HOSTS`, and `BACKUP_AGE_IDENTITY` secrets. Restrict SSH/sudo to
this operation. No age identity is saved on the protected server. It runs outside
the server because a self-contained decrypting CronJob would require storing the
private identity there. A cluster CronJob for that test is intentionally not
installed. SSH/runner failures surface in Actions; they cannot update an
unreachable server. Add external Actions failure delivery for that case.

Every backup and restore-test publishes its result three ways:

* **Prometheus metrics**: `platform_backup_success`,
  `platform_backup_last_success_timestamp_seconds`, `platform_backup_size_bytes`,
  `platform_backup_duration_seconds` and
  `platform_backup_completed_timestamp_seconds`, labelled
  `operation="backup|restore-test"`, written to
  `/var/lib/platform/metrics/*.prom` on the host and collected by node-exporter's
  textfile collector (enabled in the monitoring values; on servers provisioned
  before this change run `sudo platformctl repair` to re-apply them). This path
  does not depend on the API or a scrape credential.
* **ConfigMaps** `platform/platform-backup-backup` and
  `platform/platform-backup-restore-test` (latest result, last success, bytes,
  duration). Settings shows them to admin/devops users;
  `GET /api/settings/backups` (JSON) and `GET /api/settings/backups/metrics`
  (Prometheus text) expose the same data with operator authentication. No keys,
  URLs or dump metadata are exposed.
* **Portal notifications** to admin/devops users for every backup failure and
  every restore-test result (pass or fail), inserted through the running API
  pod's DB connection.

Alerts (`backup schedule` applies them when monitoring is installed): failed
backup, no successful backup in 26 h, status missing, failed or stale (8 days)
restore test, and failed `platform-backup-*` Jobs (kube-state-metrics; covers
crashes before status publication). Minimal installs without monitoring rely on
portal notifications. Status publication failure is logged explicitly and does
not invalidate an otherwise complete backup.

## Integration boundaries / remaining validation

* #20 owns stateless API storage. Legacy host uploads, local StorageService data
  and external object providers are not collected here; migrate them into the
  source MinIO buckets or supply provider-native protection before relying on
  disaster recovery. Tenant-specific Kubernetes namespaces/secrets outside the
  listed namespaces require an extension to the config driver.
* #17 owns migration ordering. Restore uses the same release's schema; run the
  versioned migration Job only when upgrading after a successful restore.
* #27 can use `backup --all` as a backup-first upgrade gate. Exit failure if
  capture, upload or retention fails; never treat local credential copies as
  disaster recovery backups.
* #51 tracks Postgres WAL/PITR (CloudNativePG); this implementation is logical
  point-in-time dumps only.
* #25 must wire the full two-VM nightly test: provision VM A (4 vCPU / 8 GB),
  seed users/project/secret/DB row/object, upload to a test S3/R2 prefix, destroy A,
  provision VM B, restore via stdin identity, verify old login and all seed values,
  then destroy B. The weekly scratch test is not a substitute for this test.
  No VM/cloud credentials or ephemeral VM workflow are available in this branch,
  so fresh-VM, live S3, Redis PVC, Mongo and k3s recovery are not certified by
  local unit tests. Do not claim that nightly fresh-VM gate has passed.
