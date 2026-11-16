# Privacy and data retention

Choose how long each project keeps logs, errors, replays and heatmaps, remove personal data before it is stored, set consent defaults, and delete everything stored about one person. All of this is in the project's **Settings** section, **Privacy** panel.

Personal data is removed on the server, which is the safety net. The browser SDKs also mask data before sending it, as an extra layer.

## Change how long data is kept

1. Open the project, go to **Settings**, then **Privacy**.
2. Under **Retention**, type a number of days (1–365) next to a data type. Leave a field empty to use the default.
3. Click **Save retention**.

| Data | Default | Per project |
|---|---|---|
| Logs | 30 days (the server-wide setting) | Yes |
| Errors | 90 days | Yes |
| Session replays | 7 days | Yes |
| Heatmaps | 90 days | Yes |
| Traces | 30 days (server-wide) | No |
| Profiles | 30 days (server-wide) | No |

Traces and profiles are shown as "Set for the whole platform". To change them, an administrator sets `TELEMETRY_RETENTION_DAYS` and re-runs provision (see [Full monitoring](telemetry.md)). Expired data is removed within about an hour; log deletion can take longer.

## Remove personal data from logs and traces

Built-in rules always replace these before data is stored:

- e-mail addresses become `[EMAIL]`
- authorization headers, SDK and agent tokens, cookies and password-like values become `[REDACTED]`; JWTs become `[REDACTED_JWT]`
- card numbers (13–19 digits) become `[CARD]`
- IPv4 addresses become `[IP]` in the collector (full profile); on the API path only when the IP option below is on

To add your own rule, for example for order numbers:

1. Under **PII scrubbing**, **Custom rules**, click **Add rule**.
2. Enter a **Name** (`order-id`), a **Pattern** (a regular expression, `ORD-[0-9]+`) and a **Replacement** (`[REDACTED]`).
3. Click **Save scrubbing**.

Turn on **Redact IP addresses on the API path** to also remove IPv4 and IPv6 addresses from data sent through the API.

## Set consent defaults

Consent defaults decide what happens before a visitor has made a choice. A visitor's own choice always wins.

- **Record session replays by default**: off. Keep it off so recording starts only after the visitor agrees.
- **Allow analytics by default**: on. Analytics (such as heatmaps) are collected unless the visitor opts out.

Click **Save consent defaults** after a change.

## Delete a person's data

Use this for a data deletion request, for example under GDPR. Only project owners can do it. It cannot be undone.

1. Under **Delete a person's data**, enter a **User id** (the id your app sends as `user.id`), a **Session id**, or both.
2. Optionally enter their **Email**. Only a hash of it is kept, in the audit log, as a record of the request.
3. Click **Delete this data**.

This removes the person's log entries and error events, their consent records, their session replays, and matching log lines in the log store. The result shows what was removed and any warnings. A step that fails does not stop the others.

Matching log lines disappear from search after about 5 minutes. They are removed from storage after about 24 hours.

Heatmaps are anonymous counts, so there is nothing to delete there.

## How it works

### Where data is stored

| Store | What | Identifiers | Default retention | How it is deleted |
|---|---|---|---|---|
| Grafana Alloy, then Loki | OTLP and Faro logs, pod logs, SDK logs forwarded by the API | `platform_project_id` (Alloy) or `project_id` (API) labels; optional `user.id` or session in the body | 30 days (`TELEMETRY_RETENTION_DAYS`); per-project logs override through Loki runtime overrides | Loki delete API (`POST /loki/api/v1/delete`) |
| Tempo | Traces and span attributes | `platform.project_id` | 30 days (global, single-tenant) | Compactor retention only |
| Pyroscope | Profiles | project labels | 30 days | Compactor retention only |
| Prometheus | Metrics | project and environment dimensions from Tempo generators | 30 days | Prometheus retention |
| MongoDB `logs` | SDK logs sent through the API | `projectId`, optional `userId` or `sessionId` | 30-day TTL index | GDPR delete and TTL |
| MongoDB `errors` | Aggregated error documents | `projectId`, optional `userId` or `sessionId` | Not pruned automatically | GDPR delete |
| Postgres `error_events` and `error_issues` | Error tracking events and issues | `project_id`, event payload | Project `errors` setting, default 90 days (`error-retention` job) | Retention job; GDPR delete (events); project delete |
| MinIO `replays` and Postgres `replay_sessions` / `replay_chunks` | Session replay chunks | `replays/{projectId}/{sessionId}/{seq}.json.gz`; `user_id` and `subject_id` on `replay_sessions` | Project `replays` setting, default 7 days (`replay-retention` job), plus a 365-day bucket lifecycle backstop | GDPR delete; retention job; lifecycle |
| Postgres `heatmap_*` | Click and scroll aggregates per page, viewport and day | `project_id` only (no user, session or IP) | Project `heatmaps` setting, default 90 days (`heatmaps-retention` job) | Retention job; project delete |
| Postgres `telemetry_consents` | Consent per subject | `project_id`, `subject_id`, `session_id` | Until withdrawn or GDPR delete | GDPR delete |
| Postgres `telemetry_privacy_settings` | Per-project rules | `project_id` | Configuration | Project delete (manual) |
| Postgres `audit_logs` | `privacy.*` actions | actor user id; e-mail only as SHA-256 | Cairn audit retention | Not purged by GDPR delete |

E-mails given to GDPR delete are never stored in clear text. Only `sha256(lower(email))` appears in audit metadata.

### Scrubbing

