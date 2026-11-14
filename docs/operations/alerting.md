# Get alerts when something breaks

This page shows how to get a message in Slack, email or another tool when an app fails, slows down or runs out of memory. Open **Alerts** in the sidebar and pick a project. A project's **Monitoring** overview also links there.

Each project has its own alert setup. You need the project role **devops** or **owner** (or be a Cairn admin or DevOps user) to change it.

## Set up your first alert

1. Open **Alerts** and choose your project in **Project**.
2. Go to **Channels**. Choose a **Type** (for example `slack`), give it a **Name**, paste the **Incoming webhook URL**, and choose **Create channel**.
3. Choose **Test** on the new channel. A test message should arrive.
4. Go to **Monitors** and create a rule. Example: name `High error rate`, kind **Trace (span metrics)**, signal **Error rate %**, condition `> 5`, for `300` seconds, severity `critical`.
5. Choose **Create monitor**.

When the error rate stays above 5% for 5 minutes, an incident opens and the channel gets a message. When it recovers, the channel gets a resolution message.

To try the whole path without breaking anything, go to **Incidents** and choose **Raise test alert**, then **Resolve test alert**.

## What you can set up

The **Alerts** page has these tabs:

| Tab | What it is for |
|---|---|
| Incidents | Open, acknowledged and resolved alerts. **Acknowledge** stops escalation. **Resolve** closes it. With **All projects** selected you see incidents only |
| Monitors | Rules that open an incident when a value crosses a limit for a time |
| SLOs | Targets such as "99.9% of requests succeed over 30 days", with the error budget left (how much failure you can still afford) |
| Silences | Pause alerts for a time, for the whole project or for matching alerts. A **maintenance** window is a silence for planned work |
| Channels | Where messages go: Slack, PagerDuty, Microsoft Teams, Discord, a signed webhook, or email |
| Escalation & on-call | Who is told first, who is told next if nobody acknowledges, and on-call rotations |

### Monitor kinds

| Kind | Watches | Who can create it |
|---|---|---|
| Trace (span metrics) | Error rate %, p95 latency in ms, or requests per second, optionally for one service | Project devops or owner |
| CPU / memory | CPU or memory as a % of the containers' limits | Project devops or owner |
| Metric (PromQL) | Any Prometheus query you write | Cairn admin or DevOps only |
| Log (LogQL) | Any log metric query you write | Cairn admin or DevOps only |

Trace monitors need the full install profile and services that use the Cairn SDK.

### SLOs

An SLO (service level objective) is a target such as "99.9% of requests succeed over 30 days". Pick one of:

- **Availability**: the share of requests without an error.
- **Latency**: the share of requests faster than a limit you pick (64 to 4096 ms).
- **Custom PromQL ratio**: your own error and total queries. Cairn admin or DevOps only.

You get two alerts per SLO. A **page** (critical) fires when the budget burns very fast. A **ticket** (warning) fires when it burns slowly but steadily.

### Escalation

Without a policy, every enabled channel of the project gets every alert. With a policy, step 0 is sent at once. Later steps are sent if the incident is still firing and nobody acknowledged it after the delay you set. Steps can target channels, an on-call schedule (the person on call gets a notification in the portal) and users.

Each channel also has a **Minimum severity** (`info`, `warning` or `critical`).

### Email channels

Email uses the default SMTP configuration in **Settings**. Set that up first.

## How it works

### How alerts flow

```
monitors / SLOs ──► Prometheus ruler ──► Alertmanager ──► POST /api/alerting/alertmanager/webhook ─┐
   (full profile)                         route project=<id>                                       │
monitors / SLOs ──► API evaluator (other profiles, log monitors without the Loki ruler) ───────────┤
error tracking, synthetics, deploys, ... ──► Redis stream plat:api:alerts:events ──────────────────┤
                                                                                                    ▼
                                    leader: incidents (dedupe by dedupeKey) ─► silences ─► escalation policy
                                                                                                    ▼
                                    alert_deliveries ─► Slack / PagerDuty / Teams / Discord / webhook / e-mail / on-call user
```

