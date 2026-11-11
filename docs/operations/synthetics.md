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
  `"secrets": { "NAME": "new" }`, delete with `null`, omit to keep. In browser checks they
  are substituted in `goto` URLs, `fill` values and the expected values of `assert_text`,
  `assert_title` and `assert_url`; failure messages show the template, not the value.
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
resolve to a private address, on ports 80/443 only. The **platform's own domain** (`DOMAIN`)
and every name under it (`api.DOMAIN`, `grafana.DOMAIN`, ...) are allowed targets too, but
they are never resolved on their own: the connection always goes to the ingress controller
Service address (see "Platform hosts" below), on ports 80/443 only. Responses are capped at
1 MiB, redirects
at 5; check-defined headers are dropped when a redirect leaves the original origin; the
platform never adds its own cookies or credentials.

Browser runners and blackbox-exporter are additionally confined by egress NetworkPolicies
(public addresses only). Browser runners may also reach cluster DNS, the platform API's
**runner-only port** (3001, Service `platform-api-synthetics`: only the two runner endpoints
are served there, never the rest of the API) and the ingress controller (80/443, for the
project's own env hosts and the platform's own domain, see below).

Inside the browser runner every navigation hop is validated, not just the first request:

- Chromium's host resolver maps the project's env hosts, the platform's own domain and its
  subdomains to the ingress controller, and refuses cluster-internal names (`*.svc`,
  `*.cluster.local`, `localhost`, …) and literal private addresses, for every connection
  including redirects;
- requests the page starts are checked (scheme, host, resolved addresses) before they are
  sent and aborted when disallowed;
- redirect hops are re-checked as they happen and after every step (redirect chain and the
  page URL); a disallowed hop fails the run with "navigation to a disallowed target was
  blocked (…)", and no screenshot of that page is stored.

## Results, metrics and retention

- History: `GET /api/projects/<id>/synthetics/checks/<checkId>/results`, kept
  `SYNTHETICS_RETENTION_DAYS` (default 30). Expired rows with a screenshot are deleted in
  batches, each only after its screenshot object is deleted; a row whose object cannot be
  deleted is kept and retried by the next hourly run.
- Prometheus (`GET /api/metrics/jobs`): `platform_synthetic_runs_total{type,result}` (every
  replica) and, from the leader only, `platform_synthetic_check_up`,
  `platform_synthetic_check_latency_seconds`, `platform_synthetic_check_consecutive_failures`,
  `platform_synthetic_check_last_run_timestamp_seconds`,
  `platform_synthetic_check_ssl_expiry_timestamp_seconds`.
- Scheduler: leader job `synthetics-runner` every `SYNTHETICS_TICK_MS` (5 s), up to
  `SYNTHETICS_CONCURRENCY` (4) checks at once; `SYNTHETICS=off` disables it.
- `nextRunAt` in the API: for browser checks, the next time of the check's CronJob
  schedule (UTC); `null` while disabled.

## Alerts

`synthetics` alert events (see `platform/api/src/lib/alert-events.ts`), `dedupeKey`
`synthetic:<checkId>`:

- `firing` (policy severity) after `failureThreshold` consecutive failed runs (default 2);
  for browser checks a missing report counts as a failed run (see below);
- `firing` with severity `warning` when an SSL certificate is inside its warning window;
- `resolved` on the next passing run, or when the check is disabled or deleted.

Routing, silences and channels are handled by the alerting service.

## Status feed (status pages)

`GET /api/projects/<id>/synthetics/status-feed` returns aggregates only — component name
(`statusPage.name` or the check name), type, current status, uptime for 24 h / 7 d / 30 d and
30 daily bars. No URLs, hosts, errors or assertion details. Checks with
`statusPage.visible: false` are omitted.

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
token (Secret in `synthetics`) to fetch its definition and post the result to the API's
runner-only port; on failure a PNG screenshot is stored in the uploads bucket
(`synthetics/<project>/<check>/…`) and shown in the portal. CronJobs run in `Etc/UTC`.

The built-in **Browser: page loads** template (`browser-smoke`) is target-agnostic: it opens
your URL (it ships without one; saving requires it, see `requiredFields`), fails on HTTP
≥ 400 and waits for the page body. Add `assert_title` / `assert_text` steps for your page.