- In the collector (full profile), `otelcol.processor.transform "pii_scrub"` runs after identity is set and before batching, on traces and logs (not metrics, not `/pyroscope`). Token patterns include `sdk_live_`, `sdk_test_`, `plat_agent_` and `plat_ingest_`, plus Authorization, Bearer and Basic values. Kubernetes pod logs go through `loki.process "pii_scrub"` with the same replacements.
- On the API path, `processLogs` applies `lib/pii-scrub.ts` (built-in rules, project rules, optional IP rule) before the MongoDB insert and the Loki push. Card matches there must pass a Luhn check.
- Standard and minimal installs have no collector. They keep API scrubbing and the privacy settings. The collector processors and the `replays` bucket exist only with the full profile (`PLATFORM_OBSERVABILITY=enabled`).

### Consent for session replay

Helpers `isReplayAllowed`, `resolveConsent` and `upsertConsent` are in `platform/api/src/lib/privacy-consent.ts`. A session's `user_id` and `subject_id` are kept in `replay_sessions`, so GDPR delete and retention can find every session of a subject.

### Retention: what actually applies

- Retention values are integers 1–365. Tempo and Pyroscope run single-tenant, so a per-project period cannot be enforced: `traces` and `profiles` values are rejected with 400, and older stored values are ignored. The API learns the cluster period from `TELEMETRY_RETENTION_DAYS`, set by platformctl on the API Deployment.
- **Errors:** every hour the leader deletes `error_events` older than the project's setting in bounded batches (`ERROR_RETENTION_BATCH`, default 5000 rows, at most `ERROR_RETENTION_MAX_BATCHES`, default 20, per project per run; a backlog is cleared over the next runs). Issues with no events left that were last seen before the cutoff are deleted. Issues that still have events keep their lifetime `count`, `first_seen` and per-release counts. An error that returns after its issue was removed opens a new issue ("New issue" alert, not "Regression").
- **Logs:** Loki's global `retention_period` is `TELEMETRY_RETENTION_DAYS`. For each project with a logs override, the API keeps two `retention_stream` rules under the `fake` tenant in the `loki-runtime` ConfigMap (`monitoring` namespace): `{platform_project_id="<id>"}` (Alloy) and `{project_id="<id>"}` (API-forwarded SDK logs), with period = days × 24h. Loki re-reads the file within seconds; the compactor deletes expired chunks after its delete delay. The leader re-applies the rules every 10 minutes (`LOKI_RETENTION_RECONCILE_MS`), because a `helm upgrade` of Loki resets the ConfigMap, and right after a project's logs setting changes. Other keys are kept. RBAC: `get` and `update` on that one ConfigMap (Role `platform-alerting`, full profile only). Set `LOKI_RETENTION_OVERRIDES=disabled` to stop managing it. Without the full profile there is no Loki and only the stored value changes. API-forwarded SDK lines at level `ERROR` carry `telemetry_type="errors"`; they are log lines and follow the logs retention.
- **Replays:** the hourly `replay-retention` job deletes sessions that ended before the cutoff (objects and `replay_sessions` rows). The 365-day lifecycle rule on `replays/` removes orphaned objects.
- **Heatmaps:** the hourly `heatmaps-retention` job prunes the `heatmap_*` aggregates.

### What GDPR delete does

1. Deletes MongoDB `logs` and `errors` documents matching `userId` or `sessionId` (fields or message).
2. Deletes Postgres `error_events` whose payload carries the `userId` or `sessionId`.
3. Deletes `telemetry_consents` rows and clears the Redis consent cache.
4. Deletes the subject's session replays (found through `replay_sessions` by user or subject id, or the given session): MinIO objects under `replays/{projectId}/{sessionId}/` and the rows, when replay storage is configured.
5. Sends one Loki delete request per identifier: `{platform_project_id="<project>"} |= "<userId>"` (and the same for `sessionId`), from the start of the data.
6. Writes the audit entry `privacy.gdpr_delete` with counts, warnings and the optional `emailHash`.

Loki accepts a delete request at once (status `received`) and hides the matching lines from queries once its queriers refresh, about 5 minutes later. The compactor removes the data after `delete_request_cancel_period` (24 hours by default); until then the request can be cancelled through Loki's delete API. Other lines in the same streams are kept.

## For developers / API

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/projects/:id/privacy` | Project viewer | Settings, effective `retentionDays`, stored `retentionOverrides`, `retentionScope` (`project` or `cluster`) |
| `PUT /api/projects/:id/privacy/scrubbing` | Project devops | Custom rules and IP toggle |
| `PUT /api/projects/:id/privacy/retention` | Project devops | Integers 1–365 for `logs`, `replays`, `errors`, `heatmaps`; `null` clears an override; omitted keys are unchanged |
| `PUT /api/projects/:id/privacy/consent-defaults` | Project devops | Defaults when a subject has no consent record |
| `GET /api/projects/:id/privacy/consent?subjectId=` | Project viewer | Inspect a subject's consent |
| `PUT /api/projects/:id/privacy/consent` | Project devops | Override a subject's consent |
| `POST /api/projects/:projectId/privacy/gdpr-delete` | Project owner | Delete a subject's data |
| `GET /api/sdk/privacy/replay-allowed?subjectId=&sessionId=` | SDK token (browser or server) | Whether replay may start |
| `GET` and `PUT /api/sdk/privacy/consent` | SDK token (browser or server) or signed-in user | Read or record consent from your app |

The GDPR delete response reports `deleted.logs`, `errors`, `consents`, `replayObjects` and `lokiRequests`, plus any `warnings` (for example an unreachable backend).