- **Dedupe**: one open incident per `(project, dedupeKey)`. Repeats only raise the event count (and the severity, if higher). A `resolved` event closes it and sends one resolution message to every channel and user that got the firing message. The next firing opens a new incident.
- **Silences** apply to every source, inside the API. No matchers means the whole project. Matchers use Alertmanager rules (`=`, `!=`, regex) on the event labels plus `source`, `severity`, `dedupeKey` and `environment`. An incident silenced when it opened is notified if it is still firing when the silence ends. In the full profile, silences are also copied to Alertmanager (always with the `project` matcher).
- **Escalation**: step N is sent `delayMinutes` after the incident opened if it is still firing and not acknowledged. Acknowledging stops escalation (PagerDuty gets `acknowledge`).
- **Delivery** is retried with backoff (30 s doubling: 30, 60, 120, 240 s, capped at 30 minutes, up to `ALERTING_MAX_DELIVERY_ATTEMPTS`, default 5) for network errors, timeouts, HTTP 5xx, 408 and 429. Other 4xx fail at once and are shown on the channel. Email: connection problems, timeouts and SMTP 4xx replies are retried; SMTP 5xx replies and authentication failures fail at once.
- **Timeouts and concurrency**: every send is bounded by `ALERTING_DELIVERY_TIMEOUT_MS` (default 10 s, 1–60 s), including email (SMTP connect, greeting, socket inactivity and the whole send). The dispatcher sends up to `ALERTING_DELIVERY_CONCURRENCY` deliveries in parallel (default 4, 1–32), so an unreachable SMTP server or webhook holds one slot for at most the timeout.
- **Resolution messages** use the title of the resolving event when the source sends one (for example `Synthetic check "api" recovered`). Manual resolves keep the incident title.
- **Status pages**: on a published [status page](../guides/status-pages.md), a new `major` or `critical` incident (not maintenance) sends a `status-page` event; resolving it sends the resolution.

### Monitor queries

| `kind` | Query | Notes |
|---|---|---|
| `metric` | PromQL instant query | Compared with `operator threshold` for `forSeconds` |
| `log` | LogQL metric query | Evaluated by the API unless `ALERTING_LOKI_RULER=enabled` |
| `trace` | `params.signal`: `error_rate` (%), `latency_p95` (ms), `request_rate` | From Tempo span metrics, always scoped to the project |
| `resource` | `params.resource`: `cpu` or `memory` (% of limits) | Scoped to the project's namespaces |

`trace` and `resource` monitors are built and scoped to the project by Cairn. `metric` and `log` queries are not rewritten to the project's scope, so only Cairn admins and DevOps users can create them, edit them, or change another monitor's kind to them (others get `403`).

### SLO rules

`sliType` is `availability` (non-error share of spans), `latency` (share of spans faster than `params.latencyMs`, a span-metrics bucket boundary) or `ratio` (`errorQuery` / `totalQuery`, both using `$window`). Each SLO renders Sloth-style recording rules (`slo:sli_error:ratio_rate<window>` for 5m, 30m, 1h, 2h, 6h, 1d, 3d and the SLO period) and two multi-window, multi-burn-rate alerts:

- **page** (critical): 1h and 5m burn > 14.4, or 6h and 30m burn > 6
- **ticket** (warning): 1d and 2h burn > 3, or 3d and 6h burn > 1

These factors are for a 30-day period; they scale with `windowDays`. The error budget is refreshed every minute by the leader replica, or on demand with `?refresh=1`.

### Channel details

| `type` | Secret fields | Notes |
|---|---|---|
| `slack` | `webhookUrl`, or `botToken` + `config.channel` | Text is escaped (no mentions) |
| `pagerduty` | `routingKey` (Events v2) | `config.region` `us` or `eu`; trigger, acknowledge and resolve with a stable `dedup_key` |
| `teams` | `webhookUrl` (Workflows) | Adaptive Card |
| `discord` | `webhookUrl` | `allowed_mentions` disabled |
| `webhook` | `url`, `signingSecret` (generated if empty, shown once) | Signed, see below |
| `email` | none (`config.to`) | Default SMTP configuration |

