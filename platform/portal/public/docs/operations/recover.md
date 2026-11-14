# Recover a broken install

This page helps you get a broken Cairn server working again, from the most common problem to the most serious. You fix it on the server with the `platformctl` command line tool, because the portal may not load when something is broken.

Run every command on the server, as root or with `sudo`. Start with the first row that matches what you see.

| What you see | Run |
|---|---|
| Something is wrong, but you are not sure what | `sudo platformctl status` |
| The API keeps restarting, or sign-in fails after a password rotate | `sudo platformctl recover` |
| HTTPS certificate errors, or single sign-on to Grafana, Argo CD or Portainer fails | `sudo platformctl repair` |
| A user lost their two-factor device and no admin can reset it | `sudo platformctl mfa disable --user <email>` |
| Data is lost or the server is gone | Restore from a backup |

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

## Restore from a backup

If data is lost, or you are moving to a new server, restore an encrypted backup. You need backups set up beforehand with `platformctl backup init`.

```bash
cat identity.txt | ssh you@server \
  'sudo -n platformctl restore --target s3://offsite/platform/server-a --from BACKUP_ID --confirm'
```

The private key (`identity.txt`) stays on your computer and is passed over SSH. The full steps, including restoring onto a fresh server in one command, are in [Backups and restore](backups.md).

## Still stuck

- Re-run the installer. `sudo platformctl provision` skips finished steps and repeats the rest.
- Look up the exact error in [Troubleshooting](../troubleshooting/README.md).
- Read the step logs in `/var/log/platformctl/`.

## How it works

- `platformctl recover` first backs up `/etc/platform` and the cluster Secrets itself. It then writes the passwords to the break-glass copy on the host (`/etc/platform/.env` and `/etc/platform/credentials/`) and to the `platform-credentials` Secret the API reads, and reconnects PostgreSQL. It runs `ALTER USER` only when no stored password still works, and saves the working password to disk before changing any role.
- `platformctl repair` takes the installer lock, adopts credentials rotated at runtime from the cluster, fills in only missing values in `/etc/platform/.env`, then re-applies the API's sign-in (OIDC) settings and those of Grafana, Argo CD, oauth2-proxy and Portainer, and ensures a valid certificate that Argo CD trusts.
- `platformctl mfa disable` works without the API. It reads the platform database name from the `platform-env` Secret (`POSTGRES_DB`, default `platform`); override it with `--database`.
- `platformctl backup` (without `--all`) writes a timestamped copy to `/var/lib/platform/backups/<timestamp>/`. `backup --all` makes the encrypted off-site backup described in [Backups and restore](backups.md).
