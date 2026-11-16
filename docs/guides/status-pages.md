# Publish a public status page

A status page tells your users whether your app is up, without them signing in. Set it up in the project's **Monitoring** section, **Uptime** view, under **Status page**.

The page shows your [uptime checks](../operations/synthetics.md) as components, plus the incidents and maintenance notices you write. Each project has one status page.

## Publish a page

You need at least one uptime check first. Create one in the same **Uptime** view.

1. Open the project, go to **Monitoring**, then **Uptime**.
2. Scroll to **Status page**. Set a **Slug**, for example `acme`. The page will live at `https://<your-portal-host>/status/acme`.
3. Optionally set a **Title**, a **Logo URL** (must start with `https://`) and two brand colours.
4. Under **Components**, keep **Show all visible checks** on, or turn it off and tick the checks to show.
5. Turn on **Published** and click **Save changes**.
6. Click **Open public page** to see what visitors see.

Until you save, nothing is stored. The editor shows defaults: a slug from the project name, the title `<project> Status`, unpublished, and all visible checks.

## Post an incident

Use an incident to explain an outage, for example "Sign-in errors".

1. Under **Incidents and maintenance**, find **New incident**.
2. Enter a **Title**, pick an **Impact** (`none`, `minor`, `major` or `critical`), optionally write a first update, and click **Create incident**.
3. As you learn more, pick a **Status** on the incident (investigating, identified, monitoring or resolved), write the **Update text** and click **Post update**.
4. Click **Resolve** when it is fixed. The incident moves to *Past incidents*.

Incidents do not change the colours on the page. Those come only from check results.

## Announce maintenance

Tick **Maintenance window** when you create an incident. Set **Starts** and **Ends** in your local time. The end must be after the start.

- Before it starts, it is shown under *Scheduled maintenance*.
- During the window, it is shown as active.
- After the end, it is shown as *Completed*, even if nobody resolved it.

## What visitors see

- **Overall status**: operational, degraded, partial outage, major outage or unknown. It comes from the components on the page. All down means major outage. Some down means partial outage. Any degraded means degraded.
- **Components**: one per check, with its name, type, current status, last check time, uptime for 24 hours, 7 days and 30 days, average response time over 24 hours, and 30 daily bars.
- **Incidents**: title, status, impact, timeline of updates, and maintenance times. They are split into *Active incidents*, *Scheduled maintenance* and *Past incidents*.
- Links to Atom and RSS feeds in the footer.

Visitors never see check URLs, hosts, request headers or bodies, error messages, assertion details, secret names, or who wrote an update.

The open page refreshes every 20 seconds. A failing check appears after its next run, plus up to about 30 seconds of caching.

## Settings

| Setting | Rules |
|---|---|
| Published | Off by default. While off, the page and feeds return "This status page is not published." |
| Slug | 3–63 characters: lowercase letters, digits and hyphens. Must start and end with a letter or digit. Must be unique on the platform. Changing it moves the page. |
| Title | 1–120 characters |
| Custom domain | Optional hostname such as `status.example.com`. Must be unique. Saved for later only: it is not served today. The page is always at `/status/<slug>` on the portal host. |
| Logo URL | Starts with `https://`, up to 500 characters |
| Primary colour | `#RGB` or `#RRGGBB`. Used only for the band at the top. Default `#0f172a`. |
| Accent colour | `#RGB` or `#RRGGBB`. Used for operational dots, bars and the "all operational" banner. Default `#16a34a`. |

Clear a field to go back to the default. Brand colours are never used for text. The page follows the visitor's light or dark system setting.

### Name or hide a check

