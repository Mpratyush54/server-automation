# Back up and restore your server

Keep a copy of everything outside your Cairn server, so you can get your data back after a mistake, or rebuild everything on a new server if the old one is lost. Cairn sends backups to one S3-compatible bucket that you choose: AWS S3, Cloudflare R2, Backblaze B2 or a MinIO on another machine.

What goes there:

- the PostgreSQL change log (WAL) and daily database snapshots, so you can restore the database to any moment, for example just before a bad migration;
- encrypted nightly archives of the settings and passwords, PostgreSQL, MongoDB, Redis, uploaded files and the cluster state;
- on the `ha` profile, etcd snapshots and Longhorn volume backups.

The portal shows where backups go, when each kind last ran and how far back you can restore, in **Settings** → **Security** under **Recovery backups** (DevOps role).

## Choose where backups go

You need a bucket and an access key that can list, read, write and delete in it. Use a dedicated bucket, or a folder (prefix) inside one that holds nothing else.

**During installation.** `sudo platformctl provision` asks for the bucket. With `--auto`, give it in the environment. The access key and secret only ever come from the environment, never from the command line: anything typed after `sudo` is saved in the system log and visible to other users while the command runs. Type them into your shell first, then pass them on with `sudo -E`:

```bash
read -rp 'Access key ID: ' BACKUP_S3_ACCESS_KEY
read -rsp 'Secret access key: ' BACKUP_S3_SECRET_KEY; echo
export BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY
sudo -E env BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
  BACKUP_S3_BUCKET=cairn-backups BACKUP_S3_REGION=auto BACKUP_S3_PREFIX=server-a \
  DOMAIN=example.com ADMIN_EMAIL=ops@example.com platformctl provision --auto
```

Leave out `BACKUP_S3_ENDPOINT` for AWS S3 and set `BACKUP_S3_REGION` to the bucket's region. Backblaze B2 needs its S3 endpoint, for example `https://s3.us-west-004.backblazeb2.com`. The flags `--backup-endpoint`, `--backup-bucket`, `--backup-region` and `--backup-prefix` work too.

Before anything is installed, Cairn writes a small test file to the bucket, reads it back and deletes it. If that fails, provisioning stops and says why, for example a wrong key, a missing bucket or a wrong region.

**Later, or to change it:**

```bash
sudo platformctl backup target set --endpoint https://<account-id>.r2.cloudflarestorage.com \
  --bucket cairn-backups --region auto --prefix server-a
sudo platformctl backup target show
sudo platformctl backup target test
```

`set` asks for the access key and secret without showing them. It also reads `BACKUP_S3_ACCESS_KEY` and `BACKUP_S3_SECRET_KEY`, or two lines on standard input with `--credentials-stdin`. It runs the same test, then moves the database change log, the archives and, on `ha`, Longhorn and etcd to the new bucket, and takes a fresh database snapshot.

### Keep backups only on this server

If you really want no off-site copy, say so: pass `--local-backups` to `provision`, or answer no to the question. Backups then go to the bundled storage and a folder on the same server. `platformctl status`, the portal and an alert keep saying **Backups are stored only on this server** until you run `platformctl backup target set`.

## Turn on encrypted nightly archives

The database change log and snapshots start by themselves. The nightly archive of everything else needs a key pair, so that only you can decrypt it.

