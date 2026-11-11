# Telemetry privacy, retention and GDPR delete

Issue #47. Server-side scrubbing is authoritative; SDK client masking is defence-in-depth.
Session replay storage and the portal player ship in #40 — this document defines the
consent hooks, object-key contract and retention defaults that #40 must honour.

## Data inventory

| Store | What | Identifiers | Default retention | Delete path |
|-------|------|-------------|-------------------|-------------|
| Grafana Alloy → Loki | OTLP/Faro logs, pod logs | `project_id`, optional `user.id` / session in body | 30d (`TELEMETRY_RETENTION_DAYS`); stream `telemetry_type=errors` 90d, `replays` 7d | Loki delete API (`POST /loki/api/v1/delete`) |
| Tempo | Traces / span attributes | `platform.project_id` | 30d (global; single-tenant) | Compactor retention only |
| Pyroscope | Profiles | project labels when present | 30d | Compactor retention only |
| Prometheus | Metrics | project/env dimensions from Tempo generators | 30d | Prometheus retention |
| MongoDB `logs` | API-path SDK logs | `projectId`, optional `userId` / `sessionId` | TTL index 30d | GDPR delete + TTL |
| MongoDB `errors` | Aggregated error docs | `projectId`, optional `userId` / `sessionId` | Project setting default 90d | GDPR delete |
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

## Retention defaults

| Type | Days |
|------|------|
| logs | 30 |
| traces | 30 |
| profiles | 30 |
| replays | 7 |
| errors | 90 |

Cluster backends still use `TELEMETRY_RETENTION_DAYS` (default 30) for the global
period. Loki `retention_stream` shortens replays and lengthens errors when the
`telemetry_type` label is present. Project overrides are stored in
`telemetry_privacy_settings.retention_days` and shown in the portal; Tempo remains
global (no multitenancy). Per-project Tempo/Loki enforcement beyond stream labels
and GDPR delete is a follow-up for the observability views (#48).

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
