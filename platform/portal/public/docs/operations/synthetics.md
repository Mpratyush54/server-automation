# Check that your site is up

This page helps you test a URL or a user flow on a schedule and get alerted when it stops working. Open the project, choose **Monitoring**, then the **Uptime** view. The same view holds the project's public [status page](../guides/status-pages.md).

Checks run from your own server. They catch a broken app or an expiring certificate, but not a network outage between your users and the server.

## Add a check

1. Open **Monitoring**, view **Uptime**, and choose **New check**.
2. Pick a template, for example **HTTP uptime**, or fill in the form.
3. Enter a **Name**, for example `Shop home page`.
4. In **Definition (JSON)**, set the URL, for example:

   ```json
   { "url": "https://shop.example.com/", "method": "GET",
     "assertions": [{ "source": "status", "comparison": "eq", "target": 200 }] }
   ```

5. Keep **Raise alerts** on. **Consecutive failures before alerting** defaults to 2.
6. Choose **Save check**.

The check runs every 5 minutes by default (**Interval (seconds)**). Choose **Run now** to try it at once. The timeline shows the last runs; choose a bar to see that run.

You need the project role **developer** or higher to add or change checks.

## Check types

| Type | What it does | Shortest interval |
|------|--------------|-------------------|
| HTTP | Calls one URL and checks the answer | 1 minute |
| Multi-step | Up to 10 requests in a row, for example log in, then load the profile with the token from step 1 | 1 minute |
| SSL | Warns before a certificate expires (14 days by default) and fails when it has expired or is not trusted | 5 minutes |
| Browser | Opens the page in a real headless browser and follows your steps | 5 minutes |

Browser checks need the full install profile with browser checks turned on: `sudo SYNTHETICS_BROWSER=true platformctl provision --profile full`.

Templates: **HTTP uptime**, **JSON health endpoint**, **Multi-step: login then fetch profile**, **SSL certificate expiry** and **Browser: page loads**.

## Use secrets in a check

Put passwords and tokens under **Secrets**, not in the definition. Refer to them as `{{secret.NAME}}`. Secret values are stored encrypted and never shown again; error messages show the placeholder, not the value.

## Alerts

After the set number of failed runs in a row, the check raises an alert at the severity you chose. An SSL certificate inside its warning window raises a `warning`. The alert resolves on the next passing run, or when you disable or delete the check. Where alerts go is set in [Get alerts when something breaks](alerting.md).

## Check definition

A full example (multi-step, with a secret and status page name):

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