### Runs that never report

A run that never reaches the API (image pull failure, OOM kill, job deadline, quota) would
otherwise leave no result. The leader job `synthetics-browser-staleness` (every minute)
records a **failed** result for an enabled browser check that has no result for
`max(2 × interval, interval + job deadline)` — job deadline = timeout + 90 s — measured from
its last result or its last change (create, edit, re-enable):

```
Runner did not report a result within 30 minutes (runner pod: ImagePullBackOff)
```

The reason in parentheses comes from the latest runner Job / pod when it still exists
(read-only access to `jobs` and `pods` in `synthetics`). These results count toward
`consecutiveFailures` and fire the alert like any other failure; the next window starts at
the recorded result.

### Reaching the project's own environment hosts

A browser check may open its project's environment hosts (the same ingress exception as HTTP
checks) — and only those:

- the runner maps exactly those host names to the ingress controller Service
  (`ingress-nginx-controller.ingress-nginx`) with Chromium `--host-resolver-rules`;
- the runner NetworkPolicy allows the ingress controller pods on 80/443;
- when env hosts use the platform's internal CA (Let's Encrypt fallback), the runner trusts
  that CA in the run's own browser profile (NSS, TLS server certificates only). platformctl
  copies the CA **certificate** (never its key) from `cert-manager/platform-ca` to the
  ConfigMap `synthetics/platform-ca`, mounted read-only and optional. Re-run
  `platformctl provision` (or the `synthetics` step) after the CA changes.

HTTP checks to env hosts run in the API and resolve them through the cluster's CoreDNS
rewrite; they verify TLS against the public roots (use `tlsInsecure` for internal-CA hosts).

### Platform hosts (`DOMAIN` and `*.DOMAIN`)

The platform's own endpoints (`DOMAIN`, `api.DOMAIN`, the portal, Grafana, any other
`*.DOMAIN` host that is not one of the project's env hosts) are public endpoints served by
the ingress controller, and checks may target them. They are reached **only through the
ingress controller**, exactly like env hosts:

- HTTP, multi-step and SSL checks (run by the API) never resolve the host name itself: the
  connection goes to the address of the Service
  `ingress-nginx-controller.ingress-nginx.svc.cluster.local`, with the original host name
  as `Host` / SNI. Only ports 80 and 443 are accepted. If that address cannot be resolved
  the run fails (it does not fall back to the host's own DNS answer);
- browser checks map `DOMAIN` and `*.DOMAIN` to the ingress controller with
  `--host-resolver-rules` (and refuse them when the ingress address is unknown);
- every other private or cluster address stays refused: IP literals (`10.x`, `169.254.x`,
  ...), `*.svc` / `*.cluster.local` names, other names resolving to private addresses, and
  redirects to any of them (each redirect hop is validated again);
- platform hosts are never mirrored as blackbox Probes (blackbox-exporter cannot reach the
  ingress controller).

**TLS.** Platform hosts may use a Let's Encrypt certificate (verified normally) or the
platform's internal CA. Browser runners trust the internal CA (see above). The API's own
HTTP/SSL checks trust it **for platform hosts only** when the ConfigMap
`synthetics/platform-ca` exists (full profile, written by platformctl; the API reads it
through a read-only Role, cached 5 minutes). Without it (default profile, or before
`platformctl provision` has published it) HTTP checks against internal-CA platform hosts
fail TLS verification: set `tlsInsecure: true` on the check, or use a publicly trusted
certificate. Env hosts on custom domains still verify against the public roots only.

## Verify on a VM

```bash
sudo PLATFORM_PROFILE=full SYNTHETICS_BROWSER=true platformctl provision
kubectl get ns synthetics; kubectl -n synthetics get resourcequota,networkpolicy,configmap
kubectl -n platform get svc platform-api-synthetics   # runner-only API port 3001
# create an HTTP check against the example app in the portal, then:
kubectl -n monitoring get probes -l platform.io/synthetic-check
# stop the app; after 2 failed runs the check shows "firing" and an alert event is published
```
