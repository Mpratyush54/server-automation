# See slow queries and database health

Find the queries that make your app slow and check the size of each project database. Open the project, go to **Data**, and look at the **Database insights** panel.

This needs the `full` (or `ha`) install profile. On `minimal` and `standard`, the panel says database monitoring requires the full profile.

## Read the panel

1. Open **Projects**, pick the project and go to **Data**.
2. Pick the environment in the panel's selector. It opens on `production` when the project has one.
3. Read the three engine blocks:
   - **PostgreSQL:** the 20 statements that used the most total time, with calls, rows, mean and total milliseconds. Also the database size and current connections.
   - **MongoDB:** operations slower than 100 ms in the last hour, with time, latency and rows. Also the database size.
   - **Redis:** about how many keys the project has. "(partial scan)" means the count stopped early and is a lower bound.

The panel refreshes every 30 seconds. **Refresh** loads it now. The small chart at the bottom shows PostgreSQL connections, sampled every 30 seconds, for up to 30 minutes of your current visit. It is not saved.

Example: a page in your shop is slow. Open **Data**, pick `production`, and look for a statement with a high **Mean ms** and many **Calls**. That query is the first candidate for an index.

Anyone with viewer access to the project can see the panel.

## What you will not see

- **Literal values.** Query text keeps SQL keywords and operators. Table names, column names and values are replaced with `?`. This protects data at the cost of some detail.
- **History.** PostgreSQL numbers are totals since the database statistics were last reset, not per time window.
- **Redis and MongoDB connections.** They are shared across projects and cannot be counted per project.
- **Links to traces.** The panel does not link to the **Traces** view yet.

## Turn it on for an existing server

Fresh `full` installs get database monitoring automatically. On an existing server, switch to the `full` profile and run the normal upgrade. Preview it first:

```bash
sudo platformctl upgrade --to vX.Y.Z --dry-run
sudo platformctl upgrade --to vX.Y.Z
```

The dry run lists which databases restart. If the server is already at that release, run the same command again: at the installed release it only reconciles components. `sudo platformctl provision --profile full --auto` does the same.

> [!WARNING]
> Turning this on restarts PostgreSQL, MongoDB and Redis. MongoDB stops briefly before its new pod starts. Plan a short maintenance window.

## How it works

- On the `full` and `ha` profiles, the installer enables a metrics exporter next to PostgreSQL, MongoDB and Redis. Each exporter requests 10m CPU and 32Mi memory, with limits of 100m CPU and 96Mi memory. Lighter profiles keep them off.
- PostgreSQL loads `pgaudit` and `pg_stat_statements`. Changing these preload libraries restarts PostgreSQL. The extension is created on the first insights read, including for older project databases. Statistics are filtered by both the project's database and its user.
- MongoDB profiling (level 1) is turned on only in project databases, never globally: for new databases on the full profile, and for existing ones on the first insights read. `DATABASE_SLOW_MS` sets the threshold (default 100 ms, allowed range 10 to 60000 ms). The API reads at most 20 slow operations from the last hour and returns only the operation kind, time, duration and rows. Filters, commands, collection names and error messages are never returned. The profiler's own collection keeps raw documents inside that database; it is not copied into Cairn's telemetry store and is not covered by its retention or delete jobs. Restrict admin database access accordingly.
- Redis is counted with a bounded scan of the project's key prefix: at most 25 pages or about one second, with a three-second timeout per command. No key names or values are returned.
- Each engine reports its own status: ready, unavailable or not provisioned. Errors never include driver messages, credentials or raw queries. Database and user names are resolved on the server, never taken from the request.
- Results are cached per API replica for 30 seconds (up to 200 entries).
- When slow queries are present, an insights read publishes a `database` alert event that alert rules can use. Events come from reads of the panel, not from a background sampler. A failed read does not resolve an existing slow-query alert.
- The installer applies a `platform-databases` ServiceMonitor so Prometheus scrapes the exporters. In Prometheus, `pg_up`, `mongodb_up` and `redis_up` should each be 1. PostgreSQL also exports per-database `project_database_connections` and `project_database_size_bytes` for databases named `plat_*`.
- Upgrades notice the change because PostgreSQL, MongoDB and Redis store a fingerprint of their rendered Helm values. When the values change, `platformctl upgrade` runs `helm upgrade` for them after the release is healthy. Do not edit `/etc/platform/.bootstrap_state`.
- Single-server MongoDB uses the `Recreate` update strategy because its one volume can be mounted by one pod at a time. That is why it stops briefly on every upgrade.
- Redis restarts its primary and replica. The API re-creates project Redis users within about 15 seconds.
- Switching monitoring off does not erase statistics or turn off an already enabled MongoDB profiler. Run `db.setProfilingLevel(0)` in each project database if you need to.
- Offline bundles: the image list is generated by `scripts/gen-images.sh`, which includes the exporter images. An offline bundle containing them has not been verified.
- Verified on a fresh full-profile server on 2026-11-11: all three exporters scraped, per-project metrics present, PostgreSQL queries shown without literals, and MongoDB and Redis figures shown per project.

## For developers / API

`GET /api/projects/<projectId>/databases/insights?environment=<name>` returns the panel's data. It checks sign-in and viewer access to the project and rejects unknown environments. When the server is not on the full profile (`PLATFORM_OBSERVABILITY` is not `enabled`), it returns `{ "enabled": false, "reason": "..." }`.