1. On your own computer, create a key pair with [age](https://age-encryption.org) (a small file-encryption tool):

   ```bash
   age-keygen -o identity.txt
   ```

   It prints the public half, which starts with `age1`. Keep `identity.txt` off the server, for example in a password manager. Without it, nobody can decrypt the archives.

2. On the server, install the tools the archive uses: `sudo apt-get install -y sqlite3 jq`. platformctl talks to S3-compatible targets with its built-in client (no MinIO `mc` on the host).
3. Save the settings with only the public half of the key, take an archive and turn on the nightly run:

   ```bash
   sudo platformctl backup init --recipient age1YOUR_PUBLIC_KEY
   sudo platformctl backup --all
   sudo platformctl backup schedule
   ```

   The archives go to the backup target. Passing `--backup-recipient age1...` to `provision` does this step for you.

4. From your computer, check that the newest archive can be restored. This does not touch live data:

   ```bash
   cat identity.txt | ssh you@server 'sudo -n platformctl backup restore-test'
   ```

Nightly archives run at 02:15 UTC. By default Cairn keeps the newest archive of each of the last 7 days, 4 weeks and 12 months.

> [!WARNING]
> Plain `platformctl backup`, without `--all`, only copies settings and passwords to a folder on the same server. It is not encrypted and does not survive losing the disk.

## Restore the database to a moment in time

To undo a mistake, for example a bad migration at 10:05, restore PostgreSQL to just before it:

```bash
sudo platformctl restore --pitr 2026-11-12T10:00:00Z --confirm
```

This works on every profile. It stops the API, puts all PostgreSQL databases back to that moment and starts the API again. Stop your apps' writes first. MongoDB, Redis and files are not changed. The time must be inside the window shown in **Settings** or `platformctl status`. It does not use the age key.

Servers installed before this release run PostgreSQL without a change log. Move them once, with a few minutes of downtime:

```bash
sudo platformctl postgres migrate --dry-run
sudo platformctl postgres migrate --confirm
```

## Rebuild everything on a new server

Use this when the old server is gone. You need the backup target settings and keys, the age key file and your domain. Use the same Cairn version as the old server.

1. Find the newest archive ID: `sudo platformctl backup list` on the old server while it still runs, or [list the target's `archives/` folder](#look-inside-the-backup-target) from any computer.
2. On the new Ubuntu server, from your computer, send the target's access key and secret to a file only root can read, so they never appear on a command line:

   ```bash
   read -rp 'Access key ID: ' KEY_ID; read -rsp 'Secret access key: ' SECRET; echo
   printf 'BACKUP_S3_ACCESS_KEY=%s\nBACKUP_S3_SECRET_KEY=%s\n' "$KEY_ID" "$SECRET" \
     | ssh you@new-server 'sudo install -m 600 /dev/stdin /root/backup-target.env'
   ```

3. Install Cairn and restore in one step. The age key goes over SSH, is held in memory and is never written to the server. The key file from step 2 is deleted as soon as it has been read:

   ```bash
   cat identity.txt | ssh you@new-server \
     'sudo -n bash -c "set -a; . /root/backup-target.env; set +a; rm -f /root/backup-target.env
        exec env DOMAIN=example.com ADMIN_EMAIL=ops@example.com \
        BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com BACKUP_S3_BUCKET=cairn-backups \
        BACKUP_S3_REGION=auto BACKUP_S3_PREFIX=server-a \
        platformctl provision --auto --restore-from external BACKUP_ID"'
   ```

   `external` means the backup target this provision has just set up. The key is checked before the install starts.

4. Bring PostgreSQL forward from the nightly archive to the last saved change. Look up the old server's archive name, then recover from it:

   ```bash
   sudo platformctl backup target show
   sudo platformctl restore --pitr latest --source-server postgresql-20261101t1200 --confirm
   ```

   `backup target show` lists the archive names under "PostgreSQL archives in the target". The new server's own name is shown in `platformctl status`; pick the other one.

5. Check that an old user can sign in, the projects are listed, a secret value decrypts and an uploaded file opens. Then point DNS at the new server and turn your project workloads back on.

**Restore an archive onto a server that is already installed:**

```bash
cat identity.txt | ssh you@server \
  'sudo -n platformctl restore --target external --from BACKUP_ID --confirm'
```

> [!CAUTION]
> Restore replaces data and cannot be undone halfway. If it fails after a database step, run `sudo platformctl recover`, then retry the restore.

## Practise a restore

Run this drill on a test server every few months, so a real restore is routine. It never touches the production server.

1. **Point in time.** On a test server with its own backup prefix: create a project, note the time, delete the project, then run `sudo platformctl restore --pitr <noted time> --confirm`. The project is back.
2. **Full rebuild.** Create a fresh VM and follow [Rebuild everything on a new server](#rebuild-everything-on-a-new-server) with the production target settings, the newest archive and `--source-server` set to the production archive name. Then sign in and check projects, secrets and files.

   The rebuilt server takes over the production domain, even if you give `provision` a different one. The archive puts back the old `/etc/platform/.env`, the `platform-env` Secret and the Argo CD Applications, and they all name the production domain. So pass the production `DOMAIN`, and keep the drill server out of reach of your users:

   - Do not point DNS or a load balancer at it.
   - To open the portal, add the production hostnames with the test VM's address to the hosts file on your own computer (`/etc/hosts`, or `C:\Windows\System32\drivers\etc\hosts`), and remove them afterwards. The browser may warn about the certificate, because the drill server cannot get one without DNS.
   - If your provider allows it, limit inbound traffic to your own IP address.

3. Write down how long each step took, then delete the test VM. A restore only reads production's backups; it does not change them. While the drill server runs, it saves its own PostgreSQL change log in the same target under its own server name (`postgres/<server name>/`, shown by `platformctl status`). Delete that folder after the drill.

## Back up one project database

To back up a single project's PostgreSQL database from the portal (DevOps role):

1. Open the project and go to **Data**.
2. Under **Database backups**, type the database name, for example `plat_<project>_production`. It is the `POSTGRES_DB` value in the project's **Configuration**.
3. Select **Back up now**. Select **Refresh** after a minute to see the status.
4. To restore, select **Restore** on a completed backup. This overwrites the current database contents.

The backup goes to the default storage provider. See [File storage providers](storage-providers.md). The portal backs up the **production** environment's database.

## Check that backups keep working

- **Settings** in the portal shows where backups go, whether the database change log is being saved and when it last was, the last database snapshot, the window you can restore to, the last full archive and the latest restore test.
- The dashboard lists **Backups are stored only on this server** under things that need attention when there is no off-site target.
- `sudo platformctl status` shows the same, and a warning while backups stay on the server.
- Admin and DevOps users get a portal notification for every failed archive and every restore-test result.
- If monitoring is installed, alerts fire when saving the database change log fails or stalls, when the last database snapshot is older than 36 hours, when there has been no successful archive for 26 hours, when backups stay on the server, and when a restore test fails or is older than 8 days.

## How it works

### The backup target

The target is one S3-compatible bucket and an optional prefix. Each kind of backup has its own folder under the prefix:

| Folder | What | Written by |
|---|---|---|
| `postgres/<server name>/` | PostgreSQL WAL and base backups | CloudNativePG Barman Cloud plugin (ObjectStore `databases/postgresql-backup`) |
| `archives/<backup id>/` | Encrypted nightly archives | `platformctl backup --all` (built-in S3 client) |
| `etcd/` | etcd snapshots (`ha`) | k3s |
| `longhorn/` | Longhorn volume backups (`ha`) | Longhorn, daily RecurringJob `platform-backup-daily` |

Only the endpoint, bucket, region, prefix and the choice itself (`BACKUP_MODE=external` or `local`) are saved in `/etc/platform/.env`. The access key and secret are stored only in Kubernetes Secrets: `platform/platform-backup-target` holds everything, and copies in the format each user expects are in `databases/platform-backup-s3`, `kube-system/platform-etcd-s3` and `longhorn-system/platform-longhorn-backup` (the last two on `ha`). They are passed to `kubectl` on standard input, never on a command line, and are not printed. platformctl loads them into memory for archive put/get/list/delete and does not write them to disk. Because the master Secret is in the `platform` namespace, the encrypted archive contains it, so a rebuilt server can restore it.

### Look inside the backup target

To see what is in the target without the server, for example to find the newest archive ID, use the AWS command-line tool. It works with any S3-compatible storage, not just AWS. Install it with `sudo snap install aws-cli --classic` (or see the [AWS CLI install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)). Read the keys into the shell so they stay off the command line, then list the archives:

```bash
read -rp 'Access key ID: ' AWS_ACCESS_KEY_ID; read -rsp 'Secret access key: ' AWS_SECRET_ACCESS_KEY; echo
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=auto
aws s3 ls s3://cairn-backups/server-a/archives/ --endpoint-url https://<account-id>.r2.cloudflarestorage.com
```

Use your bucket, prefix and endpoint (`platformctl backup target show` prints them), and your region instead of `auto` if the provider needs one. Leave out `--endpoint-url` for AWS S3. A folder is a complete archive only if it contains `backup.json`. Run `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY` when you are done.

Provisioning holds the credentials in memory from the question (or the environment) until the cluster exists, writes the Secrets, and does not pass them to the step processes. On a re-run without credentials, the stored Secrets are kept. `platformctl backup target test` repeats the write, read and delete test with the stored credentials.

k3s reads its target from the Secret through `etcd-s3-config-secret` in `/etc/rancher/k3s/config.yaml`, so no key is written there. On a cluster installed before this release, `backup target set` adds `/etc/rancher/k3s/config.yaml.d/60-platform-etcd-s3.yaml` on the server where you run it; restart k3s there to start uploading. Servers that join later get the setting from the [join settings file](ha.md#tokens-and-the-join-settings-file). On servers that joined earlier, re-run `join` with a fresh settings file, one server at a time; this restarts k3s on that server. Explicit `ETCD_S3_*` and `LONGHORN_BACKUP_*` settings and `POSTGRES_BACKUP_DESTINATION` still win over the target.

With local-only backups, PostgreSQL archives to the bundled MinIO (`s3://postgres-backups/`) and archives go to `file:///var/lib/platform/encrypted-backups`. The choice is published in the ConfigMap `platform/platform-backup-target` and as the metric `platform_backup_target_external` (0 or 1).

### Point-in-time recovery

PostgreSQL runs as a CloudNativePG cluster on every profile: one instance on `minimal`, `standard` and `full`, three on `ha`. The platform keeps connecting to `postgresql.databases:5432`, a Service that always points at the primary. WAL is archived at least every 5 minutes while the database is written to, and a base backup runs daily at 03:00 UTC. `restore --pitr` replays them into a new cluster, which then archives under a new server name (`postgresql-pitr-<seconds>`), so the old archive is never overwritten.

Each new cluster gets a unique server name (`postgresql-<date>t<time>`), so a rebuilt server can archive into the same bucket while the old server's archive stays readable. `--pitr latest` replays all archived WAL; `--source-server` reads another server's archive. The recovery window is the ObjectStore's first recoverability point up to the last archived WAL.

### Moving PostgreSQL to CloudNativePG

`platformctl postgres migrate` moves a server that still runs the Bitnami PostgreSQL release. Each finished step is saved, so after a failure the same command continues where it stopped:

1. an encrypted archive (when `backup init` was run) and a host copy of credentials;
2. the API is stopped, project database users are blocked from logging in and their sessions are ended;
3. all roles and databases are dumped to `/var/lib/platform/migrations/postgres-cnpg/` (root only);
4. the Bitnami release is removed; its volume `data-postgresql-0` is kept, with its PersistentVolume set to `Retain`;
5. the CloudNativePG cluster starts with the password the platform already uses;
6. the dump is restored and the project users can log in again;
7. databases, table counts and platform users are compared with the dump;
8. `POSTGRES_ENGINE=cnpg` is saved, WAL archiving starts and the first base backup runs; then the API starts.

`--dry-run` prints the plan and checks the current databases. `--rollback --confirm` reinstalls the Bitnami release on the kept volume, with the data as of the start of the migration, and removes the new cluster. Delete the kept volume and the dump folder once you are satisfied.

### What a full backup does

`platformctl backup --all` is opt-in. It runs the database tools that are already inside the database containers through `kubectl exec`, uses SQLite's online backup (or k3s embedded-etcd snapshots) for the cluster, the built-in S3 client for files and archive uploads, and age encryption built into platformctl. No backup service runs in the background.

Every backup or restore checks for the tools it needs before touching anything and names any that are missing. platformctl and `kubectl` must be on root's `PATH`. The scheduled job runs `/usr/local/bin/platformctl`.

### Settings

- `backup init` writes `/etc/platform/backup.json` (mode 0600). It holds only the target and the public key. It refuses to overwrite an existing file. The target defaults to `external`, which means the backup target, or to a local folder when backups are local-only.
- If you omit `--recipient`, `backup init` generates a key and prints the private half **once** without saving it. Do this in a private terminal without session logging and move the key off the server at once.
- Retention flags on `backup init`: `--keep-daily` (default 7, at least 1), `--keep-weekly` (4) and `--keep-monthly` (12).
- `--components` lists what to protect. The default is `config,postgres,mongo,redis,minio,k3s`; `config` and `postgres` are required. Remove components your install does not have, for example `--components config,postgres,k3s`. A selected component that is missing makes the backup fail; nothing is silently skipped.
- `--target` overrides the saved target for one `backup`, `list` or `restore`: `external` (the configured off-site target) or `file:///var/lib/platform/encrypted-backups` (local staging, with a warning that it cannot survive disk loss). Never put credentials in a target URL.
- The bundled MinIO is the default **source** of files. platformctl talks to it over the cluster Service with root credentials from the `minio` Secret, held only in memory.
- Settings from releases before the built-in S3 client still work: a `backup.json` with `"target": "s3://<mc alias>/bucket/prefix"` or `"minioAlias"` is read through the alias in root's `~/.mc/config.json` (or an `MC_HOST_<alias>` variable), without the `mc` program. Move to the off-site target when you can; see [upgrades](upgrades.md#backup-settings-that-name-an-mc-alias).

### Nightly job

`backup schedule` installs the `platform-backup-nightly` CronJob and, when the monitoring stack is present, the `monitoring/platform-backups` alert rules. It only works with the default settings path. The job:

- runs at 02:15 UTC, never overlaps, and has a four-hour deadline;
- has low priority, requests 50m CPU and 64Mi memory, is limited to 1 CPU and 512Mi, and runs with `nice` and `ionice`;
- uses a privileged pod in the host's process namespace, to take k3s snapshots and read installer credentials. This is root-level host maintenance; restrict who can change this CronJob;
- takes the installer's shared lock, so backup, restore, provision and repair never run at the same time.

### Contents and format

Each backup has a unique UTC ID. `backup.json` in the backup is a version-1 manifest with `version`, `id`, `createdAt`, `platformVersion` and `artifacts` (component, file name, SHA-256 of the encrypted file and its size). Each artifact is an age-encrypted tar named `<component>.tar.age`. No private key is stored. The manifest is uploaded last and marks the backup complete, so failed uploads are never listed. When a backup fails, platformctl deletes the files it already uploaded for that ID. If that cleanup fails too, it says so, and `backup list` warns about each folder without `backup.json` (on standard error, so the JSON list stays clean). Such a folder cannot be restored. Delete it by hand once no backup is running. Checksums detect damage, but a manifest is not a signature: keep a trusted copy or use bucket object locking or versioning.

Database passwords are read inside the database containers, from the environment variable or the `*_FILE` password file, never on the host or in command arguments.

- **PostgreSQL:** `pg_dumpall --globals-only` (roles, with their passwords) plus one `pg_dump -Fc` per database.
- **MongoDB:** `mongodump --archive --gzip`, including users.
- **Redis:** `BGSAVE`, wait for it to finish, then copy `/data/dump.rdb`.
- **Files:** every source bucket except `platform-backups` is copied with the built-in S3 client, so backups do not contain older backups. Bucket policies, lifecycle rules, object versions, IAM and outside providers are not captured; reapply them separately.
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
- `backup list` reads `/etc/platform/backup.json` even when you pass `--target`, so it fails on a new server that has no backup settings yet. [List the target with the AWS CLI](#look-inside-the-backup-target) instead.
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
- **ConfigMaps** `platform/platform-backup-backup` and `platform/platform-backup-restore-test` with the latest result, last success, size and duration, and `platform/platform-backup-target` with where backups go. The portal's **Settings** reads these, plus the CloudNativePG Cluster and ObjectStore status and `pg_stat_archiver` for the change log and recovery window. No keys or dump details are exposed.
- **Portal notifications** to admin and DevOps users, written through the running API's database connection.

The alert rules are `PlatformBackupStatusMissing`, `PlatformBackupFailed`, `PlatformBackupStale` (26 hours), `PlatformRestoreTestFailed`, `PlatformRestoreTestStale` (8 days), `PlatformBackupCronJobFailed` (failed `platform-backup-*` Jobs, which catches crashes before a status is written), `PlatformBackupLocalOnly` (backups stay on the server for an hour), `PlatformPostgresWALArchivingFailing`, `PlatformPostgresWALArchiveStale` (no WAL archived for 2 hours) and `PlatformPostgresBaseBackupStale` (36 hours). They are applied by `backup schedule` and by the `postgresql-backup` step. Installs without monitoring rely on portal notifications. If writing the status fails, that is logged and the backup itself still counts.

### Project database backups

The **Database backups** panel runs `pg_dump` of the named database, uploads it to the default storage provider (or the built-in backup store when there is none) as `backups/<projectId>/<backupId>.dump`, and records a checksum. Restore downloads the dump from the provider it was saved to, checks the checksum, then runs `pg_restore`. If SMTP is set up, DevOps users get an email when a backup completes. The database name must match the project's PostgreSQL database for the environment.

### Limits

- Files on host disk, local storage and outside storage providers are not included. Move them into the bundled storage, or protect them with the provider's own tools.
- Kubernetes namespaces and Secrets outside the listed namespaces are not included.
- Restore uses the same release's database schema. Run the migration job only when you upgrade after a successful restore.
- `platformctl upgrade` takes a full encrypted backup before it changes anything when `/etc/platform/backup.json` exists. Without it, upgrade takes only a local database and credentials copy and warns that this does not protect against disk loss.
- Point-in-time recovery covers PostgreSQL only. MongoDB, Redis and files come back as of the last nightly archive.
- A full nightly test that installs one server, destroys it and restores onto a second has not been wired up yet. Fresh-server restores with live S3, Redis volumes, MongoDB and k3s are covered by unit tests only.

## For developers / API

Operator sign-in (DevOps role) is required.

| Request | Returns |
|---|---|
| `GET /api/settings/backups` | Latest backup and restore-test status (`items`), where backups go (`storage`: mode, `localOnly`, target endpoint host, bucket, prefix and region, never keys), PostgreSQL recovery (`postgres`: archiving state, last archived WAL, last base backup, recovery window) and `lastFullBackupAt` |
| `GET /api/settings/backups/metrics` | The same data in Prometheus text format |
| `POST /api/projects/<projectId>/databases/backup` with `{ "dbName": "...", "environment": "production" }` | Starts a project database backup |
| `GET /api/projects/<projectId>/databases/backups` | The project's last 50 database backups (viewer access) |
| `POST /api/projects/<projectId>/databases/backups/<backupId>/restore` | Restores a completed backup |

For manual commands, see [Manual backup procedures](../deployment/backup-and-restore.md).
