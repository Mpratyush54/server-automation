# Full-profile telemetry

Issue #37 adds an opt-in full-profile LGTM backend in `monitoring`. New/legacy
configs with no saved profile now default to standard to keep installation light.
Explicit or saved `full` selections remain full. Standard
keeps kube-prometheus-stack and loki-stack; minimal installs neither monitoring
nor telemetry. `INSTALL_MONITORING=false` also disables full telemetry. Existing
installations must explicitly select `--profile full` to move to this layout.
There is no `ha` profile in this installer; multi-cluster federation is excluded.
Changing the profile does not delete existing releases, PVCs, or buckets.

## Installation and storage

On Ubuntu, run `sudo platformctl provision --profile full --auto`. The new
`telemetry` graph step depends on `platform`, `monitoring`, and `routing`.
Full monitoring is installed in this step, so the normal monitoring step does
not launch legacy Loki first. MinIO IAM only starts once the platform API can
serve its OpenID discovery document. Provision fails on backend/readiness errors.

The step creates three buckets (`loki`, `tempo`, `pyroscope`) and one separate
MinIO user/policy per bucket. Policies allow bucket listing/location and object
read/write/delete/multipart operations only on that bucket. Credentials are
created once in `monitoring/telemetry-<backend>-s3`, reused on reruns, and injected
through Secret references and environment expansion. Backends never receive the
MinIO root credentials. Short-lived IAM Jobs use a separate bootstrap Secret;
the installer deletes that Secret on return. Jobs have bounded resources,
retries/deadlines, private scratch directories, and a completion TTL.

Full installs pin Alloy, monolithic Tempo, single-binary Loki, single-binary
Pyroscope (v1 object-storage engine), and blackbox-exporter. Prometheus enables
its remote-write receiver. Tempo enables `service-graphs` and `span-metrics`,
including project/environment dimensions and a 10,000 active-series ceiling.
Grafana retains the Loki service URL and provisions Tempo/Pyroscope correlations
and a Platform Telemetry dashboard. Pod logs are collected by Alloy instead of
Promtail. Blackbox exposes the `http_2xx` module; project target management belongs
to #42, not the installer.

