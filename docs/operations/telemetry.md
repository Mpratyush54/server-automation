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
Loki also applies per-stream retention for `telemetry_type=replays` (7d) and
`telemetry_type=errors` (90d). Project overrides and GDPR delete live in the API
Privacy settings (#47).
`TELEMETRY_SAMPLING_PERCENTAGE=100` retains every trace by default. Operators can
explicitly select 0..100 for a smaller server. Both settings persist to the
installer .env so parallel child steps and reruns see the same values.

The default S3 endpoint is bundled MinIO. To use an external compatible S3
service, supply backend Helm overrides for endpoint/region/TLS and the scoped
Secrets; the installer currently provisions bundled MinIO, not external
cloud IAM. Keep each backend's bucket and credentials separate. Full profile also
creates a `replays` bucket (7d lifecycle) for session replay (#40) and GDPR delete.

## Ingest contract and API integration (#49)

DNS `otel.<DOMAIN>` must resolve to the ingress. TLS uses cert-manager and the
same active issuer/CA fallback as the main platform host. Public OTLP uses HTTP
at `/v1/traces`, `/v1/logs`, `/v1/metrics`; Faro uses `/collect`. Alloy also listens
on in-cluster OTLP gRPC 4317. `/pyroscope/ingest` and
`/pyroscope/push.v1.PusherService/Push` strip the `/pyroscope` prefix and go to
Alloy's profiling receiver. SDKs receive `/pyroscope` as their base URL.

All public routes use ingress-nginx external auth at
`http://platform-api.platform.svc.cluster.local:3000/api/telemetry/ingest-auth`,
with `X-Platform-Project-Id` / `X-Platform-Environment` response headers. Successful
auth results are cached for 60 seconds. The cache key includes token, Origin,
and URI, so a browser token's allow decision cannot be reused from another
origin or ingest path. Limits are 20 requests/second per client IP, burst factor
2, and a 4 MiB request body. SDK bounded buffers/backoff remain SDK responsibilities.

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

The API owns `monitoring/telemetry-origins`, key `origins.json`, a JSON array of
exact scheme+host(+port) origins derived from verified project domains. It starts
as `[]` and is preserved across reruns. The API service account has get/patch/
update permission on this ConfigMap. Alloy mounts the whole ConfigMap (no subPath)
and polls the file every 10 seconds, so projected-volume updates trigger live
CORS reconfiguration without restarting a pod. There is no wildcard origin.
Allow for kubelet projection delay in addition to the polling interval. The
API must also check the requesting token's own allowed origins; a global CORS
union is not per-project authorization. Browser OPTIONS preflight needs an
origin-validated auth response without requiring an Authorization header;
#49 must distinguish preflight via ingress's original-method headers, while
requiring a valid token on actual uploads. Verify this in a real browser.

After all Helm releases report ready, the installer publishes
`monitoring/telemetry-backend` with string keys `enabled`, `otlpEndpoint`,
`faroEndpoint`, `profilesEndpoint`, `samplingRatio`. The API has get permission
on that ConfigMap. #49 should treat an absent marker as disabled and check
backend availability, then issue/refresh ingest/browser tokens and expose the
SDK config from the shared Wave 4 contract. No API files are changed here.

Known integration gap: Alloy's Pyroscope HTTP receiver forwards profiles but
cannot use request-context headers to rewrite arbitrary profiling label sets.
Project/environment labels in incoming profiles are therefore not authoritative.
Before exposing project-scoped profile queries, #49 needs a sanitizing profile
proxy or a supported collector processor that overwrites those labels. The
current ingress authenticates/rate-limits uploads, but that alone does not
establish trustworthy profile ownership. This part of #37 is **not complete**.

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
3. Upload a profile using the SDK's Pyroscope push API. Verify label ownership
   after the profile scoping integration gap above is resolved.
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
