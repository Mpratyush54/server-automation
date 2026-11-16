# Recover a broken install

This page helps you get a broken Cairn server working again, from the most common problem to the most serious. You fix it on the server with the `platformctl` command line tool, because the portal may not load when something is broken.

Run every command on the server, as root or with `sudo`. Start with the first row that matches what you see.

| What you see | Run |
|---|---|
| Something is wrong, but you are not sure what | `sudo platformctl status` |
| The API keeps restarting, or sign-in fails after a password rotate | `sudo platformctl recover` |
| HTTPS certificate errors, or single sign-on to Grafana, Argo CD or Portainer fails | `sudo platformctl repair` |
| A user lost their two-factor device and no admin can reset it | `sudo platformctl mfa disable --user <email>` |
| A mistake changed or deleted database data | `sudo platformctl restore --pitr <time> --confirm` |
| Data is lost or the server is gone | Rebuild from the backup target |

## Check what is broken

```bash
sudo platformctl status
```

This checks every component and, on a multi-server install, the nodes and cluster health. It tells you which part to look at.

## Fix sign-in and database passwords

Use this when the API pod keeps restarting with `WRONGPASS` or `password authentication failed`, usually after a password rotate.

```bash
sudo platformctl backup
sudo platformctl recover
sudo platformctl update
```

1. `backup` copies `/etc/platform/.env` and the platform Secrets to `/var/lib/platform/backups/<timestamp>/`.
2. `recover` writes the working passwords to `/etc/platform/.env` and `/etc/platform/credentials/` first, then reconnects the database. It only changes a database password when no saved password still works.
3. `update` rolls the Cairn API and portal so they pick up the passwords.

To read the admin password afterwards:

```bash
sudo cat /etc/platform/credentials/admin
```

More detail: [Wrong password after rotate](../troubleshooting/db-wrongpass-after-rotate.md).

## Fix HTTPS and single sign-on

```bash
sudo platformctl repair
```

`repair` is safe to run at any time. It recreates missing sign-on secrets, re-applies the single sign-on settings for Grafana, Argo CD and Portainer, and makes sure there is a valid certificate. It uses Let's Encrypt when it can, and the platform's own certificate authority when it cannot.

## Remove a user's two-factor sign-in

```bash
sudo platformctl mfa disable --user you@example.com
```

This removes the user's authenticator and recovery codes directly, so it works even when nobody can sign in. It is written to the audit log. If the user's role requires two-factor sign-in, they set it up again at their next sign-in. See [Two-factor sign-in](../guides/mfa.md).

## Undo a database mistake

If a bad migration or a wrong command changed or deleted data, put PostgreSQL back to a moment just before it:

```bash
sudo platformctl restore --pitr 2026-11-12T10:00:00Z --confirm
```

Stop your apps' writes first. All PostgreSQL databases return to that moment; MongoDB, Redis and files are not changed. The moment must be inside the window shown under **Settings** → **Disaster recovery backups** or in `sudo platformctl status`. If the server still runs the older PostgreSQL setup, `platformctl` tells you to run `sudo platformctl postgres migrate --confirm` first.

## Rebuild from the backup target

If the server is gone, install a new one and restore everything from the off-site backup target in one command. You need the target's settings and keys, the age key file (`identity.txt`) and the archive ID. First send the target's keys to a file only root can read, so they never appear on a command line:

```bash
read -rp 'Access key ID: ' KEY_ID; read -rsp 'Secret access key: ' SECRET; echo
printf 'BACKUP_S3_ACCESS_KEY=%s\nBACKUP_S3_SECRET_KEY=%s\n' "$KEY_ID" "$SECRET" \
  | ssh you@new-server 'sudo install -m 600 /dev/stdin /root/backup-target.env'
cat identity.txt | ssh you@new-server \
  'sudo -n bash -c "set -a; . /root/backup-target.env; set +a; rm -f /root/backup-target.env
     exec env DOMAIN=example.com ADMIN_EMAIL=ops@example.com \
     BACKUP_S3_BUCKET=cairn-backups BACKUP_S3_ENDPOINT=... BACKUP_S3_REGION=... BACKUP_S3_PREFIX=server-a \
     platformctl provision --auto --restore-from external BACKUP_ID"'
```

Then bring PostgreSQL forward to the last saved change with `sudo platformctl restore --pitr latest --source-server <old archive name> --confirm`. The private key stays on your computer and is passed over SSH. Every step, with the checks to do afterwards, is in [Rebuild everything on a new server](backups.md#rebuild-everything-on-a-new-server).

To restore an archive onto a server that is still installed:

```bash
cat identity.txt | ssh you@server \
  'sudo -n platformctl restore --target external --from BACKUP_ID --confirm'
```

## Still stuck

- Re-run the installer. `sudo platformctl provision` skips finished steps and repeats the rest.
- Look up the exact error in [Troubleshooting](../troubleshooting/README.md).
- Read the step logs in `/var/log/platformctl/`.

## How it works

- `platformctl recover` first backs up `/etc/platform` and the cluster Secrets itself. It then writes the passwords to the break-glass copy on the host (`/etc/platform/.env` and `/etc/platform/credentials/`) and to the `platform-credentials` Secret the API reads, and reconnects PostgreSQL. It runs `ALTER USER` only when no stored password still works, and saves the working password to disk before changing any role.
- `platformctl repair` takes the installer lock, adopts credentials rotated at runtime from the cluster, fills in only missing values in `/etc/platform/.env`, then re-applies the API's sign-in (OIDC) settings and those of Grafana, Argo CD, oauth2-proxy and Portainer, and ensures a valid certificate that Argo CD trusts.
- `platformctl mfa disable` works without the API. It reads the platform database name from the `platform-env` Secret (`POSTGRES_DB`, default `platform`); override it with `--database`.
- `platformctl backup` (without `--all`) writes a timestamped copy to `/var/lib/platform/backups/<timestamp>/`. `backup --all` makes the encrypted off-site backup described in [Backups and restore](backups.md).
- `platformctl restore --pitr` rebuilds the PostgreSQL cluster from the change log (WAL) and daily snapshots in the backup target. It stops the API while it runs and starts it again afterwards, also when it fails. The recovered cluster writes its change log under a new name, so the old one is kept.
- A server with backups stored only on itself cannot be rebuilt after it is lost. `platformctl status` and the portal warn about this until a target is set with `sudo platformctl backup target set`.