`TELEMETRY_RETENTION_DAYS=30` sets Loki, Tempo, Pyroscope and Prometheus retention;
valid values are 1..365. Loki retention and Tempo compaction are enabled;
Pyroscope uses `limits.compactor_blocks_retention_period`. Deletion is asynchronous
and includes the backend's compaction/deletion delay. Do not configure an S3
lifecycle policy that independently removes live index/WAL objects (the separate
`replays` bucket may use lifecycle — see [telemetry-privacy.md](./telemetry-privacy.md)).
Per-project **logs** retention set in the API Privacy settings (#47) is applied
by the API as Loki runtime overrides (`retention_stream` on the project id labels
in the `loki-runtime` ConfigMap, re-applied every 10 minutes). Traces and profiles
have no per-project retention (single-tenant Tempo/Pyroscope). Error-tracking
events live in Postgres and are pruned by the API's hourly `error-retention` job
(project `errors` setting, default 90 days); replays are not stored in Loki. See
[telemetry-privacy.md](./telemetry-privacy.md#retention-what-actually-applies).
`TELEMETRY_SAMPLING_PERCENTAGE=100` retains every trace by default. Operators can
explicitly select 0..100 for a smaller server. Both settings persist to the
installer .env so parallel child steps and reruns see the same values.

The default S3 endpoint is bundled MinIO. To use an external compatible S3
service, supply backend Helm overrides for endpoint/region/TLS and the scoped
Secrets; the installer currently provisions bundled MinIO, not external
cloud IAM. Keep each backend's bucket and credentials separate. Full profile also
creates a `replays` bucket (365 d lifecycle backstop; per-project replay retention is enforced by the API) for session replay (#40) and GDPR delete.

## Ingest contract and API integration (#49)

DNS `otel.<DOMAIN>` must resolve to the ingress. TLS uses cert-manager and the
same active issuer/CA fallback as the main platform host. Public OTLP uses HTTP
at `/v1/traces`, `/v1/logs`, `/v1/metrics`; Faro uses `/collect`. Alloy also listens
on in-cluster OTLP gRPC 4317. `/pyroscope/ingest` strips the `/pyroscope` prefix
and goes to the `profile-ingest` proxy (Deployment/Service/NetworkPolicy in
`monitoring`, image `<PLATFORM_IMAGE_REGISTRY>/platform-profile-ingest:<PLATFORM_IMAGE_TAG>`),
which forwards to Alloy's profiling receiver. SDKs receive `/pyroscope` as their
base URL. Only the Pyroscope `/ingest` API is accepted for profiles; other receiver
APIs (for example `push.v1.PusherService/Push`) return 404 because their labels
travel inside the request body.

All public routes use ingress-nginx external auth at
`http://platform-api.platform.svc.cluster.local:3000/api/telemetry/ingest-auth`,
with `X-Platform-Project-Id` / `X-Platform-Environment` response headers. Successful
auth results are cached for 60 seconds. The cache key includes token, Origin,
and URI, so a browser token's allow decision cannot be reused from another
origin or ingest path. Limits are 20 requests/second per client IP, burst factor
2, and a 4 MiB request body. SDK bounded buffers/backoff remain SDK responsibilities.

The API also enforces a per-token budget in ingest-auth (600/min server, 300/min
browser tokens). nginx `auth_request` only passes 401/403 from the auth service
to the client and turns every other status into a 500, so the Ingress calls
`ingest-auth?errors=mapped`. In that mode the API answers throttling and
signing-key outages as `403` with `X-Platform-Auth-Status: 429|503`,
`Retry-After` and, for a browser token, the Origin it verified
(`X-Platform-Allowed-Origin`). A `configuration-snippet` captures those headers
and sends 403s to `@telemetry_auth_retry` (a `server-snippet` on the `telemetry`
Ingress only), which returns a real `429`/`503` with `Retry-After`,
`Access-Control-Allow-Origin` (verified origin only) and
`Access-Control-Expose-Headers: Retry-After`, so browser and OTLP SDKs back off
as asked. Any other 403 stays a 403. Only successful auth answers are cached, so
a throttled token is re-checked on every request. Without `?errors=mapped` (an
Ingress from an older platformctl) the API keeps answering 429/503, which clients
see as 500 as before; run `sudo platformctl install telemetry` to apply the new Ingress. The
snippets rely on the controller's existing `allow-snippet-annotations` /
`annotations-risk-level: Critical` settings; no global setting changes.

Alloy clears untrusted resource identities, associates the connection with
Kubernetes pods and their namespace's `platform.io/project` / `platform.io/env`
labels, then overwrites project/environment from the authenticated headers on
traces, logs and metric datapoints BEFORE batching. Incoming client identity
attributes are removed before metadata extraction. After identity, the
`pii_scrub` transform redacts emails, tokens, card-like numbers and IPs on
traces and logs (not on `/pyroscope`). Pod logs use `loki.process "pii_scrub"`.
The stack uses a single Loki/Tempo tenant; it deliberately does not derive
`X-Scope-OrgID` from a project.
API query proxies must enforce project scoping (#48). Never expose backend query
ports directly to project workloads. A NetworkPolicy restricts Alloy ingress
to the ingress controller, platform API, and Prometheus metrics scraping.

The API owns `monitoring/telemetry-origins`, key `origins.json`: a sorted JSON
array of browser origins. platformctl creates it as `[]` and never overwrites it.
The API writes the union of every live (not deleted) project's browser origins,
the same set it signs into browser ingest tokens:

* `https://<environment host>` for every active environment,
* `https://<project domain>`,
* every entry of the project variable `TELEMETRY_ALLOWED_ORIGINS` (plain config
  or secret, any environment; comma or space separated).

Entries are normalised to `scheme://host[:port]` (no path, query or user info;
http/https only). `https://*.example.com` subdomain wildcards are kept: the Faro
receiver's CORS matcher (rs/cors through Alloy's `cors` block) accepts one `*`
per origin. A bare `*` is never written. The list is capped at 2000 origins /
128 KiB (extra entries are dropped with a log line).

The leader syncs 5 seconds after it starts leading and every 5 minutes; any
replica also syncs (debounced by 1 second) after `TELEMETRY_ALLOWED_ORIGINS` is
set, changed or deleted (config, environment-variable and secret APIs) and after
a project is created, updated or deleted. The API merge-patches only this key,
and only when the content changed. It never creates the ConfigMap; if it is
missing, or `PLATFORM_OBSERVABILITY` is unset, the sync does nothing. The
`telemetry-origins-writer` Role grants the API service account
(`platform/platform-api`) get/patch/update on this ConfigMap only.

Alloy mounts the whole ConfigMap (no subPath) and its `local.file` component
polls the file every 10 seconds; the Faro receiver is reconfigured in place, so
no pod restarts. Expect up to about a minute of kubelet volume refresh plus the
poll interval (measured on a test VM: under 2 minutes from patch to the new
preflight answer). The preflight allows the `Authorization` and `Content-Type`
headers the browser SDK transport sends (plus `Traceparent`) and exposes
`Retry-After`.

The CORS union only lets browsers talk to the collector. Per-project
authorisation stays in ingest-auth, which checks the browser token's own signed
origins on every upload. The credential-less OPTIONS preflight to `/collect` is
let through by ingest-auth (via `X-Original-Method`) and answered by Alloy.

After all Helm releases report ready, the installer publishes
`monitoring/telemetry-backend` with string keys `enabled`, `otlpEndpoint`,
`faroEndpoint`, `profilesEndpoint`, `samplingRatio`. The API has get permission
on that ConfigMap. #49 should treat an absent marker as disabled and check
backend availability, then issue/refresh ingest/browser tokens and expose the
SDK config from the shared Wave 4 contract. No API files are changed here.

Profile identity: Alloy's `pyroscope.receive_http` (v1.21) builds series labels
only from the `name` query parameter and cannot read request headers, and
`pyroscope.relabel` has no access to request metadata. The `profile-ingest`
proxy therefore sets profile identity from the authenticated collector identity:

* Requests without exactly one valid `X-Platform-Project-Id` and
  `X-Platform-Environment` header (set by ingress external auth) get 401.
* `platform_project_id` and `deployment_environment` are always the header
  values; client values for these, `service_name`, `platform_service`, `app_name` and `__*` labels are
  discarded. Invalid label names/values are dropped; at most 32 client labels.
* The service name is prefixed with the project id (`<project-id>/<service>`), and
  `service_name` is set to the same value, so services of different projects never
  share a name. `platform_service` keeps the unprefixed name; Grafana's
  trace-to-profile link matches `platform.project_id` and `service.name` against
  `platform_project_id` and `platform_service`.
* Only the `/ingest` query parameters `name`, `from`, `until`, `format`,
  `sampleRate`, `spyName`, `units`, `aggregationType` are forwarded, with the
  body and `Content-Type`; credentials and identity headers are not.
* Pyroscope gives series labels precedence over pprof sample labels, so labels
  embedded in a profile body cannot replace the identity labels.

A NetworkPolicy allows only the ingress controller to reach the proxy, and the
Alloy receiver (port 9999) accepts the proxy and the platform API, not the
ingress controller. Existing installs switch to the proxy on the next full
`platformctl provision` run of the telemetry step. Project-scoped profile
queries should filter on `platform_project_id`.

## Memory and disk budget (estimates, not measured RSS)

These are engineering estimates for an idle/light-load, single-node install.
No Kubernetes VM was available in the development sandbox. None of the numbers
below are a measured result or an 8 GB acceptance claim.

| Component | Estimated RSS MiB | Memory limit MiB |
| --- | ---: | ---: |
| Alloy | 128-220 | 384 |
| Alloy reloader | 16-24 | 32 |
| Loki | 200-350 | 512 |
| Tempo incl. generator | 180-350 | 512 |
| Pyroscope | 120-250 | 384 |
| Blackbox exporter | 20-40 | 64 |
| Prometheus | 250-550 | 768 |
| Grafana | 140-220 | 256 |
| Grafana sidecars (2) | 48-80 | 96 |
| Alertmanager | 50-80 | 96 |
| Prometheus operator | 50-100 | 128 |
| Prometheus/Alertmanager reloaders (2) | 32-50 | 64 |
| kube-state-metrics | 30-50 | 64 |
| node-exporter | 24-45 | 64 |
| MinIO | 160-300 | 384 |
| MinIO console | 40-80 | 128 |
| IAM Job / admission patch (temporary) | 32-80 / 16 | 128 / 32 |

The steady-state upper limits above total about 3.85 GiB. Allow 2.5-3 GiB for
the OS, k3s, database pods, API replicas, portal, ArgoCD and Portainer; keep the
remaining capacity for filesystem cache and brief compaction spikes. Optional
Kyverno, application workloads and large query/ingest bursts require additional
headroom. Memory limits bound containers, not aggregate host RSS. A 384 MiB
Pyroscope limit is particularly workload-sensitive; test real profile sizes.
All new long-running components and bootstrap Jobs have CPU/memory requests
and limits. Full-profile MinIO has explicit smaller limits; standard is unchanged.

Caches, redundant Loki microservices, canary and Loki rule sidecar are disabled.
Each backend retains a 5 GiB local PVC for WAL/compaction; the bundled MinIO PVC
is currently 50 GiB, shared with other platform buckets. Thirty days at sustained
high ingest will NOT fit that disk: 50 GiB/30 days is only about 20 KiB/s before
headroom and other buckets. Size the disk for actual compressed ingest rates;
object storage on the same machine is not an off-site backup. Alerts cover PVC/
node free space, ingest/export failures, dropped spans and compaction failures.
Verify that each pinned backend exposes the referenced metric series on the VM.

## Upgrade from loki-stack

This is a storage/schema migration, not an in-place chart rename. The installer
stops before changing anything when Helm release `loki` still uses loki-stack.
It never deletes a PVC, uninstalls the legacy release, or rewrites old logs.

1. Export the legacy Helm values/manifests and Grafana datasource/dashboard JSON
   to a private backup location. Record the existing Loki datasource UID.
2. Quiesce old log ingestion and make a tested backup/snapshot of the old Loki
   volume. If it used emptyDir, export the data before deleting its pod.
3. Restore an archive instance on a separate release/namespace and confirm that
   historical queries work. Keep its PVC and a separately named `Loki archive`
   datasource for the desired history window. Filesystem Loki 2 data is not
   automatically copied into the new TSDB/S3 layout.
4. Only after verifying that archive/backup, remove the old `loki` release and
   its datasource-provisioning ConfigMap. Preserve the data backup independently.
5. Set `TELEMETRY_LOKI_DATASOURCE_UID` to the old UID and provision `--profile full`.
   The new datasource keeps its name `Loki`, the old UID, and the compatible
   `http://loki.monitoring.svc:3100` URL; Tempo correlations use that same UID.
   New installs use UID `loki`. Verify existing dashboards before retiring archive.

Downgrading to loki-stack requires restoring the old release and data; it cannot
read the new schema. Retain your old backup until the full-profile smoke test
has passed. Existing default monitoring state does not skip the new telemetry
step, which reconciles on reruns. Back up the three scoped Secrets as part of
cluster recovery; reruns reuse them and reconcile MinIO users/policies.

## Validation and remaining acceptance work

Unit tests cover profile selection, graph dependencies, rendering substitutions,
resource/storage settings, persisted child settings, ingress contract, standalone
Alloy/config consistency, mocked complete install order, and execution of the
IAM shell with fake mc, quoted credentials and injected failures. Tests use
private temporary paths, never host `/etc` or `/var/lib`.

On a machine with Helm and network/chart cache access:

```sh
cd platformctl
PLATFORMCTL_VALIDATE_CHARTS=1 go test ./internal/components -run TelemetryHelmRender -v
ALLOY_BIN=/path/to/alloy go test ./internal/components -run AlloyValidate -v
cd ..
scripts/gen-images.sh
scripts/gen-images.sh --check
```

`versions.All` feeds build-bundle/build-stack, so both standard and full charts
are included in offline artifacts. Online minimal/standard pre-pulls exclude the
six new backend/collector/Job images. gen-images renders the same full-profile
values and includes the generated IAM Job's pinned mc image. New image entries
are seeded from the pinned chart metadata; actual regeneration/render validation
was blocked here (Helm unavailable, outbound downloads denied). Rebuild and test
the complete platform-stack for both architectures before publishing it.

On a fresh Ubuntu 24.04 VM (4 vCPU / 8 GB), still required:

1. Provision full and wait for all Deployments/StatefulSets and Certificates.
   Confirm minimal creates no monitoring releases on a separate fresh install.
2. Integrate #49, obtain a test ingest token, and send telemetrygen traces/logs
   to the public HTTP endpoint. Verify trace IDs in Tempo via Grafana Explore;
   check RED/service-graph series in Prometheus. Exercise invalid tokens,
   spoofed identity attributes, browser allowed/disallowed origins and preflight.
3. Upload a profile with the SDK (Pyroscope `/ingest`) using project A's ingest
   token while the client labels name project B. In Grafana Explore (Pyroscope)
   the series must have `platform_project_id=<A>`, the environment from A's token
   `service_name=<A>/<service>` and `platform_service=<service>`; the Tempo span's
   "Profiles" link must open that series. Requests without a token must get 401 from
   ingress; `kubectl -n monitoring logs deploy/profile-ingest` must show no
   upstream errors.
4. Use bucket-scoped credentials to list each backend bucket and verify writes.
   On an isolated test stack shorten retention to one day, inject historical
   blocks accepted by the backend, and observe compaction/deletion after grace
   periods. Do not test retention by deleting production objects.
5. Measure container RSS with cAdvisor
   `container_memory_rss{namespace=~"monitoring|storage",container!=""}` and
   `kubectl top pods -A --containers` (working set, not RSS) after one hour and
   during compaction. Record host available memory, restarts/OOMs and disk growth.
6. Restore the scoped Secrets and rerun the installer; confirm credential reuse
   and read continuity. Repeat with the offline platform-stack and no registry
   egress.

Not yet verified: live health, trace round trip, service graph production, real
S3 writes/retention expiry, measured RSS/8 GB fit, chart/Alloy parser validation,
and the complete offline image inventory. Profile label enforcement is not yet
implemented. API/SDK token issuance, query scoping, the domain-list writer and
browser preflight behavior depend on #49/#38/#39/#48. No cloud account is required
for the MinIO path; external S3 IAM/lifecycle testing does require an account.

References: [Alloy attributes processor](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.processor.attributes/),
[Faro receiver](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.receiver.faro/),
[Pyroscope HTTP receiver](https://grafana.com/docs/alloy/latest/reference/components/pyroscope/pyroscope.receive_http/),
[Pyroscope configuration](https://grafana.com/docs/pyroscope/latest/configure-server/reference-configuration-parameters/).
