# Turn on full monitoring

The `full` install profile adds request traces, CPU and memory profiles, browser monitoring, session replay, heatmaps and uptime checks to every project. You see the results in each project's **Monitoring** section (views Traces, Users, Uptime and Resources) and in Grafana.

Without it (the default `standard` profile) you still get logs, metrics and dashboards. The `minimal` profile installs no monitoring at all.

## Turn it on

1. Make sure the name `otel.<your domain>` points at your server in DNS. Apps and browsers send data there.
2. On the server, run:

   ```bash
   sudo platformctl provision --profile full
   ```

   Add `--auto` to skip the questions. The choice is saved, so later runs stay on `full`.
3. Open any project, go to **Monitoring**, then **Traces**. Data appears once an app uses a Cairn SDK.

Optional settings go in `/etc/platform/.env` before you run provision:

| Setting | Default | Meaning |
|---|---|---|
| `TELEMETRY_RETENTION_DAYS` | `30` | Days to keep logs, traces, profiles and metrics (1–365) |
| `TELEMETRY_SAMPLING_PERCENTAGE` | `100` | Share of traces kept (0–100). Lower it on a small server. |

Changing the profile never deletes existing data, volumes or buckets. `INSTALL_MONITORING=false` turns off full monitoring too.

## Plan memory and disk

These are estimates for a lightly used single server, not measurements:

- The monitoring parts have memory limits that add up to about 3.85 GiB.
- Allow another 2.5–3 GiB for the operating system, Kubernetes, databases, the API, the portal, Argo CD and Portainer.
- Logs, traces and profiles are stored in the platform's built-in object storage, on a 50 GiB volume shared with other data. 50 GiB over 30 days is only about 20 KiB per second. Size the disk for your real traffic.

Storage on the same machine is not an off-site backup.

## How it works

### Components

- Full installs pin Grafana Alloy (collector), monolithic Tempo (traces), single-binary Loki (logs), single-binary Pyroscope (profiles, v1 object-storage engine) and blackbox-exporter. Prometheus enables its remote-write receiver. Tempo enables `service-graphs` and `span-metrics`, with project and environment dimensions and a 10,000 active-series ceiling. Grafana provisions Tempo and Pyroscope correlations and a Platform Telemetry dashboard. Pod logs are collected by Alloy instead of Promtail. Blackbox exposes the `http_2xx` module; uptime check targets are managed by the [synthetics](synthetics.md) step.
- Standard keeps kube-prometheus-stack and loki-stack. There is no `ha` profile in this installer, and multi-cluster federation is not supported.
- New or older configs with no saved profile default to `standard`. Existing installs must select `--profile full` explicitly.
- The `telemetry` provision step depends on `longhorn`, `platform`, `monitoring` and `routing`. Full monitoring is installed in this step, so the normal monitoring step does not start legacy Loki first. A `synthetics` step runs after it. Provision fails on backend or readiness errors.
- After all Helm releases are ready, the installer publishes the ConfigMap `monitoring/telemetry-backend` with `enabled`, `otlpEndpoint`, `faroEndpoint`, `profilesEndpoint` and `samplingRatio`. The API itself decides whether monitoring is on from `PLATFORM_OBSERVABILITY`, which platformctl sets for the full profile.

### Storage

- The step creates three MinIO buckets (`loki`, `tempo`, `pyroscope`) with one MinIO user and policy per bucket. Each policy allows listing and object read, write, delete and multipart only on its bucket. Credentials are created once in `monitoring/telemetry-<backend>-s3`, reused on reruns, and passed through Secret references. Backends never get the MinIO root credentials.
- MinIO IAM setup starts only once the platform API serves its OpenID discovery document. Short-lived IAM Jobs use a separate bootstrap Secret that the installer deletes afterwards. Jobs have bounded resources, retries, deadlines, private scratch directories and a completion TTL.
- The full profile also creates a `replays` bucket for session replay, with a 365-day lifecycle backstop. Per-project replay retention is enforced by the API.
- Each backend keeps a 5 GiB local volume for WAL and compaction. Caches, redundant Loki microservices, canary and the Loki rule sidecar are disabled.
- To use an external S3-compatible service, supply backend Helm overrides for endpoint, region and TLS, and the scoped Secrets. The installer only provisions bundled MinIO. Keep each backend's bucket and credentials separate.

### Retention