- **Assertions**: `source` is `status`, `latency` (ms), `header` (property = header name), `body`, `json` (property = `$.a.b[0]`) or `ssl_days`. `comparison` is `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `contains`, `not_contains`, `matches`, `exists` or `not_exists`. `matches` takes a regex of up to 200 characters, without nested quantifiers or back-references, and reads the first 64 KiB of the body. Without assertions a check passes on any status below 400.
- **Variables**: `extract` (`json`, `header`, `body_regex` with one capture group, `status`) and `config.variables`, used as `{{name}}`. The host of a step URL cannot contain variables.
- **Secrets**: `{{secret.NAME}}`. Responses list `secretNames` only. Update with `"secrets": { "NAME": "new" }`, delete with `null`, leave out to keep. In browser checks they are filled in in `goto` URLs, `fill` values and the expected values of `assert_text`, `assert_title` and `assert_url`.
- **Limits**: interval at least 60 s (HTTP, multi-step) or 300 s (SSL, browser). Browser intervals must be 5, 10, 15, 20 or 30 minutes, or 1, 2, 3, 6, 12 or 24 hours. Default interval 300 s, default timeout 10 s. Timeouts up to 30 s (HTTP, SSL), 60 s (multi-step) or 120 s (browser). Up to 50 checks per project (`SYNTHETICS_MAX_CHECKS_PER_PROJECT`). HTTP checks follow up to 5 redirects.
- **Browser steps** are declarative: `goto`, `click`, `fill`, `press`, `wait_for`, `assert_text`, `assert_title`, `assert_url`, `wait`. No custom scripts run. The **Browser: page loads** template (`browser-smoke`) opens your URL (you must add one), fails on HTTP 400 or higher and waits for the page body. Add `assert_title` or `assert_text` steps for your page.
- **Status page**: `config.statusPage.name` is the name shown on the public status page; `visible: false` hides the check there.

## How it works

### Where checks run

| Type | Runs in | Profiles |
|------|---------|----------|
| `http`, `multistep`, `ssl` | The API, on the leader replica | All |
| `browser` | A CronJob in the `synthetics` namespace (headless Chromium, screenshot on failure) | Full, with `SYNTHETICS_BROWSER=true` |

There is one location, the server itself (`locations: ["local"]`).

The scheduler is the leader job `synthetics-runner`. It looks for due checks every `SYNTHETICS_TICK_MS` (default 5 s) and runs up to `SYNTHETICS_CONCURRENCY` (default 4) at once. `SYNTHETICS=off` turns it off. For browser checks, `nextRunAt` is the next time of the check's CronJob schedule (UTC), or `null` while disabled.

On the full profile, simple HTTP checks (GET or HEAD, no headers or secrets) and SSL checks are also mirrored as blackbox-exporter `Probe` resources (`synthetic_http` and `synthetic_tls` modules). Prometheus then has `probe_success`, `probe_duration_seconds` and `probe_ssl_earliest_cert_expiry` with `project_id` and `check_id` labels.

### Results and retention

Results are kept for `SYNTHETICS_RETENTION_DAYS` (default 30). Expired rows with a screenshot are deleted in batches, each only after its screenshot object is deleted; a row whose object cannot be deleted is kept and retried by the next hourly run.

The API's Prometheus-format endpoint `GET /api/metrics/jobs` (DevOps role) includes `platform_synthetic_runs_total{type,result}` from every replica and, from the leader only, `platform_synthetic_check_up`, `platform_synthetic_check_latency_seconds`, `platform_synthetic_check_consecutive_failures`, `platform_synthetic_check_last_run_timestamp_seconds` and `platform_synthetic_check_ssl_expiry_timestamp_seconds`.

### Alert events

Checks publish `synthetics` alert events with `dedupeKey` `synthetic:<checkId>`:

- `firing` (policy severity) after `failureThreshold` consecutive failed runs (default 2). For browser checks a missing report counts as a failed run (see below).
- `firing` with severity `warning` when an SSL certificate is inside its warning window (`warnDays`, default 14).
- `resolved` on the next passing run, or when the check is disabled or deleted.

### Status feed (status pages)

`GET /api/projects/<id>/synthetics/status-feed` returns aggregates only: component name (`statusPage.name` or the check name), type, current status, uptime for 24 hours, 7 days and 30 days, and 30 daily bars. No URLs, hosts, errors or assertion details. Checks with `statusPage.visible: false` are left out. This feed powers the public [status pages](../guides/status-pages.md) (`/status/<slug>`).

### Target safety

Checks cannot be used to reach internal services. Every request, and every redirect hop, is resolved first and **all** answers are checked; the connection then goes to the checked address (no second DNS lookup, so DNS rebinding cannot redirect it). Refused: loopback, link-local and cloud metadata, private (RFC 1918), CGNAT, IPv6 ULA, multicast and reserved ranges, IPv4-mapped and NAT64 forms of those, `*.svc`, `*.cluster.local`, `localhost` and single-label names, URLs with credentials, and non-HTTP(S) schemes.

Exceptions:

- A project's **own environment hosts** may resolve to a private address, on ports 80 and 443 only.
- **Cairn's own domain** (`DOMAIN`) and every name under it (`api.DOMAIN`, `grafana.DOMAIN`, ...) are allowed, but never resolved on their own: the connection always goes to the ingress controller Service, on ports 80 and 443 only (see "Cairn hosts" below).

Responses are capped at 1 MiB and redirects at 5. Check-defined headers are dropped when a redirect leaves the original origin. Cairn never adds its own cookies or credentials.

Browser runners and blackbox-exporter are also limited by egress NetworkPolicies (public addresses only). Browser runners may also reach cluster DNS, the API's **runner-only port** (3001, Service `platform-api-synthetics`, which serves only the two runner endpoints) and the ingress controller (80 and 443).

Inside the browser runner every navigation hop is checked, not just the first request:

- Chromium's host resolver maps the project's environment hosts, Cairn's domain and its subdomains to the ingress controller, and refuses cluster-internal names and literal private addresses, for every connection including redirects.
- Requests the page starts are checked (scheme, host, resolved addresses) before they are sent, and aborted when not allowed.
- Redirect hops are re-checked as they happen and after every step. A blocked hop fails the run with "navigation to a disallowed target was blocked (…)", and no screenshot of that page is stored.

### Browser checks

Turn them on with `SYNTHETICS_BROWSER=true` and `--profile full`, then re-run provision. The `synthetics` step writes the `synthetics-runner` ConfigMap, which the API reads within 60 s.

Resources:

- Image `platform-synthetics-runner` (about 1.5 GiB, Playwright base image), pulled on the first run.
- Per run: requests 250m CPU and 512 MiB, limits 1 CPU and 1 GiB, 1 GiB ephemeral storage.
- At most 2 browser pods at once (`ResourceQuota` in `synthetics`), `concurrencyPolicy: Forbid` per check, interval at least 5 minutes.

Each CronJob uses a per-check run token (a Secret in `synthetics`) to fetch its definition and post the result to the runner-only port. On failure a PNG screenshot is stored in the uploads bucket (`synthetics/<project>/<check>/…`) and shown in the portal. CronJobs run in `Etc/UTC`.

#### Runs that never report

A run that never reaches the API (image pull failure, out-of-memory kill, job deadline, quota) would otherwise leave no result. The leader job `synthetics-browser-staleness` (every minute) records a **failed** result for an enabled browser check with no result for `max(2 × interval, interval + job deadline)`, where the job deadline is the timeout plus 90 s. It is measured from the last result or the last change (create, edit, re-enable):

```
Runner did not report a result within 30 minutes (runner pod: ImagePullBackOff)
```

The reason in brackets comes from the latest runner Job or pod when it still exists (read-only access to `jobs` and `pods` in `synthetics`). These results count toward `consecutiveFailures` and fire the alert like any other failure.

#### Reaching the project's own environment hosts

A browser check may open its project's environment hosts, and only those:

- The runner maps exactly those host names to the ingress controller Service (`ingress-nginx-controller.ingress-nginx`) with Chromium `--host-resolver-rules`.
- The runner NetworkPolicy allows the ingress controller pods on 80 and 443.
- When environment hosts use Cairn's internal CA (the Let's Encrypt fallback), the runner trusts that CA in the run's own browser profile (TLS server certificates only). platformctl copies the CA **certificate** (never its key) from `cert-manager/platform-ca` to the ConfigMap `synthetics/platform-ca`, mounted read-only and optional. Re-run `platformctl provision` (or the `synthetics` step) after the CA changes.

HTTP checks to environment hosts run in the API and resolve them through the cluster's CoreDNS rewrite. They verify TLS against the public roots; use `tlsInsecure` for internal-CA hosts.

#### Cairn hosts (`DOMAIN` and `*.DOMAIN`)

Cairn's own endpoints (`DOMAIN`, `api.DOMAIN`, the portal, Grafana, and any other `*.DOMAIN` host that is not one of the project's environment hosts) are reached **only through the ingress controller**:

- HTTP, multi-step and SSL checks never resolve the host name itself. The connection goes to the address of `ingress-nginx-controller.ingress-nginx.svc.cluster.local`, with the original host name as `Host` and SNI. Only ports 80 and 443 are accepted. If that address cannot be resolved, the run fails.
- Browser checks map `DOMAIN` and `*.DOMAIN` to the ingress controller with `--host-resolver-rules`, and refuse them when the ingress address is unknown.
- Every other private or cluster address stays refused: IP literals (`10.x`, `169.254.x`, ...), `*.svc` and `*.cluster.local` names, other names that resolve to private addresses, and redirects to any of them.
- Cairn hosts are never mirrored as blackbox Probes (blackbox-exporter cannot reach the ingress controller).

**TLS**: Cairn hosts may use a Let's Encrypt certificate (verified normally) or Cairn's internal CA. Browser runners trust the internal CA (see above). The API's own HTTP and SSL checks trust it **for Cairn hosts only** when the ConfigMap `synthetics/platform-ca` exists (full profile, written by platformctl; the API reads it through a read-only Role and caches it for 5 minutes). Without it, HTTP checks against internal-CA Cairn hosts fail TLS verification: set `tlsInsecure: true` on the check, or use a publicly trusted certificate. Environment hosts on custom domains still verify against the public roots only.

### Check it on a server

```bash
sudo PLATFORM_PROFILE=full SYNTHETICS_BROWSER=true platformctl provision
kubectl get ns synthetics; kubectl -n synthetics get resourcequota,networkpolicy,configmap
kubectl -n platform get svc platform-api-synthetics   # runner-only API port 3001
# create an HTTP check against the example app in the portal, then:
kubectl -n monitoring get probes -l platform.io/synthetic-check
# stop the app; after 2 failed runs the check shows "firing" and an alert event is published
```

## For developers / API

All paths need authentication. Reading needs project role viewer or higher; creating, changing, deleting and running checks needs developer or higher.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/synthetics/capabilities` | Whether browser checks are available, and limits |
| `GET` | `/api/synthetics/templates` | Built-in templates |
| `GET`, `POST` | `/api/projects/<id>/synthetics/checks` | List or create checks (body as in [Check definition](#check-definition)) |
| `GET`, `PUT`, `DELETE` | `/api/projects/<id>/synthetics/checks/<checkId>` | Read, update or delete a check |
| `POST` | `/api/projects/<id>/synthetics/checks/<checkId>/run` | Run now (not for browser checks) |
| `GET` | `/api/projects/<id>/synthetics/checks/<checkId>/results` | Run history |
| `GET` | `/api/projects/<id>/synthetics/results/<resultId>/screenshot` | Failure screenshot of a browser run |
| `GET` | `/api/projects/<id>/synthetics/status-feed` | Status page aggregates |

Creating a browser check without browser support returns 409 `Browser checks need the full profile with SYNTHETICS_BROWSER=true`.
