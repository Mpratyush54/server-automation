# Status pages

Each project can publish one public status page built from its
[synthetic checks](../operations/synthetics.md) plus incidents and maintenance notices
written by operators. The editor is **Project → Status page**
(`/projects/<id>/status`, also linked from the project page); the public page is
`/status/<slug>` on the portal host and needs no sign-in.

## What visitors see — and never see

The public page and its feeds are built only from the synthetics
[status feed](../operations/synthetics.md#status-feed-status-pages) and the published fields of
your incidents:

- **Overall status** — `operational`, `degraded`, `partial_outage`, `major_outage` or `unknown`,
  worked out from the components shown on this page (all shown components down → major outage;
  some down → partial outage; any degraded → degraded).
- **Components** — one per synthetic check: display name, check type, current status, last check
  time, uptime for 24 h / 7 d / 30 d, average latency over 24 h and 30 daily bars.
- **Incidents and maintenance** — title, lifecycle status, impact, maintenance flag, timeline
  of updates, scheduled start/end and resolved time. The page splits them into *Active
  incidents*, *Scheduled maintenance* (upcoming windows, with start and end) and *Past
  incidents* (resolved, or maintenance whose window has ended). See
  [Maintenance windows](#maintenance-windows).

Never published: check URLs, hosts, request headers or bodies, error messages, assertion
details, secret names, or who wrote an incident update. Responses also carry
`X-Robots-Tag: noindex` (JSON feed).

Incidents do not change the overall status or component colours — those come only from
check results. Post an incident to explain an outage the checks are showing.

## How checks become components

| Component field | Source |
|---|---|
| Name | `config.statusPage.name` on the check, otherwise the check name |
| Current status | Last result: up → `operational`, degraded → `degraded`, down → `outage`; disabled or never run → `unknown` |
| Uptime 24 h / 7 d / 30 d | Share of runs that did not fail in each window (`null` with no runs) |
| Daily bar | Per-day uptime: ≥ 99.9 % operational, ≥ 95 % degraded, lower is outage, no runs is unknown |

Hide a check from **every** status page with `"statusPage": { "visible": false }` in its config;
rename it with `"statusPage": { "name": "Sign-in" }` (≤ 100 characters). See
[Check definition](../operations/synthetics.md#check-definition).

A failing check shows up after its next run plus the public cache window (see
[Caching](#caching-and-rate-limits)); the open public page refreshes every 20 s.

## Set up and publish

Opening the editor does not create anything: until the first **Save** (or the first incident)
the editor shows defaults — slug from the project name, title `<project> Status`,
unpublished, all visible checks shown — and the API returns them with `id: null`.

1. Open **Project → Status page**.
2. Fill in the settings and click **Save**:

   | Setting | Rules |
   |---|---|
   | Published | Off by default. While off, the public page and feeds return 404 ("This status page is not published.") |
   | Slug | 3–63 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit. Unique across the platform (409 `slug already in use`). Changing it moves the page to the new path |
   | Title | 1–120 characters |
   | Custom domain | Optional hostname such as `status.example.com` (no scheme or path). Unique across status pages (409 `domain already in use by another status page`). Stored for a future dedicated hostname only — it is not served and not included in the public feed; today the page is served at `/status/<slug>` on the portal host |
   | Logo URL | Must start with `https://`, ≤ 500 characters |
   | Primary colour | `#RGB` or `#RRGGBB`; used only for the band across the top of the page (default `#0f172a`) |
   | Accent colour | `#RGB` or `#RRGGBB`; used for operational dots, bars and the "all operational" banner (default `#16a34a`) |

   Clear a field (empty value) to go back to the default. Brand colours are never used for
   text, so a dark primary colour stays readable. The page uses a light or dark theme
   following the visitor's system setting.
3. Under **Components**, keep **Show all visible checks** on, or turn it off and tick the checks
   to show. Checks hidden by their own config are marked *hidden by check* and stay hidden even
   when ticked.
4. Click **Open public page** (shown once the page is published).

## Incidents and maintenance

| Field | Values |
|---|---|
| Title | 1–200 characters |
| Impact | `none`, `minor` (default), `major`, `critical` |
| Status | `investigating` (default), `identified`, `monitoring`, `resolved`, `scheduled` (default for maintenance) |
| Maintenance | Flag; shown as *maintenance* on the page |
| Update text | ≤ 4000 characters per update |
| Scheduled start / end | Maintenance only (ignored on ordinary incidents). Portal: *Starts* / *Ends* inputs in your local time, shown when **Maintenance window** is ticked. API: ISO timestamps. End must be after start |

Lifecycle:

- **Create** — the portal form takes title, impact, the maintenance flag (with start and end)
  and an optional first update. Through the API you can also set `status`.
- **Update** — each open incident in the editor has a **Status** select (`investigating`,
  `identified`, `monitoring`, `resolved`), an **Update text** box and **Post update**, which
  appends a timeline entry. Moving a resolved incident back to another status re-opens it.
- **Resolve** — the **Resolve** button adds a `resolved` entry with the text "Resolved", sets
  the resolved time and moves the incident to *Past incidents*.
- **Delete** — removes the incident and its timeline from the page.

### Maintenance windows

Each incident in the API carries a computed `phase`:

| Phase | When |
|---|---|
| `upcoming` | Maintenance whose `scheduledStart` is in the future. Shown under *Scheduled maintenance* with its window, not as active |
| `active` | Unresolved incidents; maintenance between `scheduledStart` and `scheduledEnd` (or with no window) |
| `resolved` | Resolved incidents; maintenance past `scheduledEnd` that nobody resolved |

Maintenance past its end without a resolution is reported in the public JSON, HTML and
feeds as `status: resolved` with `resolvedAt` = `scheduledEnd` (*Completed* on the page).
The stored status is not changed: the editor shows it as *completed (window ended)* and you
can still post updates or resolve it. Phase changes reach the public page within the cache
window. In the Atom/RSS feeds maintenance entries are titled *Scheduled maintenance:*,
*Maintenance in progress:* or *Maintenance completed:* and the summary starts with the window
(UTC).

### Alerts

When the page is **published**, a new incident raises a `firing` alert event (source
`status-page`; `critical` → critical, `major` → warning) only if it is not maintenance, has
impact `major` or `critical`, and is not created already resolved. A `resolved` event is sent
later only for incidents that raised one — when they are resolved, or deleted while still
open. Minor or maintenance incidents, and incidents created while the page was unpublished,
never send alert events. Route these with [alerting](../operations/alerting.md) like any other
source.

The editor lists the 100 most recent incidents; the public page and feeds include the 50 most
recent.

## Public endpoints

No authentication. `<slug>` is matched case-insensitively.

| Path | Format |
|---|---|
| `/status/<slug>` | HTML page (portal) |
| `GET /api/public/status/<slug>` | JSON: `slug`, `title`, `branding`, `generatedAt`, `status`, `components[]`, `incidents[]` (each with `phase`) |
| `GET /api/public/status/<slug>/atom` | Atom 1.0 feed of incidents (latest update text as summary); `alternate` links point at `/status/<slug>` |
| `GET /api/public/status/<slug>/rss` | RSS 2.0 feed of incidents; channel and item `<link>` point at `/status/<slug>` |

The HTML page links the Atom and RSS feeds in its footer.

## Caching and rate limits

- Responses send `Cache-Control: public, max-age=15, s-maxage=30`.
- The API caches each page's payload for 15 s; saving settings or changing an incident clears
  it straight away. With the Redis state backend the cache is shared by all API replicas.
  Without Redis (`PLATFORM_STATE_STORE=memory`, single replica) it is an in-process cache of up
  to 500 pages.
- Public endpoints allow `STATUS_PAGE_RATE_LIMIT_MAX` requests per client per minute (default
  `120`); over the limit they return 429 `Too many status page requests`.

## Who can do what

| Action | Required |
|---|---|
| View settings and incidents in the portal/API | Project **viewer** or higher (or an agent token with `projects:read`) |
| Change settings, create/update/resolve/delete incidents | Project **devops** or **owner**, human session (agent tokens are refused) |
| View the public page and feeds | Anyone, once published |

Platform admins and global DevOps users can manage every project. Settings changes and
incident changes are written to the audit log: `status_page.updated`,
`status_page.incident.created`, `status_page.incident.updated`,
`status_page.incident.resolved` and `status_page.incident.deleted`.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/<id>/status-page` | Settings, or unsaved defaults (`id: null`) before the first save; includes `publicPath`. Never writes |
| `PUT` | `/api/projects/<id>/status-page` | Creates the page if needed, then partial update: `slug`, `title`, `domain`, `published`, `branding` {`logoUrl`, `primaryColor`, `accentColor`}, `componentIds` (array of check IDs, or `null` for all visible checks) |
| `GET` | `/api/projects/<id>/status-page/incidents` | List incidents (newest first, 100) with stored `status` and computed `phase` |
| `POST` | `/api/projects/<id>/status-page/incidents` | Create: `title`, `impact`, `status`, `isMaintenance`, `body`, `scheduledStart`, `scheduledEnd` |
| `POST` | `/api/projects/<id>/status-page/incidents/<incidentId>/updates` | Append an update: `status`, `body` (both required) |
| `DELETE` | `/api/projects/<id>/status-page/incidents/<incidentId>` | Delete an incident |

```bash
# Publish with a custom slug and show two checks
curl -X PUT "$API/api/projects/$PROJECT/status-page" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"acme","published":true,"componentIds":["<check-uuid-1>","<check-uuid-2>"]}'

# Post an incident, then an update
curl -X POST "$API/api/projects/$PROJECT/status-page/incidents" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Elevated sign-in errors","impact":"major","body":"We are investigating."}'
curl -X POST "$API/api/projects/$PROJECT/status-page/incidents/$INCIDENT/updates" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"monitoring","body":"Fix deployed; watching error rates."}'
```
