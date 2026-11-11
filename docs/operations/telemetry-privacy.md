# Telemetry privacy, retention and GDPR delete

Issue #47. Server-side scrubbing is authoritative; SDK client masking is defence-in-depth.
Session replay storage and the portal player ship in #40 — this document defines the
consent hooks, object-key contract and retention defaults that #40 must honour.

## Data inventory

| Store | What | Identifiers | Default retention | Delete path |
|-------|------|-------------|-------------------|-------------|
| Grafana Alloy → Loki | OTLP/Faro logs, pod logs, API-forwarded SDK logs | `platform_project_id` (Alloy) / `project_id` (API) labels, optional `user.id` / session in body | 30d (`TELEMETRY_RETENTION_DAYS`); per-project logs override via Loki runtime overrides | Loki delete API (`POST /loki/api/v1/delete`) |
| Tempo | Traces / span attributes | `platform.project_id` | 30d (global; single-tenant) | Compactor retention only |
| Pyroscope | Profiles | project labels when present | 30d | Compactor retention only |
| Prometheus | Metrics | project/env dimensions from Tempo generators | 30d | Prometheus retention |
| MongoDB `logs` | API-path SDK logs | `projectId`, optional `userId` / `sessionId` | TTL index 30d | GDPR delete + TTL |
| MongoDB `errors` | Aggregated error docs | `projectId`, optional `userId` / `sessionId` | Not pruned automatically | GDPR delete |
| Postgres `error_events` / `error_issues` | Error tracking (#41) events and issues | `project_id`, event payload | Project `errors` setting, default 90d (`error-retention` job) | Retention job; project delete |
| MinIO `replays` | Session replay chunks (#40) | `replays/{projectId}/{sessionId}/{seq}.json.gz` | per-project retention job (default 7 d) + 365 d lifecycle backstop | GDPR delete + lifecycle |
| Postgres `telemetry_consents` | Subject consent | `project_id`, `subject_id`, `session_id` | Until withdrawn / GDPR delete | GDPR delete |
| Postgres `telemetry_privacy_settings` | Per-project rules | `project_id` | N/A (config) | Project delete (manual) |
| Postgres `audit_logs` | `privacy.*` actions | actor user id; email only as SHA-256 | Platform audit retention | Not purged by GDPR delete |

Emails supplied to GDPR delete are never stored in clear text — only `sha256(lower(email))`
appears in audit metadata.

## PII scrubbing

### Collector (Alloy, full profile)

`otelcol.processor.transform "pii_scrub"` runs after identity attribution and before
batching on **traces and logs** (not metrics, not `/pyroscope`). Patterns:

- Email → `[EMAIL]`
- Authorization / Bearer / Basic, SDK (`sdk_live_` / `sdk_test_` / `plat_agent_` / `plat_ingest_`), JWT → `[REDACTED]` / `[REDACTED_JWT]`
- 13–19 digit card-like runs → `[CARD]`
- IPv4 → `[IP]`

Kubernetes pod logs go through `loki.process "pii_scrub"` with the same replacements.

### API path

`processLogs` applies `lib/pii-scrub.ts` (built-ins + per-project rules, optional IP
toggle) before Mongo insert and Loki push. Card matches require a Luhn check.

### Portal

Project → **Privacy** tab edits custom regex rules, IP toggle, retention and consent
defaults, and runs GDPR delete.

## Consent hooks for session replay (#40)

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `GET /api/sdk/privacy/replay-allowed?subjectId=&sessionId=` | Browser/server SDK token | Gate rrweb start |
| `GET\|PUT /api/sdk/privacy/consent` | Browser/server SDK token | Read / record consent |
| `GET\|PUT /api/projects/:id/privacy/consent` | Human JWT | Portal inspection / override |
| `PUT /api/projects/:id/privacy/consent-defaults` | Project devops | Default when no row exists |

Helpers: `isReplayAllowed`, `resolveConsent`, `upsertConsent` in
`platform/api/src/lib/privacy-consent.ts`. Replay upload must use object keys under
`replays/{projectId}/user/{userId}/` or `replays/{projectId}/session/{sessionId}/`
so GDPR delete can remove them.

Default consent: **replay off**, analytics on.

## Retention: what actually applies

| Type | Default | Per-project override | Enforced by |
|------|---------|----------------------|-------------|
| errors | 90 days | yes | API leader job `error-retention` (hourly) on Postgres `error_events` |
| logs | `TELEMETRY_RETENTION_DAYS` (30) | yes | Loki compactor; the API writes the override into Loki's runtime overrides (full profile) |
| replays | 7 days | stored | MinIO lifecycle rule on `replays/` (7 days); per-project values are for the replay store (#40) |
| traces | `TELEMETRY_RETENTION_DAYS` (30) | **no** | Tempo compactor, cluster-wide |
| profiles | `TELEMETRY_RETENTION_DAYS` (30) | **no** | Pyroscope, cluster-wide |

`PUT /api/projects/:id/privacy/retention` takes integers 1..365 for `logs`, `replays` and
`errors`; `null` clears an override (back to the default); omitted keys are unchanged. Tempo and
Pyroscope run single-tenant, so a per-project period cannot be enforced: `traces` / `profiles`
values are rejected with `400` (send `null` or omit them) and older stored values are ignored.
`GET /api/projects/:id/privacy` returns the effective `retentionDays`, the stored
`retentionOverrides` and `retentionScope` (`project` / `cluster`). The API learns the cluster
period from `TELEMETRY_RETENTION_DAYS` (set by platformctl on the API Deployment).

**Errors**: every hour the leader deletes `error_events` older than the project's errors retention
in bounded batches (`ERROR_RETENTION_BATCH`, default 5000 rows, at most
`ERROR_RETENTION_MAX_BATCHES`, default 20, per project per run; a backlog is cleared over the next
runs). Issues that have no events left and were last seen before the cutoff are deleted, so they
disappear from the issue list. Issues that still have events keep their lifetime `count`,
`first_seen` and per-release counts; the event samples are the retained ones. An error that returns
after its issue was removed opens a new issue ("New issue" alert, not "Regression").

**Logs**: Loki's global `retention_period` is `TELEMETRY_RETENTION_DAYS`. For each project with a
logs override the API keeps two `retention_stream` rules under the `fake` tenant in the
`loki-runtime` ConfigMap (`monitoring` namespace): `{platform_project_id="<id>"}` (Alloy) and
`{project_id="<id>"}` (API-forwarded SDK logs), period = days × 24h. Loki re-reads the file within
seconds; the compactor deletes expired chunks (after its delete delay). The leader re-applies the
rules every 10 minutes (`LOKI_RETENTION_RECONCILE_MS`) because a `helm upgrade` of Loki resets the
ConfigMap, and immediately after a project's logs setting changes. Other keys in the runtime config
are kept. RBAC: `get`/`update` on that one ConfigMap (Role `platform-alerting`, full profile only).
Set `LOKI_RETENTION_OVERRIDES=disabled` to stop managing it. Without the full profile there is no
Loki and only the stored value changes. Earlier versions shipped static `retention_stream` rules on a
`telemetry_type` label; Alloy streams do not carry it and errors / replays are not stored in Loki,
so those rules were removed.

## GDPR delete

`POST /api/projects/:projectId/privacy/gdpr-delete` (project **owner**):

1. Mongo `logs` / `errors` matching `userId` / `sessionId` (fields or message)
2. `telemetry_consents` rows + Redis consent cache
3. MinIO objects under the replay prefixes (when `REPLAYS_*` / MinIO env is set)
4. Loki delete requests for `{project_id="…"} |= "userId|sessionId"`
5. Audit `privacy.gdpr_delete` with counts, warnings and optional `emailHash`

## Profiles / install weight

Heavy collector processors and the `replays` MinIO bucket are created only with the
**full** profile (`PLATFORM_OBSERVABILITY=enabled`). Standard/minimal installs keep
API scrubbing + privacy settings without Alloy.