Channel secrets are encrypted with `SECRETS_ENCRYPTION_KEY` and never returned; `GET` shows only which fields are set and the destination host. Outbound requests refuse loopback, private, CGNAT, link-local (including cloud metadata), multicast and internal host names, checked before the request and again at connect time. Redirects are not followed. Only a Cairn admin can set `allowPrivateNetwork` on a channel.

**Webhook signature**: header `X-Platform-Signature: t=<unix seconds>,v1=<hex>` where `hex = HMAC-SHA256(signingSecret, "<t>.<raw body>")`. Verify with a constant-time compare and reject timestamps older than 5 minutes. `X-Platform-Event` is `incident.firing`, `incident.resolved`, `incident.acknowledged`, `incident.escalation` or `incident.test`.

**SMTP configuration**: the password or API key is encrypted with `SECRETS_ENCRYPTION_KEY` and never returned (`GET` shows `***`). Configurations saved by older versions in plain text stay readable and are encrypted at the next API start. Only these fields are accepted: `name`, `provider`, `host`, `port`, `secure`, `username`, `password`, `apiKey`, `fromEmail`, `fromName`, `isDefault`; `host`, `port`, `secure` and `fromEmail` are validated. There is no update endpoint: delete and re-create a configuration to change it. Other SMTP users (deploy and backup emails) have a 15 s timeout.

### Evaluation modes

`ALERTING_MODE` defaults to `ruler` when `PLATFORM_OBSERVABILITY=enabled` (the full profile), otherwise `api`. The **Alerts** page shows the mode next to its title.

- `ruler`: the API writes `PrometheusRule` and `AlertmanagerConfig` objects named `platform-alerts-<projectId>` to the `monitoring` namespace (RBAC in `alerting-rbac.yaml`, installed by platformctl in the full profile only). Alertmanager routes `project=<id>` to the API webhook with a bearer token from the `platform-alerting-webhook` Secret (derived from `SECRETS_ENCRYPTION_KEY`). Channel secrets are not copied into Alertmanager: delivery, signing, silences and escalation stay in the API.
- `api`: the leader evaluates monitors and SLO burn rates every `ALERTING_EVALUATE_INTERVAL_MS` (default 60 s) with instant queries against `ALERTING_PROMETHEUS_URL` and `ALERTING_LOKI_URL`.
- `off`: no evaluation; events from other features are still routed.

The installer does not enable the Loki ruler. To evaluate log monitors in Loki, enable the ruler (`rulerConfig` with `enable_api: true` and the Alertmanager URL) and set `ALERTING_LOKI_RULER=enabled`.

### Permissions and audit

- Read (incidents, monitors, SLOs, silences, channels without secrets): project members (viewer and up).
- Acknowledge or resolve incidents: project developer and up.
- Configure a project's alerting: project **devops** or **owner**, and Cairn admins or DevOps users (who can configure every project):

  | What | Project devops or owner | Cairn admin or DevOps |
  |------|------------------------|-------------------------|
  | Channels (including test send), escalation policies, on-call schedules, silences, test events | yes | yes |
  | SLOs `availability` and `latency` | yes | yes |
  | SLOs `ratio` (raw PromQL) | no | yes |
  | Monitors `trace` and `resource` | yes | yes |
  | Monitors `metric` and `log` (raw PromQL or LogQL), including editing them or switching a monitor to them | no | yes |
  | `allowPrivateNetwork` on a channel | no | admin only |

  Project devops and owners can page (in policies and schedules) only users who can see the project: its members and Cairn admins or DevOps users. Cairn admins and DevOps users can page any user.
- Agent tokens are read-only on alerting.
- Every change is written to the audit log, never with secret values.

### Retention

The leader's hourly `alerting-retention` job prunes history:

| Data | Kept | Setting |
|------|------|---------|
| `alert_deliveries` (sent, failed, skipped) | 30 days after creation | `ALERTING_DELIVERY_RETENTION_DAYS` |
| Resolved `alert_incidents` (and their deliveries) | 180 days after resolution | `ALERTING_INCIDENT_RETENTION_DAYS` |

Pending deliveries and open or acknowledged incidents are never pruned. The audit log (`audit_logs`, including `alerting.*` actions) is not pruned by Cairn; archive or trim it with your own database tools if your policy requires it.

