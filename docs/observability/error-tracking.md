# Error tracking

The API groups frontend and backend exceptions per project and environment. It
uses existing Postgres, the telemetry Redis Streams worker, and the private
MinIO uploads bucket. No additional workload or install step is required. Redis
queue mode runs in the existing leader worker; memory mode and Redis outages
process inline. The full profile supplies RUM/trace backends; explicit SDK error
capture also works on lighter profiles.

## Capture

Node: `await platform.captureException(error, { userId: 'opaque-id' })` after
initialization. Python: `platform.capture_exception(error, userId='opaque-id')`.
Neither installs process termination handlers. Configure the SDK application
version for release association. Use opaque user/session identifiers, avoid PII,
and redact exception messages/breadcrumbs at source.

React and Angular RUM mirror their already scrubbed Faro exceptions to the
`errorsEndpoint` supplied in the telemetry config. Set `API_PUBLIC_URL` to the
public API origin for custom collector setups without `DOMAIN`. Supply `appVersion` in RUM
options; the environment/project come from the signed browser ingest credential.
Existing sampling, DNT/consent behavior and `beforeSend` filters apply before
mirroring. RUM mirroring is best effort (bounded to 20 items per send), while the
collector transport retains its existing retry behavior. React ErrorBoundary
and Angular ErrorHandler already feed Faro when RUM is enabled.

For other integrations, `POST /api/sdk/errors` accepts a stored, project-bound
server or browser SDK bearer credential and the version 1 ErrorEvent JSON:

```json
{
  "eventId": "d67717f6-16ce-47db-b037-2d8d5cab9151",
  "type": "TypeError",
  "message": "Unable to read cart",
  "frames": [{"file": "/assets/app.js", "line": 1, "column": 120, "function": "checkout"}],
  "release": "1.2.0",
  "environment": "production",
  "traceId": "0123456789abcdef0123456789abcdef",
  "userId": "opaque-user",
  "sessionId": "opaque-session",
  "breadcrumbs": [{"category": "navigation", "message": "cart"}]
}
```

Frames are innermost first, lines one-based, columns zero-based. Optional
`replayId` reserves the link for #40. The server generates an event UUID if
omitted; integrations retrying a request should retain the original UUID.
`release` is optional and defaults to `unknown` (as the SDKs send when no app
version is configured); `type`, `message`, `environment` and each frame `file`
are required. A rejected event returns 400 naming the offending field.
Clients that only have the browser's `Error.stack` string may send it as
`stack` instead of `frames` (or with an empty `frames` array); the server parses
both V8 (`at fn (url:line:col)`) and SpiderMonkey/JavaScriptCore
(`fn@url:line:col`) lines into the same frames, up to 64 KiB.
At most 100 frames/breadcrumbs are accepted, with bounded string fields. Only
`{accepted:true}` is returned. `/api/errors/rum` accepts short-lived `web` ingest
tokens with origin checks; it derives project and environment from claims.

## Upload source maps in CI

Create an agent token with the single scope
`errors:sourcemaps:PROJECT_UUID`. It can upload maps only for that project;
`projects:read` does not grant upload. Protect the token as a CI secret. Humans
with project developer access can also upload using their session JWT.

```sh
export PLATFORM_API_URL=https://platform.example.test
export PLATFORM_CI_TOKEN="$CI_SOURCE_MAP_TOKEN"
npm run platform-sourcemaps -- upload "$PROJECT_UUID" "$APP_VERSION" dist /assets
```

Equivalent: `node scripts/platform-sourcemaps.mjs upload PROJECT_UUID RELEASE
DIST_DIR [PUBLIC_PATH]`. Run after bundling and before deploying. Each `.map`
becomes `POST /api/projects/:id/releases/:version/sourcemaps` with JSON
`{file:"/assets/app.js",map:{...}}`. Uploads require HTTPS except localhost and
refuse redirects. Flat source-map v3 only, maximum 5 MiB per map. Indexed/remote
maps are rejected; the API never fetches source URLs. The original deployment
must match the uploaded release and generated asset path exactly (URL origin,
query and fragment are ignored). Keep maps private; they may contain source code.

Objects are content-addressed in the existing uploads store, MinIO/S3 required
in production; local storage is development-only. The existing MinIO setup runs
after platform API startup; this feature does not create IAM users or buckets.
Runtime uses the lockfile-pinned `source-map` 0.6.1 copied from the Docker build
tree, preserving the immutable lockfile. A bounded 16-map process cache uses
immutable object keys, so replacing maps invalidates caches across replicas.
Maps uploaded after ingest also apply when opening an issue. Missing maps or
storage outages preserve raw frames.

