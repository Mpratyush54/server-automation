# See what your apps are doing

This page shows where to find logs, errors, speed and resource use for your apps, and how to get told when something breaks. For one project, open the project and choose **Monitoring**. For all projects at once, choose **Monitoring** in the sidebar.

## Where to look

| You want to see | Go to |
|---|---|
| Health, traffic and errors for every project | Sidebar **Monitoring** |
| One project at a glance | Project page, **Monitoring**, view **Overview** |
| Application errors, grouped | **Monitoring**, view **Errors** |
| Log lines | **Monitoring**, view **Logs** |
| Request speed and traces | **Monitoring**, view **Traces** |
| Real users: page speed, session replays, heatmaps | **Monitoring**, view **Users** |
| Uptime checks and the public status page | **Monitoring**, view **Uptime** |
| CPU, memory and restarts | **Monitoring**, view **Resources** |
| AI agent tokens and commands waiting for approval | **Monitoring**, view **AI agents** |
| Incidents, alert rules and who gets notified | Sidebar **Alerts** |
| Dashboards | Sidebar **Grafana** (also at `https://<your-domain>/grafana/`) |

## Start sending data

Most views fill in once your app uses a Cairn SDK.

1. Create an SDK token in the project's **Settings**, under **SDK tokens**.
2. Add the SDK to your app. For Node.js with Express:

   ```js
   const platform = require('@mpratyush54/sdk-node');
   await platform.init({
     projectName: 'shop',
     platformUrl: 'https://platform.example.com',
     environmentName: 'production',
   });
   app.use(platform.expressMiddleware()); // request speed per route
   platform.captureConsole();             // send console.* as logs
   ```

3. Call a few routes, then open **Monitoring**. Logs appear under **Logs**, request speed under **Traces**, and CPU and memory under **Resources**.

Full steps: [Node.js quickstart](../getting-started/node-sdk-quickstart.md).

> [!NOTE]
> On the default install you get basic logs, request speed by route and heartbeats (CPU, memory and error counts the SDK reports). Traces, the service map, log search with live tail, pod metrics and profiles need the **full** install profile: `sudo platformctl provision --profile full`. Each view tells you when it needs it.

## Get alerted

1. Choose **Alerts** in the sidebar and pick your project.
2. On **Channels**, add where alerts should go: Slack, PagerDuty, Microsoft Teams, Discord, a webhook or email.
3. On **Monitors**, add a rule. Example: kind **CPU / memory**, resource **Memory % of limits**, condition `> 90`, for `300` seconds.

Full guide: [Get alerts when something breaks](../operations/alerting.md).

## More monitoring

| You want to | Read |
|---|---|
| Search logs, traces and metrics | [Search logs, traces and metrics](observability.md) |
| Group and fix application errors | [Track and fix errors](../observability/error-tracking.md) |
| Check a URL on a schedule | [Check that your site is up](../operations/synthetics.md) |
| Publish a public status page | [Status pages](status-pages.md) |
| Measure real browser performance | [Monitor real users in the browser](frontend-rum.md) |
| Control what data is kept, and for how long | [Privacy and retention](../operations/telemetry-privacy.md) |

## How it works

### Components

`platformctl` installs the monitoring stack in the `monitoring` namespace:

- **Prometheus** (kube-prometheus-stack Helm chart) stores metrics. It scrapes kube-state-metrics (pods, deployments), the kubelet and cAdvisor (container CPU, memory, disk, network) and node-exporter (node disk, network and load). Node-exporter also publishes `platformctl backup` metrics written to `/var/lib/platform/metrics` on the host.
- **Loki** stores logs.
- **Grafana** shows dashboards. It ships with the chart's default Kubernetes dashboards. The full profile adds a **Platform Telemetry** dashboard (request rate, error rate, service graph, telemetry disk space, dropped spans, collector export failures) and Loki and Tempo data sources.
- The full profile also adds **Tempo** (traces) and **Pyroscope** (profiles). See [Turn on full monitoring](../operations/telemetry.md).

Prometheus keeps metrics for 30 days on the default profile. On the full profile the retention is `TELEMETRY_RETENTION_DAYS` (default 30).

### Grafana sign-in

Grafana uses Cairn as its single sign-on provider (generic OAuth against the Cairn API; the sign-in button is labelled **Platform**). Your Grafana role comes from your Cairn group:

| Cairn group | Grafana role |
|---|---|
| Admin | Admin |
| DevOps | Admin |
| Tech Lead | Editor |
| Anyone else | Viewer |

### Where SDK data goes

- **Logs** sent by the SDK are stored in MongoDB (`LogModel`) and forwarded to Loki on a best-effort basis, labelled with `project_id`, `environment_id`, `service_name`, `level` and `telemetry_type` (`errors` for `ERROR` lines, otherwise `logs`).
- **Request speed** per route is stored in MongoDB (`ApiMetric`). The portal shows count, average, p50, p95, p99, 4xx and 5xx per route.
- **Heartbeats** (CPU, memory, uptime, response time, error counts) are stored in MongoDB. The **Resources** view averages the last 100.

Prometheus does not scrape these. The API's own Prometheus-format metrics (background jobs, telemetry pipeline, synthetic checks) are at `GET /api/metrics/jobs`, which needs the DevOps role; `platformctl` does not set up a scrape for it.

## For developers / API

### Send logs

`POST /api/sdk/logs` (or `POST /api/logs/ingest`) with an SDK token. Body: `{ "logs": [ { "message": "...", "level": "INFO" } ] }`. Every entry needs a `message`. Levels are upper-cased; `environment` defaults to `development`.

### Search logs

```http
GET /api/logs/search?projectId=<uuid>&level=ERROR&search=timeout&limit=50&offset=0
```

| Parameter | Description |
|---|---|
| `projectId` | Project UUID or name. Without it, all projects you can access |
| `environmentId` | Environment name stored with the log |
| `serviceName` | Service name |
| `level` | `INFO`, `WARN` or `ERROR` |
| `search` | Text the message contains (case-insensitive, matched literally) |
| `limit` | Results per page (default 50, max 500) |
| `offset` | Pagination offset |

Returns `{ logs, total }`. Agent tokens need the `logs:read` scope.

### Request speed by route

The SDK sends `POST /api/sdk/api-metrics` with an SDK token:

```json
{ "metrics": [ { "route": "/api/users", "method": "GET", "statusCode": 200, "durationMs": 42, "environment": "production" } ] }
```

Read the aggregate with `GET /api/sdk/api-metrics?projectId=<uuid>&environment=production&from=2026-11-01&to=2026-11-15`. Each row has `_id.route`, `_id.method`, `count`, `avgDuration`, `p50`, `p95`, `p99`, `errors4xx`, `errors5xx` and `lastSeen`.

### Legacy alert rules

`/api/alerts` (rules with `metric`, `operator` `>`, `<` or `==`, and `threshold`) still works. Use [alerting](../operations/alerting.md#legacy-alert-rules) for new rules. `POST /api/alerts/evaluate` only reports which rules match the metrics you send; it notifies nobody.