Each check can set how it appears on every status page, in its own definition (see [Check definition](../operations/synthetics.md#check-definition)):

- `"statusPage": { "name": "Sign-in" }` shows a different name (up to 100 characters).
- `"statusPage": { "visible": false }` hides it. In the editor it is marked *hidden by check* and stays hidden even when ticked.

## Who can do what

| Action | Who |
|---|---|
| View settings and incidents | Project viewer or higher |
| Change settings and incidents | Project devops or owner, signed in as a person. AI agent tokens are refused. |
| View the public page and feeds | Anyone, once published |

Cairn admins and global DevOps users can manage every project.

## Get alerted from incidents

When the page is published, a new incident sends an alert if all of these are true: it is not maintenance, its impact is `major` or `critical`, and it was not created already resolved. Critical maps to a critical alert, major to a warning. A matching "resolved" alert is sent when that incident is resolved, or deleted while open.

Route these alerts like any other source. See [alerting](../operations/alerting.md).

## How it works

- Components are built from the uptime checks' [status feed](../operations/synthetics.md#status-feed-status-pages).

  | Component field | Source |
  |---|---|
  | Name | `config.statusPage.name` on the check, otherwise the check name |
  | Current status | Last result: up is `operational`, degraded is `degraded`, down is `outage`. Disabled or never run is `unknown`. |
  | Uptime 24 h / 7 d / 30 d | Share of runs that did not fail in each window (`null` with no runs) |
  | Daily bar | 99.9% or more is operational, 95% or more is degraded, lower is outage, no runs is unknown |

- Each incident has a computed `phase`: `upcoming` (maintenance not started), `active` (unresolved, or maintenance inside its window or with no window) or `resolved` (resolved, or maintenance past its end).
- Maintenance past its end without a resolution is reported publicly as `status: resolved` with `resolvedAt` set to the scheduled end. The stored status is not changed. The editor shows it as *completed (window ended)*, and you can still post updates or resolve it.
- In the feeds, maintenance entries are titled *Scheduled maintenance:*, *Maintenance in progress:* or *Maintenance completed:*, and the summary starts with the window in UTC.
- The editor lists the 100 most recent incidents. The public page and feeds include the 50 most recent.
- Alert events use the source `status-page`. Minor or maintenance incidents, and incidents created while the page was unpublished, never send alert events.
- Caching: responses send `Cache-Control: public, max-age=15, s-maxage=30`. The API caches each page for 15 seconds. Saving settings or changing an incident clears the cache at once. With the Redis state backend the cache is shared by all API replicas. Without it (`PLATFORM_STATE_STORE=memory`, single replica) it is an in-process cache of up to 500 pages.
- Rate limit: public endpoints allow `STATUS_PAGE_RATE_LIMIT_MAX` requests per client per minute (default `120`). Over the limit they return 429 `Too many status page requests`.
- The JSON feed sends `X-Robots-Tag: noindex`.
- Audit log entries: `status_page.updated`, `status_page.incident.created`, `status_page.incident.updated`, `status_page.incident.resolved` and `status_page.incident.deleted`.

## For developers / API

Public endpoints need no authentication. `<slug>` is matched case-insensitively. An unpublished page returns 404.

| Path | Format |
|---|---|
| `/status/<slug>` | HTML page (portal) |
| `GET /api/public/status/<slug>` | JSON: `slug`, `title`, `branding`, `generatedAt`, `status`, `components[]`, `incidents[]` (each with `phase`) |
| `GET /api/public/status/<slug>/atom` | Atom 1.0 feed of incidents (latest update text as summary) |
| `GET /api/public/status/<slug>/rss` | RSS 2.0 feed of incidents |

Project endpoints: reads need project viewer (or an agent token with `projects:read`). Writes need project devops or owner in a human session.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/<id>/status-page` | Settings, or unsaved defaults (`id: null`) before the first save. Includes `publicPath`. Never writes. |
| `PUT` | `/api/projects/<id>/status-page` | Creates the page if needed, then partial update: `slug`, `title`, `domain`, `published`, `branding` {`logoUrl`, `primaryColor`, `accentColor`}, `componentIds` (check IDs, or `null` for all visible checks) |
| `GET` | `/api/projects/<id>/status-page/incidents` | List incidents (newest first, 100) with stored `status` and computed `phase` |
| `POST` | `/api/projects/<id>/status-page/incidents` | Create: `title`, `impact`, `status`, `isMaintenance`, `body`, `scheduledStart`, `scheduledEnd` (ISO timestamps) |
| `POST` | `/api/projects/<id>/status-page/incidents/<incidentId>/updates` | Append an update: `status`, `body` (both required) |
| `DELETE` | `/api/projects/<id>/status-page/incidents/<incidentId>` | Delete an incident |

Errors: 409 `slug already in use`, 409 `domain already in use by another status page`. Field limits: incident title 1–200 characters, update text up to 4000 characters. Status values: `investigating` (default), `identified`, `monitoring`, `resolved`, `scheduled` (default for maintenance). Scheduled times are ignored on ordinary incidents.

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
