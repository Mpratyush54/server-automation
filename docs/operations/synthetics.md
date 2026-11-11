# Synthetic monitoring

Projects define checks that probe their own endpoints from the cluster on a schedule.
Results, alerts and a status feed come from the platform API; the portal page is
**Project → Synthetics** (`/projects/<id>/synthetics`).

| Type | Runs where | Profiles | Notes |
|------|-----------|----------|-------|
| `http` | API runner (leader replica) | all | Method, headers, body, assertions, redirects (≤ 5) |
| `multistep` | API runner | all | Up to 10 requests; variables extracted from one step feed the next |
| `ssl` | API runner | all | Warns `warnDays` (default 14) before expiry; fails when expired/untrusted |
| `browser` | CronJob in `synthetics` namespace | full + `SYNTHETICS_BROWSER=true` | Headless Chromium, declared steps only, screenshot on failure |

On the full profile, simple HTTP checks (GET/HEAD, no headers or secrets) and SSL checks are
also mirrored as blackbox-exporter `Probe` resources (`synthetic_http` / `synthetic_tls`
modules), so Prometheus has `probe_success`, `probe_duration_seconds` and
`probe_ssl_earliest_cert_expiry` with `project_id` / `check_id` labels.

**Location:** one location, the server itself (`locations: ["local"]`). Probing from other
regions is not supported yet; a cluster-wide network outage is not visible to these checks.

## Check definition

```json
{
  "name": "Login flow",
  "type": "multistep",
  "intervalSeconds": 300,
  "timeoutMs": 30000,
  "config": {
    "steps": [
      { "name": "Login", "method": "POST", "url": "https://app.example.com/api/login",
        "headers": { "Content-Type": "application/json" },
        "body": "{\"user\":\"{{secret.USER}}\",\"password\":\"{{secret.PASSWORD}}\"}",
        "assertions": [{ "source": "status", "comparison": "eq", "target": 200 }],
        "extract": [{ "name": "token", "source": "json", "property": "$.token" }] },
      { "name": "Profile", "url": "https://app.example.com/api/me",
        "headers": { "Authorization": "Bearer {{token}}" },
        "assertions": [{ "source": "json", "property": "$.email", "comparison": "exists" }] }
    ],
    "statusPage": { "visible": true, "name": "Sign-in" }
  },
  "alertPolicy": { "enabled": true, "failureThreshold": 2, "severity": "critical" },
  "secrets": { "USER": "probe@example.com", "PASSWORD": "..." }
}
```

- **Assertions** — `source`: `status`, `latency` (ms), `header` (property = name), `body`,
  `json` (property = `$.a.b[0]`), `ssl_days`; `comparison`: `eq`, `neq`, `lt`, `lte`, `gt`,
  `gte`, `contains`, `not_contains`, `matches` (regex ≤ 200 chars, no nested quantifiers or
  back-references, first 64 KiB of the body), `exists`, `not_exists`. Without assertions a
  check passes on any status below 400.
- **Variables** — `extract` (`json`, `header`, `body_regex` with one capture group, `status`)
  and `config.variables`; referenced as `{{name}}`. The host of a step URL cannot contain
  variables.
- **Secrets** — `{{secret.NAME}}`; stored encrypted with `SECRETS_ENCRYPTION_KEY`, never
  returned (responses list `secretNames` only), redacted from stored errors. Update with
  `"secrets": { "NAME": "new" }`, delete with `null`, omit to keep.
- **Limits** — interval ≥ 60 s (http, multistep), ≥ 300 s (ssl, browser; browser intervals
  5/10/15/20/30 min or 1/2/3/6/12/24 h), timeouts ≤ 30 s (http/ssl), 60 s (multistep),
  120 s (browser), 50 checks per project (`SYNTHETICS_MAX_CHECKS_PER_PROJECT`).

## Target safety (SSRF)

