# Synchronous or asynchronous database replication

When you run Cairn on three servers (the `ha` profile), the platform database keeps a copy on each server. The installer asks you one question about it: should a write wait for a second copy before it counts as saved (**sync**), or not (**async**)? This page explains what that means for you, so you can pick the right one. You can change your mind later with one command.

Single-server installs have only one copy of the database, so this choice does not apply to them.

## What replication is

PostgreSQL, the database Cairn uses, runs on all three servers. One copy is the *primary*: it takes every write. The other two are *standbys*: they receive each change from the primary and replay it, so they stay up to date.

If the server with the primary dies, a standby is promoted and becomes the new primary. Apps keep using the same address, `postgresql.databases:5432`, which always points at the current primary.

The question is only about timing. When your app saves something, when does the database tell it "done"?

- **Sync (synchronous).** The primary waits until a standby on another server has the change too, then says "done". Every confirmed write exists on at least two servers.
- **Async (asynchronous).** The primary says "done" as soon as it has the change, and sends it to the standbys a moment later. Usually that moment is a fraction of a second.

## What happens when a server dies

These numbers come from tests on three cloud servers, where we stopped the database or powered off one server while an app kept writing.

**In both modes, losing a server interrupts writes for about 1 minute.** Kubernetes first has to notice that the server is gone (about 40 seconds), and only then is a standby promoted. Anything that saves data during that time waits or fails and has to be retried. Async does not make this failover faster.

**With sync**, no confirmed write is lost. The standby that is promoted already has every write the old primary confirmed.

**With async**, the last writes confirmed before the failure can be lost, because they had not reached a standby yet. Your app was told "saved", but after the failover those rows are not there. In our power-off test with async, one confirmed write was lost.

When only the database process crashes or restarts, and the server stays up, failover is quicker: about **30 seconds**.

| | Sync (default) | Async |
|---|---|---|
| A confirmed write is lost when a server dies | Never | The last writes before the failure can be |
| Writes pause after a server is lost | About 1 minute | About 1 minute |
| Writes pause after a database crash (server stays up) | About 30 seconds | About 30 seconds |
| Speed of each write in normal operation | A little slower: waits for the network round trip to another server | Fastest |

Measured on the test cluster: with sync, killing the primary database process led to a new primary after 26.5 seconds and writes resumed after 35.8 seconds; powering off the primary's server led to a new primary after 62.9 seconds and writes resumed after 71.3 seconds. With async, powering off the server that ran the primary, the active backup plugin, a database operator and half of the bundled object storage led to a new primary after 57.5 seconds, and writes resumed after 61 seconds. Your times depend on your servers and network.

## Which one to choose

Ask yourself: if the last writes before a server failure vanished, could you get them back?

- **Choose sync** for money, orders, payments, sign-ups, messages, and anything else you cannot re-create. This is the default.
- **Choose async** for caches, analytics, logs, and apps that already retry their writes or can rebuild their data, when the speed of each write matters more than the last writes before a failure. Async does not shorten the interruption when a server is lost.

If you are not sure, keep sync. A pause is visible and recovers by itself. A lost order is often noticed only when a customer complains.

The choice applies to the whole database server: the platform's own data and every project database on it use the same mode.

## Choose during install

On the first server, `platformctl provision --profile ha` asks:

```text
  ■ PostgreSQL replication
    The database keeps a copy on each of the three servers. Choose how writes are copied:
    sync  (default) Every write is copied to a second server before it is confirmed.
                    No confirmed write is lost if a server dies. Writes pause during failover:
                    about 1 minute when a server is lost.
    async           Writes are confirmed right away and copied a moment later.
                    Failover also takes about 1 minute when a server is lost, and the
                    last writes confirmed before the failure can be lost.
  ? Replication mode (sync/async) [sync]:
```

Press Enter to keep sync. For an unattended install (`--auto`), pass the flag or set the variable:

```bash
sudo platformctl provision --profile ha --auto --postgres-replication async
# or
export POSTGRES_REPLICATION=async
```

The choice is saved as `POSTGRES_REPLICATION` in `/etc/platform/.env`, so running `provision` again keeps it and does not ask again.

## Change it later

Switch at any time on the first server:

```bash
sudo platformctl postgres replication set async
sudo platformctl postgres replication set sync
```

The change takes effect within seconds. PostgreSQL reloads its settings: there is no restart, no failover and no downtime. The command waits until the primary reports the new setting and saves your choice.

To see the current mode:

```bash
sudo platformctl postgres replication
sudo platformctl status
```

Both show a line such as `Replication: sync (each write waits for a standby; ...)`.

## Replication and backups

Replication and backups protect against different things, and you need both.

- **Replication** keeps the database running when a server dies. It does not help when data is deleted by mistake: the delete is copied to every standby within a second.
- **Backups** let you go back in time. Cairn continuously archives the database's change log to your backup target and takes a daily full backup. You can [restore the database to any moment](backups.md#restore-the-database-to-a-moment-in-time) since the oldest kept backup.

Both modes are backed up the same way, and backups protect you in both modes against deleted data, a broken migration or losing all servers. The only extra risk of async is the one described above: the last writes before a server failure. Those writes had not reached the backup either, so a backup cannot fill that gap.

## Details

For readers who know PostgreSQL:

- Sync sets CloudNativePG `spec.postgresql.synchronous` to `method: any`, `number: 1`, `dataDurability: preferred`. PostgreSQL gets `synchronous_standby_names = 'ANY 1 (<the two standbys>)'`, so a commit waits for either standby, and losing one standby causes no pause. With `preferred`, if no standby is healthy (two servers down), the primary keeps accepting writes without the guarantee instead of stopping.
- Async removes `spec.postgresql.synchronous`, so `synchronous_standby_names` is empty.
- `platformctl postgres replication set` patches only that field of the `databases/postgresql` Cluster. Changing `synchronous_standby_names` needs only a configuration reload.

## Related

- [Run Cairn on several servers](ha.md)
- [Backups and restore](backups.md)
- [Install](../getting-started/installation.md)