### Events from other features

Other features publish with `publishAlertEvent()` from `platform/api/src/lib/alert-events.ts`. The leader's `alerting-consumer` job processes them (consumer group `alerting`, at-least-once; failed entries are retried and dropped after `ALERTING_CONSUMER_MAX_ATTEMPTS`, default 5). Without Redis (memory state mode) published events are dropped; events from inside the API are processed inline.

### Legacy alert rules

The old `/api/alerts` rules keep working. Existing rows were copied to monitors by migration `1798000000043-Alerting` (`legacy_alert_id`), and rows created or changed through `/api/alerts` are mirrored. Legacy metrics map to: `cpu` and `memory` to resource monitors, `latency` to p95 latency, `errorRate` to error rate; unknown metrics are copied disabled. `POST /api/alerts/evaluate` still answers with the rules that match the metrics the caller sends, but it is deprecated (`Deprecation` header) and notifies nobody. The legacy `slack_webhook` column is not migrated; create a Slack channel instead.

### Check it on a server (full profile)

1. `sudo platformctl provision --profile full`, then `kubectl -n monitoring get role platform-alerting`.
2. Create a `webhook` channel pointing at a test receiver you control. Note the signing secret.
3. On **Incidents**, choose **Raise test alert**: one signed `incident.firing` request arrives. Choosing it again sends nothing. **Resolve test alert** sends one `incident.resolved`.
4. Create a silence for the project and raise the test alert again: no request until the silence ends.
5. Create an `availability` SLO for an instrumented service and a `metric` monitor, then run `kubectl -n monitoring get prometheusrule,alertmanagerconfig | grep platform-alerts`.
6. Make the example app return 5xx for a few minutes: the SLO `page` alert fires through Alertmanager, the API and the channel. It resolves after the errors stop.

## For developers / API

All paths are under `/api`. Project alerting lives under `/api/projects/<projectId>/alerting/`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/alerting/status` | Evaluation mode and whether the Loki ruler is on |
| `GET` | `/alerting/incidents` | Incidents across projects you can see |
| `GET`, `POST` | `/projects/<id>/alerting/channels` | List or create channels |
| `PUT`, `DELETE` | `/projects/<id>/alerting/channels/<channelId>` | Update or delete a channel |
| `POST` | `/projects/<id>/alerting/channels/<channelId>/test` | Send a test message |
| `GET`, `POST` | `/projects/<id>/alerting/monitors` | List or create monitors |
| `PUT`, `DELETE` | `/projects/<id>/alerting/monitors/<monitorId>` | Update or delete a monitor |
| `GET`, `POST` | `/projects/<id>/alerting/slos` | List or create SLOs |
| `PUT`, `DELETE` | `/projects/<id>/alerting/slos/<sloId>` | Update or delete an SLO |
| `GET` | `/projects/<id>/alerting/slos/<sloId>/status` | Error budget (`?refresh=1` to recompute) |
| `GET`, `POST` | `/projects/<id>/alerting/silences` | List or create silences |
| `DELETE` | `/projects/<id>/alerting/silences/<silenceId>` | Expire a silence |
| `GET`, `POST` | `/projects/<id>/alerting/policies` | List or create escalation policies |
| `PUT`, `DELETE` | `/projects/<id>/alerting/policies/<policyId>` | Update or delete a policy |
| `GET`, `POST` | `/projects/<id>/alerting/schedules` | List or create on-call schedules |
| `PUT`, `DELETE` | `/projects/<id>/alerting/schedules/<scheduleId>` | Update or delete a schedule |
| `GET` | `/projects/<id>/alerting/incidents` | Project incidents |
| `GET` | `/projects/<id>/alerting/incidents/<incidentId>` | One incident |
| `POST` | `/projects/<id>/alerting/incidents/<incidentId>/ack` | Acknowledge |
| `POST` | `/projects/<id>/alerting/incidents/<incidentId>/resolve` | Resolve |
| `POST` | `/projects/<id>/alerting/test-event` | Raise or resolve the test alert |
| `POST` | `/alerting/alertmanager/webhook` | Alertmanager receiver (bearer token from `platform-alerting-webhook`) |