Every request — and every redirect hop — is resolved first and **all** answers are checked;
the connection then goes to the validated address (no second DNS lookup, so DNS rebinding
cannot redirect it). Refused: loopback, link-local / cloud metadata, private (RFC 1918),
CGNAT, IPv6 ULA, multicast/reserved ranges, IPv4-mapped/NAT64 forms of those,
`*.svc` / `*.cluster.local` / `localhost` / single-label names, URLs with credentials and
non-HTTP(S) schemes. A project's **own ingress hosts** (its environments' domains) may
resolve to a private address, on ports 80/443 only. Responses are capped at 1 MiB, redirects
at 5; check-defined headers are dropped when a redirect leaves the original origin; the
platform never adds its own cookies or credentials.

Browser runners and blackbox-exporter are additionally confined by egress NetworkPolicies
(public addresses only; runners may also reach the platform API).

## Results, metrics and retention

- History: `GET /api/projects/<id>/synthetics/checks/<checkId>/results`, kept
  `SYNTHETICS_RETENTION_DAYS` (default 30; screenshots are deleted with their result).
- Prometheus (`GET /api/metrics/jobs`): `platform_synthetic_runs_total{type,result}` (every
  replica) and, from the leader only, `platform_synthetic_check_up`,
  `platform_synthetic_check_latency_seconds`, `platform_synthetic_check_consecutive_failures`,
  `platform_synthetic_check_last_run_timestamp_seconds`,
  `platform_synthetic_check_ssl_expiry_timestamp_seconds`.
- Scheduler: leader job `synthetics-runner` every `SYNTHETICS_TICK_MS` (5 s), up to
  `SYNTHETICS_CONCURRENCY` (4) checks at once; `SYNTHETICS=off` disables it.

## Alerts

`synthetics` alert events (see `platform/api/src/lib/alert-events.ts`), `dedupeKey`
`synthetic:<checkId>`:

- `firing` (policy severity) after `failureThreshold` consecutive failed runs (default 2);
- `firing` with severity `warning` when an SSL certificate is inside its warning window;
- `resolved` on the next passing run, or when the check is disabled or deleted.

Routing, silences and channels are handled by the alerting service.

## Status feed (status pages)

`GET /api/projects/<id>/synthetics/status-feed` returns aggregates only — component name
(`statusPage.name` or the check name), type, current status, uptime for 24 h / 7 d / 30 d and
30 daily bars. No URLs, hosts, errors or assertion details. Checks with
`statusPage.visible: false` are omitted.

This feed powers the public [status pages](../guides/status-pages.md) (`/status/<slug>`).

## Browser checks (full profile)

Enable with `SYNTHETICS_BROWSER=true` and `--profile full`, then re-run provision. The
`synthetics` step writes the `synthetics-runner` ConfigMap the API reads (within 60 s).

Budget:

- image `platform-synthetics-runner` (~1.5 GiB, Playwright base image), pulled on first run;
- per run: requests 250m CPU / 512 MiB, limits 1 CPU / 1 GiB, 1 GiB ephemeral storage;
- at most 2 browser pods at once (`ResourceQuota` in `synthetics`), `concurrencyPolicy:
  Forbid` per check, minimum interval 5 minutes.

Steps are declarative (`goto`, `click`, `fill`, `press`, `wait_for`, `assert_text`,
`assert_title`, `assert_url`, `wait`); no custom scripts run. Each CronJob uses a per-check run
token (Secret in `synthetics`) to fetch its definition and post the result; on failure a PNG
screenshot is stored in the uploads bucket (`synthetics/<project>/<check>/…`) and shown in the
portal.

## Verify on a VM

```bash
sudo PLATFORM_PROFILE=full SYNTHETICS_BROWSER=true platformctl provision
kubectl get ns synthetics; kubectl -n synthetics get resourcequota,networkpolicy,configmap
# create an HTTP check against the example app in the portal, then:
kubectl -n monitoring get probes -l platform.io/synthetic-check
# stop the app; after 2 failed runs the check shows "firing" and an alert event is published
```