- `TELEMETRY_RETENTION_DAYS` sets Loki, Tempo, Pyroscope and Prometheus retention. Loki retention and Tempo compaction are enabled; Pyroscope uses `limits.compactor_blocks_retention_period`. Deletion is asynchronous and includes each backend's compaction delay.
- Do not add an S3 lifecycle policy that removes live index or WAL objects. Only the `replays` bucket may use one.
- Per-project log retention (set under the project's **Settings > Privacy**) is applied by the API as Loki runtime overrides, re-applied every 10 minutes. Traces and profiles have no per-project retention. See [Privacy and data retention](telemetry-privacy.md#retention-what-actually-applies).
- `TELEMETRY_RETENTION_DAYS` and `TELEMETRY_SAMPLING_PERCENTAGE` are saved to the installer's `.env`, so parallel steps and reruns use the same values.

### Ingest

- `otel.<DOMAIN>` uses cert-manager with the same issuer and CA fallback as the main host. Public OTLP over HTTP uses `/v1/traces`, `/v1/logs` and `/v1/metrics`. Browser data (Faro) uses `/collect`. Alloy also listens on in-cluster OTLP gRPC port 4317.
- `/pyroscope/ingest` strips the `/pyroscope` prefix and goes to the `profile-ingest` proxy (Deployment, Service and NetworkPolicy in `monitoring`, image `<PLATFORM_IMAGE_REGISTRY>/platform-profile-ingest:<PLATFORM_IMAGE_TAG>`), which forwards to Alloy's profiling receiver. SDKs get `/pyroscope` as their base URL. Only the Pyroscope `/ingest` API is accepted. Other receiver APIs (for example `push.v1.PusherService/Push`) return 404, because their labels travel inside the body.
- Every public route uses ingress-nginx external auth at `http://platform-api.platform.svc.cluster.local:3000/api/telemetry/ingest-auth`, which returns `X-Platform-Project-Id` and `X-Platform-Environment`. Successful answers are cached for 60 seconds. The cache key includes token, Origin and URI, so a browser token's decision cannot be reused from another origin or path. Limits: 20 requests per second per client IP, burst factor 2, 4 MiB request body.
- The API also enforces a per-token budget in ingest-auth: 600 per minute for server tokens (`TELEMETRY_INGEST_AUTH_RATE_LIMIT`) and 300 for browser tokens (`TELEMETRY_INGEST_AUTH_WEB_RATE_LIMIT`).
- nginx `auth_request` only passes 401 and 403 through and turns any other status into 500. So the Ingress calls `ingest-auth?errors=mapped`. In that mode the API answers throttling and signing-key outages as 403 with `X-Platform-Auth-Status: 429|503`, `Retry-After`, and for a browser token the verified Origin (`X-Platform-Allowed-Origin`). A `configuration-snippet` captures those headers and sends these 403s to `@telemetry_auth_retry` (a `server-snippet` on the `telemetry` Ingress only), which returns a real 429 or 503 with `Retry-After`, `Access-Control-Allow-Origin` (verified origin only) and `Access-Control-Expose-Headers: Retry-After`. Any other 403 stays 403. Only successful answers are cached. An Ingress from an older platformctl lacks `?errors=mapped`, so clients see 500; run `sudo platformctl install telemetry` to update it. The snippets rely on the controller's existing `allow-snippet-annotations` and `annotations-risk-level: Critical` settings.

### Identity and scrubbing

- Alloy clears untrusted resource identities, links the connection to Kubernetes pods and their namespace's `platform.io/project` and `platform.io/env` labels, then overwrites project and environment from the authenticated headers on traces, logs and metric data points, before batching.
- After that, the `pii_scrub` transform redacts e-mails, tokens, card-like numbers and IPs on traces and logs (not on `/pyroscope`). Pod logs use `loki.process "pii_scrub"`.
- The stack uses one Loki and Tempo tenant. It does not derive `X-Scope-OrgID` from a project. The API's query proxies enforce project scoping. Never expose backend query ports to project workloads. A NetworkPolicy limits Alloy ingress to the ingress controller, the platform API and Prometheus scraping.
- Profiles: Alloy's `pyroscope.receive_http` (v1.21) builds labels only from the `name` query parameter and cannot read headers. So the `profile-ingest` proxy sets identity from the authenticated headers:
  - Requests without exactly one valid `X-Platform-Project-Id` and `X-Platform-Environment` header get 401.
  - `platform_project_id` and `deployment_environment` always come from the headers. Client values for these, and for `service_name`, `platform_service`, `app_name` and `__*` labels, are discarded, in any spelling (for example `platform.project_id`). Invalid labels are dropped; at most 32 client labels are kept.
  - The service name is prefixed with the project id (`<project-id>/<service>`) and `service_name` is set to the same value. `platform_service` keeps the plain name. Grafana's trace-to-profile link matches `platform.project_id` and `service.name` against `platform_project_id` and `platform_service`.
  - Only the `/ingest` parameters `name`, `from`, `until`, `format`, `sampleRate`, `spyName`, `units` and `aggregationType` are forwarded, with the body and `Content-Type`. `format` must be empty, `pprof`, `folded`, `lines`, `trie` or `tree`. Formats with their own label sets (`jfr`) get 400.
  - Pyroscope gives series labels precedence over labels inside the profile body, so the body cannot replace identity.
  - A NetworkPolicy lets only the ingress controller reach the proxy. The Alloy receiver (port 9999) accepts only the proxy and the API. Existing installs switch to the proxy on the next `platformctl provision` run of the telemetry step.

### Browser origins

- The API owns the ConfigMap `monitoring/telemetry-origins`, key `origins.json`: a sorted JSON array of allowed browser origins. platformctl creates it as `[]` and never overwrites it.
- The API writes every live project's origins, the same set it signs into browser tokens: `https://<environment host>` for each active environment, `https://<project domain>`, and each entry of the project value `TELEMETRY_ALLOWED_ORIGINS` (config or secret, any environment, comma or space separated).
- Entries are normalised to `scheme://host[:port]` (http or https only). `https://*.example.com` wildcards are kept (one `*` per origin). A bare `*` is never written. The list is capped at 2000 origins or 128 KiB.
- The leader syncs 5 seconds after it starts leading and every 5 minutes. Any replica also syncs (debounced 1 second) after `TELEMETRY_ALLOWED_ORIGINS` changes, and after a project is created, updated or deleted. The API patches only this key, only when it changed. It never creates the ConfigMap; if it is missing or `PLATFORM_OBSERVABILITY` is unset, nothing happens. The `telemetry-origins-writer` Role grants the API service account get, patch and update on this ConfigMap only.
- Alloy mounts the whole ConfigMap and polls the file every 10 seconds, reconfiguring the Faro receiver without restarts. Expect up to about two minutes from change to effect. The preflight allows `Authorization`, `Content-Type` and `Traceparent`, and exposes `Retry-After`.
- This list only lets browsers talk to the collector. Per-project checks stay in ingest-auth, which checks the browser token's own signed origins on every upload. The credential-less OPTIONS preflight to `/collect` is let through by ingest-auth (via `X-Original-Method`) and answered by Alloy.

### Memory estimates

Estimates for an idle or lightly loaded single-node install. They are not measured.

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

Memory limits bound containers, not total host memory. The 384 MiB Pyroscope limit is sensitive to profile sizes; test with real profiles. Optional Kyverno, your apps and large query or ingest bursts need more headroom. Alerts cover volume and node free space, ingest and export failures, dropped spans and compaction failures.

## Upgrade from loki-stack

Moving from `standard` to `full` changes how logs are stored. `platformctl upgrade` never touches the old `loki` release; the telemetry step handles it:

- **No persistent volume** (the default before the full profile; old logs were already lost on any pod restart): the step logs `Removing legacy Helm release "loki" (loki-stack-…)`, runs `helm uninstall loki -n monitoring` (which also removes Promtail and the old datasource ConfigMap) and installs the new Loki under the same name. Old log lines are not copied.
- **Persistent volume** (a StatefulSet claim template, a mounted claim, or a `storage-loki-*` PVC): the step stops before changing anything and names the volume. It never deletes a volume, uninstalls that release, or rewrites old logs. Follow the steps below, then run `sudo platformctl provision --profile full`.

To keep the old logs of a volume-backed release:

1. Export the old Helm values and manifests, and the Grafana datasource and dashboard JSON, to a private backup. Note the Loki datasource UID.
2. Stop old log ingestion and take a tested backup or snapshot of the old Loki volume. If it used emptyDir, export the data before deleting its pod.
3. Restore an archive instance on a separate release or namespace and confirm historical queries work. Keep its volume and a separately named `Loki archive` datasource for as long as you need the history. Old filesystem data is not copied into the new layout.
4. Only after checking the archive, remove the old `loki` release and its datasource ConfigMap. Keep the data backup separately.
5. Set `TELEMETRY_LOKI_DATASOURCE_UID` to the old UID and provision `--profile full`. The new datasource keeps the name `Loki`, the old UID and the URL `http://loki.monitoring.svc:3100`; Tempo correlations use that UID. New installs use UID `loki`. Check your dashboards before retiring the archive.

Going back to loki-stack needs the old release and data restored; it cannot read the new format. Keep your old backup until the full profile works. Back up the three scoped `telemetry-*-s3` Secrets as part of cluster recovery; reruns reuse them and reconcile MinIO users and policies.

## Check a new install

On a fresh Ubuntu 24.04 VM (4 vCPU, 8 GB):

1. Provision `full` and wait for all Deployments, StatefulSets and Certificates.
2. Send test traces and logs with an ingest token to the public endpoint. Find the trace IDs in Grafana Explore. Try an invalid token, spoofed identity attributes, and allowed and disallowed browser origins.
3. Upload a profile with project A's token while the client labels name project B. The series must have `platform_project_id=<A>`, A's environment, `service_name=<A>/<service>` and `platform_service=<service>`. Requests without a token must get 401. `kubectl -n monitoring logs deploy/profile-ingest` must show no upstream errors.
4. Measure memory with `container_memory_rss{namespace=~"monitoring|storage",container!=""}` and `kubectl top pods -A --containers` after an hour and during compaction.

For chart and collector config checks on a machine with Helm and network access:

```sh
cd platformctl
PLATFORMCTL_VALIDATE_CHARTS=1 go test ./internal/components -run TelemetryHelmRender -v
ALLOY_BIN=/path/to/alloy go test ./internal/components -run AlloyValidate -v
cd ..
scripts/gen-images.sh
scripts/gen-images.sh --check
```

References: [Alloy attributes processor](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.processor.attributes/),
[Faro receiver](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.receiver.faro/),
[Pyroscope HTTP receiver](https://grafana.com/docs/alloy/latest/reference/components/pyroscope/pyroscope.receive_http/),
[Pyroscope configuration](https://grafana.com/docs/pyroscope/latest/configure-server/reference-configuration-parameters/).
