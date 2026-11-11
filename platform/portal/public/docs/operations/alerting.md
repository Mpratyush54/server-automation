# Alerting and on-call

Alerting is project-scoped. Each project has **monitors**, **SLOs**, **silences / maintenance
windows**, **notification channels**, **escalation policies** and **on-call schedules**. The portal
page is **Alerting** (`/alerting`). The API lives under `/api/projects/<projectId>/alerting/*`.

## How alerts flow

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

* **Dedupe**: one open incident per `(project, dedupeKey)`. Repeats only increase the event count
  (and the severity, if higher). A `resolved` event closes it and sends one resolution message to
  every channel and user that got the firing message. The next firing opens a new incident.
* **Silences** apply to every source, inside the API. No matchers = the whole project. Matchers use
  Alertmanager semantics (`=`, `!=`, regex) on the event labels plus `source`, `severity`,
  `dedupeKey`, `environment`. An incident silenced when it opened is notified if it is still firing
  when the silence ends. In the full profile, silences are also mirrored to Alertmanager (always with
  the `project` matcher).
* **Escalation**: step 0 is sent at once; step N is sent `delayMinutes` after the incident opened
  if it is still firing and not acknowledged. Steps target channels, on-call schedules (the user on
  call gets an in-app notification) and users. Without a policy, every enabled channel of the project
  is notified. Acknowledging stops escalation (PagerDuty gets `acknowledge`).
* **Delivery** is retried with backoff (30 s doubling: 30, 60, 120, 240 s, up to
  `ALERTING_MAX_DELIVERY_ATTEMPTS`, default 5) for network errors, timeouts, HTTP 5xx, 408 and 429.
  Other 4xx fail at once and are shown on the channel. E-mail: connection problems, timeouts and
  SMTP 4xx replies are retried; SMTP 5xx replies and authentication failures fail at once.
