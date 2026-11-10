# Project database monitoring

The full install profile enables the bundled PostgreSQL, MongoDB and Redis chart
exporters, with requests of 10m CPU / 32Mi memory and limits of 100m CPU / 96Mi
memory per exporter. Minimal and standard profiles keep these sidecars disabled.
The repository currently supports minimal, standard and full profiles; `ha` is
not a separate supported installer profile. PostgreSQL retains pgaudit and adds
pg_stat_statements to shared_preload_libraries. The ServiceMonitor is installed
after Prometheus CRDs, in the full telemetry reconciliation step.

The Database tab calls
`GET /api/projects/:projectId/databases/insights?environment=production`.
Authentication and viewer-level project access are checked before reading any
statistics. Unknown environments are rejected. Database names and usernames are
resolved on the server, never from request parameters. The API uses the existing
`PLATFORM_OBSERVABILITY=enabled` flag, which the installer sets for the full
backend. Each engine has an independent ready/unavailable/not-provisioned status;
errors never include driver messages, credentials or raw queries.

PostgreSQL shows the top 20 statements by cumulative total execution time, calls,
rows and mean latency, plus database size and connections for the project's role.
Both database OID and role OID constrain the statistics query. The extension is
created idempotently on the first insights read, including for older project DBs.
Query shapes retain SQL keywords and operators; identifiers and literal tokens
are replaced, and utility statements are suppressed. This deliberately favors
privacy over displaying table names. PostgreSQL counters reset on server stats
reset; they are not time-window deltas.

MongoDB profiling level 1 is enabled on each newly provisioned project DB in the
full profile, and reconciled for existing project users on insights reads. It is
never enabled globally. `DATABASE_SLOW_MS` sets the threshold (default 100ms,
clamped to 10–60000ms). The API reads at most 20 slow operations from the last hour
in that database's system.profile collection, validates the namespace again, and
returns only operation kind, timestamp, duration and rows. Filters, commands,
collection names and error messages are never returned. The database's capped
profiler collection stores its own raw documents; it is not copied into the
platform telemetry store or covered by that store's GDPR deletion/retention jobs.
Operators should restrict administrative database access accordingly.

Redis uses a bounded SCAN with the deterministic project/environment key prefix;
no key names or values are returned. The scan stops after 25 pages or roughly one
second between commands. A command has a three-second timeout. Partial results
are explicitly marked `complete=false`. A complete scan is still an instantaneous
estimate during concurrent writes. Redis connections and MongoDB connections
cannot be reliably attributed to a project database and are not exposed as
project metrics. Redis ACL-user connection counts are not implemented.

Reads are coalesced in a bounded 200-entry, 30-second process-local response
cache; engines remain authoritative. Each API replica can independently collect.
The panel refreshes every 30 seconds and keeps up to 60 connection samples for
the current visit/environment; these are not persisted historical trends.
Collection publishes generic `database` alert events through the shared #43
contract when slow queries are present. Events are produced on insights reads,
not by an unattended scheduled database sampler. Source failures do not resolve
an existing slow-query alert.

## Upgrade and remaining integration

No platform database schema migration or lockfile change is required. Existing
installations marked done for database install steps need their database Helm
releases reconciled with the new full-profile values; the installer done markers
do not automatically reconfigure existing database releases. Changing PostgreSQL
preload libraries restarts PostgreSQL. Disabling monitoring does not erase engine
statistics or automatically disable an already enabled Mongo profiler; operators
can run `db.setProfilingLevel(0)` in the relevant project databases.

The exporter chart values follow the [PostgreSQL chart](https://github.com/bitnami/charts/tree/main/bitnami/postgresql),
[MongoDB chart](https://github.com/bitnami/charts/tree/main/bitnami/mongodb), and
[Redis chart](https://github.com/bitnami/charts/tree/main/bitnami/redis).
`scripts/gen-images.sh` now includes metrics sidecars when rendering these
charts. Regenerate and validate `platformctl/internal/images/images.txt` with
Helm before publishing the next offline stack; regeneration was unavailable in
the Windows implementation sandbox. Online Helm can pull the exporter images,
but an offline stack containing them has not been built or verified here.

Trace navigation is pending the #48 project-scoped trace viewer and its filter
contract. The current base branch has no traces tab, so the panel deliberately
does not display nonfunctional links. The integration should pass project ID,
environment, db.system.name and the server-resolved db.namespace; never use raw
statement text or an unrestricted client label selector. Historical persisted
query/connection trends and autonomous periodic database alert sampling are
follow-ups.

## Full-profile VM verification

On a fresh Ubuntu 24.04 VM with 4 vCPU / 8GB, provision with
`sudo platformctl provision --profile full`. Verify all three exporter pods'
requests/limits and the platform-databases ServiceMonitor targets in Prometheus.
Create two projects with production environments and provision their databases.
Run distinct PostgreSQL and MongoDB workloads using each project's own SDK
credentials, including operations above DATABASE_SLOW_MS, and populate each
Redis prefix. Open each project's Database tab as its viewer. Confirm that calls,
latency, rows, sizes, connections and slow operations correspond only to that
project, and that literal payloads and the other project's identities are absent.
Check unauthorized API requests, failed engines and a partial Redis scan. Verify
database alert events reach #43 rules. Repeat on a standard profile and confirm
the panel reports monitoring disabled and no exporter sidecars are installed.
This real-database, Kubernetes, scrape and load verification has not run in the
Windows sandbox.
