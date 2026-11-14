# Back up and restore your server

Make encrypted, off-site backups of your whole Cairn server and restore them onto a new server. You run backups with `platformctl` on the server. The result of the latest backup and restore test shows at the top of **Settings** in the portal, under **Disaster recovery backups** (DevOps role).

A backup covers the platform settings and passwords, PostgreSQL, MongoDB, Redis, uploaded files and the cluster state. It is encrypted on the server with a key that only you hold, then sent to S3-compatible storage such as AWS S3, Cloudflare R2 or Backblaze B2.

## Set up backups

You need: a bucket at an S3-compatible provider, and a computer other than the server to keep the private key on.

1. On your own computer, create a key pair with [age](https://age-encryption.org) (a small file-encryption tool):

   ```bash
   age-keygen -o identity.txt
   ```

   It prints the public half, which starts with `age1`. Keep `identity.txt` off the server, for example in a password manager. Without it, nobody can decrypt the backups.

2. On the server, install the tools the backup uses: `sudo apt-get install -y sqlite3 jq`, plus `mc`, the command-line client for S3-compatible storage.
3. As root, add an `mc` alias (a saved name for your bucket's address and keys), for example `offsite`:

   ```bash
   sudo mc alias set offsite https://<account-id>.r2.cloudflarestorage.com <access-key> <secret-key>
   ```

4. Save the backup settings, giving only the public half of your key:

   ```bash
   sudo platformctl backup init --target s3://offsite/platform/server-a \
     --recipient age1YOUR_PUBLIC_KEY
   ```

5. Take a backup, list backups and turn on nightly backups:

   ```bash
   sudo platformctl backup --all
   sudo platformctl backup list
   sudo platformctl backup schedule
   ```

6. From your computer, check that the newest backup can be restored. This does not touch live data:

   ```bash
   cat identity.txt | ssh you@server 'sudo -n platformctl backup restore-test'
   ```

Nightly backups run at 02:15 UTC. By default Cairn keeps the newest backup of each of the last 7 days, 4 weeks and 12 months.

> [!WARNING]
> Plain `platformctl backup`, without `--all`, only copies settings and passwords to a folder on the same server. It is not encrypted and does not survive losing the disk.

## Restore on a fresh server

Use the same Cairn version and domain as the old server. On the new Ubuntu server, add the same `mc` alias as before. Keep the private key on your computer and send it over SSH: it is read from standard input, held in memory and never written to the server.

**Install and restore in one step:**

```bash
cat identity.txt | ssh you@new-server \
  'sudo -n env DOMAIN=example.com ADMIN_EMAIL=ops@example.com platformctl provision --auto \
     --restore-from s3://offsite/platform/server-a BACKUP_ID'
```

`BACKUP_ID` is the folder name under the target. Get it from `platformctl backup list` on the old server, or with `sudo mc ls offsite/platform/server-a/` on the new one. The key is checked before the install starts.

**Restore onto a server that is already installed:**

```bash
cat identity.txt | ssh you@new-server \
  'sudo -n platformctl restore --target s3://offsite/platform/server-a --from BACKUP_ID --confirm'
```

Before you restore, stop your project workloads that write to the platform databases. Afterwards, check that an old user can sign in, the projects are listed, a secret value decrypts, and an uploaded file opens. Then turn GitOps auto-sync and your project workloads back on.

> [!CAUTION]
> Restore replaces data and cannot be undone halfway. If it fails after a database step, run `sudo platformctl recover`, then retry the restore.

## Back up one project database

To back up a single project's PostgreSQL database from the portal (DevOps role):

1. Open the project and go to **Data**.
2. Under **Database backups**, type the database name, for example `plat_<project>_production`. It is the `POSTGRES_DB` value in the project's **Configuration**.
3. Select **Back up now**. Select **Refresh** after a minute to see the status.
4. To restore, select **Restore** on a completed backup. This overwrites the current database contents.

The backup goes to the default storage provider. See [File storage providers](storage-providers.md). The portal backs up the **production** environment's database.

## Check that backups keep working

- **Settings** in the portal shows the latest backup and the latest restore test: passed or failed, when, size and duration.
- Admin and DevOps users get a portal notification for every failed backup and every restore-test result.
- If monitoring is installed, `platformctl backup schedule` also adds alerts. They fire when a backup fails, when there has been no successful backup for 26 hours, when the status is missing, when a restore test fails or is older than 8 days, and when a backup job fails.

## Recover to a point in time (high availability only)

On the `ha` profile, PostgreSQL can be restored to an exact moment, for example just before a bad migration:

```bash
sudo platformctl restore --pitr 2026-11-12T10:00:00Z --confirm
```

This does not use the age key. See [High availability](ha.md) for the details.

## How it works

### What a full backup does

`platformctl backup --all` is opt-in. It runs the database tools that are already inside the database containers through `kubectl exec`, uses SQLite's online backup (or k3s embedded-etcd snapshots) for the cluster, `mc` for files, and age encryption built into platformctl. No backup service runs in the background.

Every backup or restore checks for the tools it needs before touching anything and names any that are missing. platformctl and `kubectl` must be on root's `PATH`. The scheduled job runs `/usr/local/bin/platformctl`.

### Settings

- `backup init` writes `/etc/platform/backup.json` (mode 0600). It holds only the target and the public key. It refuses to overwrite an existing file.
- If you omit `--recipient`, `backup init` generates a key and prints the private half **once** without saving it. Do this in a private terminal without session logging and move the key off the server at once.
- Retention flags on `backup init`: `--keep-daily` (default 7, at least 1), `--keep-weekly` (4) and `--keep-monthly` (12).
- `--components` lists what to protect. The default is `config,postgres,mongo,redis,minio,k3s`; `config` and `postgres` are required. Remove components your install does not have, for example `--components config,postgres,k3s`. A selected component that is missing makes the backup fail; nothing is silently skipped.
- `--target` overrides the saved target for one `backup`, `list` or `restore`. `file:///var/lib/platform/encrypted-backups` works for local staging, with a warning that local storage cannot survive disk loss.
- An `s3://` target names an `mc` alias, not a hostname. Use a dedicated bucket or prefix and allow list, get, put and delete there. B2 must use its S3-compatible endpoint. Never put credentials in the target URL. Make sure the alias really points off-site: the bundled MinIO is on the same server even when reached over S3.
- The bundled MinIO is the default **source** of files. platformctl builds a temporary `mc` alias from the `minio` Secret and its cluster IP, held only in the process environment. To use another source, add `"minioAlias": "<root mc alias>"` to `backup.json`. Never point it at the backup destination.

### Nightly job

`backup schedule` installs the `platform-backup-nightly` CronJob and, when the monitoring stack is present, the `monitoring/platform-backups` alert rules. It only works with the default settings path. The job:

- runs at 02:15 UTC, never overlaps, and has a four-hour deadline;
- has low priority, requests 50m CPU and 64Mi memory, is limited to 1 CPU and 512Mi, and runs with `nice` and `ionice`;
- uses a privileged pod in the host's process namespace, to take k3s snapshots and read installer credentials. This is root-level host maintenance; restrict who can change this CronJob;
- takes the installer's shared lock, so backup, restore, provision and repair never run at the same time.

### Contents and format

Each backup has a unique UTC ID. `backup.json` in the backup is a version-1 manifest with `version`, `id`, `createdAt`, `platformVersion` and `artifacts` (component, file name, SHA-256 of the encrypted file and its size). Each artifact is an age-encrypted tar named `<component>.tar.age`. No private key is stored. The manifest is uploaded last and marks the backup complete, so failed uploads are never listed. Partial uploads can be removed by hand from the prefix. Checksums detect damage, but a manifest is not a signature: keep a trusted copy or use bucket object locking or versioning.

Database passwords are read inside the database containers, from the environment variable or the `*_FILE` password file, never on the host or in command arguments.

- **PostgreSQL:** `pg_dumpall --globals-only` (roles, with their passwords) plus one `pg_dump -Fc` per database.
- **MongoDB:** `mongodump --archive --gzip`, including users.
- **Redis:** `BGSAVE`, wait for it to finish, then copy `/data/dump.rdb`.
- **Files:** `mc mirror` of every source bucket except `platform-backups`, so backups do not contain older backups. Bucket policies, lifecycle rules, object versions, IAM and outside providers are not captured; reapply them separately.
- **Config:** the installer's `.env` and credential files; Secrets from the `platform`, `databases`, `storage`, `argocd` and `cert-manager` namespaces; Argo CD Applications; cert-manager Issuers and ClusterIssuers; the public `backup.json`. Service-account tokens and Helm release records are left out on restore. The original secrets encryption key and JWT key are in `.env` and `platform-env`, so encrypted project secrets stay readable.
- **k3s:** single-server SQLite uses `sqlite3 .backup`, which includes committed transactions without stopping k3s. Embedded etcd uses `k3s etcd-snapshot save`. The server token is encrypted alongside, because it is needed to decrypt k3s bootstrap data. External SQL datastores are not supported.

Each database is captured consistently on its own, but not in one transaction across databases and buckets. Pause app writers if you need one coordinated point. Leave disk space for the largest unencrypted component plus the encrypted files. Temporary folders are 0700 and files 0600; they are removed on a normal exit. Use encrypted disks: deleting a file is not secure erasure after a crash.

Retention keeps the newest backup on each of the newest N UTC dates, M ISO weeks and K months, and keeps the union. Old backups are pruned only after a new manifest is uploaded, and only the objects their manifests list are deleted.

### Restore steps

All selected files are checked (size, checksum and decryption) in private staging **before** any live service changes. Then platformctl:

1. scales `platform-api` to zero;
2. restores data with the new cluster's credentials: PostgreSQL (roles, databases, then the original `postgres` password last), MongoDB (`--drop`, including users), Redis (the RDB file into its volume, with the append-only file rebuilt) and files;
3. restores config **last**: Secrets, Argo CD Applications, cert-manager issuers, `/etc/platform/.env` and credentials, then restarts MinIO and Redis so they use the restored credentials;
4. scales `platform-api` back up and restarts the platform deployments so every pod reads the restored Secrets.

Users, projects, encrypted project secrets, database rows and files come back, and old passwords work. A full restore skips the k3s artifact: the new cluster is kept and data and config are restored into it.

- `--restore-from` needs `--auto`, because standard input carries the key. `--restore-id BACKUP_ID` is the same as the positional ID.
- `backup list` reads `/etc/platform/backup.json` even when you pass `--target`, so it fails on a new server that has no backup settings yet. Use `mc ls` there.
- `--target` on `restore` is needed only while `/etc/platform/backup.json` does not exist (the config artifact restores it).
- `--component postgres` (or `config`, `mongo`, `redis`, `minio`) restores one component.
- PostgreSQL restore expects a freshly installed server. Existing non-default roles may conflict and make the restore fail.
- On the `ha` profile, MongoDB is dumped from and restored to the replica set primary, Redis is captured from the current Sentinel primary and restored onto every node's volume, and files are mirrored through the `minio` Service.
- Install the same chart and database major versions before a logical restore.

### Offline k3s datastore restore

Use this apart from the normal restore, with k3s **stopped** and nothing using the cluster. Use the same k3s version, the original node identity and compatible network settings. Stream the key to `platformctl restore --from ID --component k3s --confirm`. It refuses to replace an active datastore. For SQLite, the existing database folder is moved to `db.before-restore-<timestamp>`. For etcd, it runs `k3s server --cluster-reset` with the snapshot. Both restore the original server token. Start k3s afterwards, check the cluster and storage, then restore data. Datastore snapshots do **not** include volume contents.

### Restore test

`platformctl backup restore-test [--from ID]` reads the key from standard input, takes the latest complete backup by default, checks its PostgreSQL artifact and restores each dump into a unique scratch database. It skips role SQL, ownership and permissions. It checks that the platform schema has at least one user and the projects table. Scratch databases and temporary files are cleaned up on pass and fail. It needs spare PostgreSQL disk and CPU while it runs.

The weekly GitHub workflow `backup-restore-drill.yml` runs this test over SSH. Set the repository variable `BACKUP_DRILL_ENABLED` to `true` and add the secrets `BACKUP_SSH_HOST` (`user@host`), `BACKUP_SSH_KEY`, `BACKUP_SSH_KNOWN_HOSTS` and `BACKUP_AGE_IDENTITY` to the `backup-drill` environment. Limit that SSH user and sudo rule to this command. It runs from outside because a CronJob on the server would need the private key stored there. If SSH or the runner fails, the failure shows only in GitHub Actions; set up failure notifications there.

### Status reporting

Every backup and restore test reports its result three ways:

- **Prometheus metrics** `platform_backup_success`, `platform_backup_last_success_timestamp_seconds`, `platform_backup_size_bytes`, `platform_backup_duration_seconds` and `platform_backup_completed_timestamp_seconds`, labelled `operation="backup|restore-test"`. They are written to `/var/lib/platform/metrics/*.prom` on the host and collected by node-exporter's textfile collector. On servers installed before this existed, run `sudo platformctl repair` to enable the collector.
- **ConfigMaps** `platform/platform-backup-backup` and `platform/platform-backup-restore-test` with the latest result, last success, size and duration. The portal's **Settings** reads these. No keys, URLs or dump details are exposed.
- **Portal notifications** to admin and DevOps users, written through the running API's database connection.

The alert rules are `PlatformBackupStatusMissing`, `PlatformBackupFailed`, `PlatformBackupStale` (26 hours), `PlatformRestoreTestFailed`, `PlatformRestoreTestStale` (8 days) and `PlatformBackupCronJobFailed` (failed `platform-backup-*` Jobs, which catches crashes before a status is written). Installs without monitoring rely on portal notifications. If writing the status fails, that is logged and the backup itself still counts.

### Project database backups

The **Database backups** panel runs `pg_dump` of the named database, uploads it to the default storage provider (or the built-in backup store when there is none) as `backups/<projectId>/<backupId>.dump`, and records a checksum. Restore downloads the dump from the provider it was saved to, checks the checksum, then runs `pg_restore`. If SMTP is set up, DevOps users get an email when a backup completes. The database name must match the project's PostgreSQL database for the environment.

### Limits

- Files on host disk, local storage and outside storage providers are not included. Move them into the bundled storage, or protect them with the provider's own tools.
- Kubernetes namespaces and Secrets outside the listed namespaces are not included.
- Restore uses the same release's database schema. Run the migration job only when you upgrade after a successful restore.
- `platformctl upgrade` takes a full encrypted backup before it changes anything when `/etc/platform/backup.json` exists. Without it, upgrade takes only a local database and credentials copy and warns that this does not protect against disk loss.
- Outside the `ha` profile, backups are logical dumps at one point in time; there is no continuous recovery.
- A full nightly test that installs one server, destroys it and restores onto a second has not been wired up yet. Fresh-server restores with live S3, Redis volumes, MongoDB and k3s are covered by unit tests only.

## For developers / API

Operator sign-in (DevOps role) is required.

| Request | Returns |
|---|---|
| `GET /api/settings/backups` | Latest backup and restore-test status as JSON |
| `GET /api/settings/backups/metrics` | The same data in Prometheus text format |
| `POST /api/projects/<projectId>/databases/backup` with `{ "dbName": "...", "environment": "production" }` | Starts a project database backup |
| `GET /api/projects/<projectId>/databases/backups` | The project's last 50 database backups (viewer access) |
| `POST /api/projects/<projectId>/databases/backups/<backupId>/restore` | Restores a completed backup |

For manual commands, see [Manual backup procedures](../deployment/backup-and-restore.md).