* **Timeouts and concurrency**: every send is bounded by `ALERTING_DELIVERY_TIMEOUT_MS` (default
  10 s, 1..60 s), including e-mail (SMTP connect, greeting and socket inactivity, and the whole
  send; nodemailer's own 2-minute connect default no longer applies). The dispatcher sends up to
  `ALERTING_DELIVERY_CONCURRENCY` deliveries in parallel (default 4, 1..32), so an unreachable
  SMTP server or webhook holds one slot for at most the timeout and other channels keep flowing.
* **Resolution messages** use the title of the resolving event when the source sends one (for
  example `Synthetic check "api" recovered`); manual resolves keep the incident title.
* **Status pages**: on a published [status page](../guides/status-pages.md), a new `major` / `critical`
  incident (not maintenance) sends a `status-page` event; resolving it sends the resolution.

## Monitors

| kind       | query                                  | notes |
|------------|----------------------------------------|-------|
| `metric`   | PromQL instant query                   | compared with `operator threshold` for `forSeconds` |
| `log`      | LogQL metric query (Loki)              | evaluated by the API unless `ALERTING_LOKI_RULER=enabled` |
| `trace`    | `params.signal`: `error_rate` (%), `latency_p95` (ms), `request_rate` | from Tempo span metrics, always scoped to the project |
| `resource` | `params.resource`: `cpu` / `memory` (% of limits) | scoped to the project's namespaces |

Only platform admins and devops can create monitors; PromQL / LogQL is not rewritten, so these
roles are trusted with cross-project queries. Trace and resource monitors are always project-scoped.

## SLOs

`sliType` `availability` (non-error share of spans), `latency` (share of spans faster than
`params.latencyMs`, a span-metrics bucket boundary) or `ratio` (`errorQuery` / `totalQuery`, both
using `$window`). Each SLO renders Sloth-style recording rules (`slo:sli_error:ratio_rate<window>`
for 5m, 30m, 1h, 2h, 6h, 1d, 3d and the SLO period) and two multi-window, multi-burn-rate alerts:

* **page** (critical): 1h and 5m burn > 14.4, or 6h and 30m burn > 6
* **ticket** (warning): 1d and 2h burn > 3, or 3d and 6h burn > 1

(factors for a 30-day period; they scale with `windowDays`). The SLO dashboard shows the error
budget remaining for the period (refreshed every minute by the leader, `?refresh=1` on demand).

## Channels

| type        | secret fields                          | notes |
|-------------|----------------------------------------|-------|
| `slack`     | `webhookUrl`, or `botToken` + `config.channel` | text is escaped (no mentions) |
| `pagerduty` | `routingKey` (Events v2)               | `config.region` `us` / `eu`; trigger / acknowledge / resolve with a stable `dedup_key` |
| `teams`     | `webhookUrl` (Workflows)               | Adaptive Card |
| `discord`   | `webhookUrl`                           | `allowed_mentions` disabled |
| `webhook`   | `url`, `signingSecret` (generated if empty, shown once) | signed, see below |
| `email`     | none (`config.to`)                     | default SMTP configuration |

E-mail uses the default SMTP configuration (**Settings → SMTP**). Its password / API key is
encrypted with `SECRETS_ENCRYPTION_KEY` like channel secrets and never returned (`GET` shows `***`);
configurations saved by older versions in plain text stay readable and are encrypted at the next
API start. Only the documented fields are accepted (`name`, `provider`, `host`, `port`, `secure`,
`username`, `password`, `apiKey`, `fromEmail`, `fromName`, `isDefault`); `host`, `port`, `secure`
and `fromEmail` are validated. There is no update endpoint: delete and re-create a configuration to
change it. Other SMTP users (deploy and backup e-mails) are bounded by a 15 s timeout.

Channel secrets are encrypted with `SECRETS_ENCRYPTION_KEY` and never returned; `GET` shows only which
fields are set and the destination host. Outbound requests refuse loopback, private, CGNAT,
link-local (including cloud metadata), multicast and internal host names, checked before the request
and again at connect time; redirects are not followed. Only a platform admin can set
`allowPrivateNetwork` on a channel.

**Webhook signature**: header `X-Platform-Signature: t=<unix seconds>,v1=<hex>` where
`hex = HMAC-SHA256(signingSecret, "<t>.<raw body>")`. Verify with a constant-time compare and reject
timestamps older than 5 minutes. `X-Platform-Event` is `incident.firing|resolved|acknowledged|escalation|test`.

## Evaluation modes

`ALERTING_MODE` (default: `ruler` when `PLATFORM_OBSERVABILITY=enabled`, i.e. the full profile,
otherwise `api`):

* `ruler`: the API writes `PrometheusRule` and `AlertmanagerConfig` objects named
  `platform-alerts-<projectId>` to the `monitoring` namespace (RBAC: `alerting-rbac.yaml`, installed
  by platformctl in the full profile only). Alertmanager routes `project=<id>` to the API webhook
  with a bearer token from the `platform-alerting-webhook` Secret (derived from
  `SECRETS_ENCRYPTION_KEY`). Channel secrets are not copied into Alertmanager: delivery, signing,
  silences and escalation stay in the API so every source shares one pipeline.
* `api`: the leader evaluates monitors and SLO burn rates every `ALERTING_EVALUATE_INTERVAL_MS`
  (60 s) with instant queries against `ALERTING_PROMETHEUS_URL` / `ALERTING_LOKI_URL`.
* `off`: no evaluation; events from other features are still routed.

The Loki ruler is not enabled by the installer. To evaluate log monitors in Loki, enable the ruler
(`rulerConfig` with `enable_api: true` and the Alertmanager URL) and set `ALERTING_LOKI_RULER=enabled`.

## Permissions and audit

* Read (incidents, monitors, SLOs, silences, channels without secrets): project members (viewer+).
* Acknowledge / resolve incidents: project developer+.
* Configuration (channels, monitors, SLOs, silences, policies, schedules, test events): platform
  admin or devops. Every change is written to the audit log (never with secret values).

## Retention

The leader's hourly `alerting-retention` job prunes history:

| Data | Kept | Setting |
|------|------|---------|
| `alert_deliveries` (sent / failed / skipped) | 30 days after creation | `ALERTING_DELIVERY_RETENTION_DAYS` |
| resolved `alert_incidents` (and their deliveries) | 180 days after resolution | `ALERTING_INCIDENT_RETENTION_DAYS` |

Pending deliveries and open or acknowledged incidents are never pruned. The audit log
(`audit_logs`, including `alerting.*` actions) is not pruned by the platform: it is the compliance
record; archive or trim it with your own database tooling if your policy requires it.

## Legacy `/api/alerts`

The old alert rules keep working. Existing rows are copied to monitors by migration
`1798000000043-Alerting` (`legacy_alert_id`), and rows created or changed through `/api/alerts` are
mirrored. Legacy metrics map to: `cpu` / `memory` → resource monitors, `latency` → p95 latency,
`errorRate` → error rate; unknown metrics are copied disabled. `POST /api/alerts/evaluate` still
answers with the triggered rules for the metrics the caller sends, but is deprecated (`Deprecation`
header) and notifies nobody: real evaluation is rule-based. The legacy `slack_webhook` column is not
migrated; create a Slack channel instead.

## Producers

Other features publish with `publishAlertEvent()` from `platform/api/src/lib/alert-events.ts` (shared
contract). Events are processed by the leader's `alerting-consumer` job (consumer group `alerting`,
at-least-once; failed entries are retried and dropped after `ALERTING_CONSUMER_MAX_ATTEMPTS`). Without
Redis (memory state mode) published events are dropped; API-internal events are processed inline.

## Verify on a VM (full profile)

1. `sudo platformctl provision --profile full`; check `kubectl -n monitoring get role platform-alerting`.
2. In the portal, create a `webhook` channel pointing at a test receiver you control; note the signing secret.
3. On the **Incidents** tab press **Raise test alert**: one signed `incident.firing` request arrives;
   pressing it again sends nothing; **Resolve test alert** sends one `incident.resolved`.
4. Create a silence for the project, raise the test alert again: no request until the silence ends.
5. Create an `availability` SLO for an instrumented service and a `metric` monitor; check
   `kubectl -n monitoring get prometheusrule,alertmanagerconfig | grep platform-alerts`.
6. Inject errors into the example app (5xx for a few minutes): the SLO `page` alert fires through
   Alertmanager → API → channel; it resolves after the errors stop.