## Triage

Open **Errors** in the sidebar, or `/projects/PROJECT_UUID/errors`. Filter by
release, environment or status. Select an issue for original/raw stacks, recent
events, breadcrumbs, first/last seen, counts per release, assignee and trace link.
Developer access is required to assign, resolve, ignore or reopen. Viewers can
read. The API is `PATCH /api/projects/:projectId/errors/:issueId` with `status`
(`open`, `resolved`, `ignored`) and/or `assigneeId` (a user with project access, or
`null`); it returns the updated issue, or `404` when the issue does not exist in
that project. The trace opens Grafana Explore using the Tempo datasource; replay links
target the future #40 replay route and will work when that feature is installed.

Grouping uses an engine- and build-neutral fingerprint (`v2:` prefix, #156) so
one bug in Chromium, Firefox and Safari, across deploys, lands in one issue:

- Frames from the platform SDKs and Faro, browser internals (`[native code]`,
  `<anonymous>`, extension URLs) and constructor `Error` frames are dropped.
- In-app frames are used; `node_modules`, vendor/framework/polyfill/runtime
  bundles only count when no in-app frame remains.
- Each frame contributes its normalized URL path with build content hashes
  stripped (`main.3f2a1b9c.js`, `main.3f2a1b9c.chunk.js`, `chunk-ABCD1234.js`,
  `index-B_xY3a9Z.js`, hashed build-id directories all collapse to one name)
  plus its function name when the engine reports one (`Object.fn`, `async fn`,
  `fn [as x]` and `outer/fn` all become `fn`; anonymous frames have none).
- The source line is included only for source-mapped frames. Generated
  line/column of minified bundles change per build and differ by one column
  between engines, so they never split groups; columns are never hashed.
- The first five distinct frame keys plus the exception type (an `Uncaught `
  prefix is ignored) are hashed. Messages do not split framed errors; frameless
  errors use the message with numbers, UUIDs and long hex values normalized.

Upload source maps for the best results: without them, minifiers may rename
functions between builds, and different errors in the same bundle function
group together.

Every event also stores the legacy fingerprints (raw and mapped frames: path,
line, column) as issue aliases, and an event joins the oldest issue matching any
of its aliases. Issues created before `v2` therefore keep receiving events and
pick up the `v2` alias on their next event, after which other engines and builds
join them. Late source-map uploads find the existing raw group. Already separate
historical issues are not merged retroactively. Environment isolates triage.

Resolved issues reopen with a regression flag on a greater `major.minor.patch`
release. Same/older release occurrences count without reopening. For opaque
versions such as git SHAs, an unseen version after resolution is considered
newer; previously observed versions do not reopen. Set numbered releases if
strict ordering is needed. Ignored issues continue counting without reopening.

New issues and regressions publish the shared #43 alert-event contract, with
project/environment, stable dedupe key, release label and portal link. Resolving
publishes the matching resolved event. Configure channels/rules in #43. Alert
publication is best effort, as defined by that contract, and never breaks ingest.

## Storage and upgrades

Migration `1798000000041` is additive and idempotent. `error_issues` stores
aggregates; `error_events` stores bounded structured events in eight Postgres
hash partitions by project, with idempotent `(project_id,id)` keys.
`error_sourcemaps` stores private object references. Project deletion cascades
through the three tables; source objects require bucket lifecycle management.
There is no replacement of legacy logs, ErrorDoc or bug-report APIs.

Privacy/retention integration (#47) must include `error_events.payload`
(`userId`, `sessionId`, `release`, `environment`, `replayId`) and the error tables
in project/user deletion and per-type retention. Source-map object cleanup must
respect live `error_sourcemaps.object_key` references. #44 release integration
is by version string only; no shared release entities are changed. Optional
Sentry envelope compatibility and native crash symbolication are not provided.

## Verification

Unit and route tests cover fingerprint stability, fixture symbolication, cache,
validation, 100-event grouping, retry deduplication, regression and access checks.
Set `MIGRATION_TEST_PG_HOST/PORT/USER/PASSWORD` for the real Postgres concurrency
test and existing migration drift suite. On a fresh Ubuntu 24.04 full-profile VM,
deploy an app with matching `appVersion`, upload its maps, trigger the same error
100 times, inspect original source frames and count, resolve, deploy a greater
release and repeat. Verify configured #43 channels receive new/regression alerts;
verify trace links against the installed Tempo datasource and replay after #40.
