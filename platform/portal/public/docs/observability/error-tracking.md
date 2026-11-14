# Track and fix errors

This page helps you see which errors your users hit, how often, and in which release, so you can fix the worst first. Open the project, choose **Monitoring**, then the **Errors** view. The **Overview** view also lists the latest errors.

Cairn groups repeats of the same error into one **issue**, even across browsers and deploys.

## Send errors from your app

**Node.js**, after `platform.init(...)`:

```js
try {
  await chargeCard(order);
} catch (error) {
  await platform.captureException(error, { userId: 'u_8f3a' });
  throw error;
}
```

**Python**:

```python
platform.capture_exception(error, userId='u_8f3a')
```

**React and Angular**: when browser monitoring is on, errors your app throws are sent automatically, including those caught by the React `ErrorBoundary` and the Angular error handler. See [Monitor real users in the browser](../guides/frontend-rum.md).

Tips:

- Set your app version in the SDK (for example `version: '1.4.0'` in the Node.js options; `appVersion` for React and Angular). Errors are then grouped by release, and a fixed error that comes back in a newer release is flagged.
- Use made-up user ids (such as `u_8f3a`), not emails or names.
- Remove personal data from error messages before you send them.

## Fix an error

1. Open **Monitoring**, view **Errors**.
2. Filter by **Release**, **Environment** or **Status**, then choose **Apply filters**.
3. Choose an issue. You see the stack trace (original source when source maps are uploaded), recent events, breadcrumbs (what happened just before), first and last seen, counts per release, and links to the trace or session replay.
4. Pick an **Assignee** and choose **Assign**. When the fix is out, choose **Resolve**. Use **Ignore** for noise, **Reopen** to undo.

Viewers can read issues. You need the project role **developer** or higher to assign, resolve, ignore or reopen.

What happens next:

- A resolved issue reopens, marked **Regression**, if it happens again in a higher release (for example resolved in `1.4.0`, seen in `1.5.0`). The same or an older release only adds to the count.
- An ignored issue keeps counting but never reopens.
- New issues and regressions raise an alert. Set up where it goes in [Get alerts when something breaks](../operations/alerting.md). Resolving the issue resolves the alert.

## See your original code (source maps)

Production JavaScript is minified, so stack traces point at unreadable code. Upload the source maps from your build and Cairn shows your original files and lines.

Run this in CI after the build and before the deploy:

```sh
export PLATFORM_API_URL=https://platform.example.com
export PLATFORM_CI_TOKEN="$CI_SOURCE_MAP_TOKEN"
npm run platform-sourcemaps -- upload "$PROJECT_UUID" "$APP_VERSION" dist /assets
```

- `$APP_VERSION` must match the version your app reports.
- `dist` is the build folder; `/assets` is the public path the files are served from.
- Keep source maps private. They can contain your source code.

For the token, create an agent token whose only scope is `errors:sourcemaps:<project id>` (see [For developers / API](#for-developers--api)). It can upload maps for that project and nothing else. Store it as a CI secret. People with the project role developer can also upload with their own sign-in.

## How it works

### Storage

The API stores issues and events in PostgreSQL: `error_issues` holds totals per issue, `error_events` holds bounded events in eight hash partitions by project (idempotent `(project_id, id)` keys), and `error_sourcemaps` holds references to private objects. Source map files are stored, content-addressed, in the private uploads bucket (MinIO or S3; local storage is for development only). Deleting a project removes its rows from all three tables; source map objects need bucket lifecycle rules.

Events are processed by the telemetry Redis Streams worker in the leader replica. In memory mode or during a Redis outage they are processed inline. No extra workload or install step is needed. Explicit SDK capture works on every profile; browser monitoring and trace links need the full profile.

Events older than the project's error retention (default 90 days, set in the project's **Settings**, **Privacy**) are deleted by the hourly `error-retention` job. An issue whose last event aged out disappears; if the error comes back it opens a new issue. See [Privacy and retention](../operations/telemetry-privacy.md).

### Browser errors

React and Angular browser monitoring (built on Grafana Faro) sends its already scrubbed exceptions to the `errorsEndpoint` in the telemetry config, at most 20 per send, on a best-effort basis. Sampling, Do Not Track and consent settings and `beforeSend` filters apply first. The project and environment come from the signed browser ingest token. For custom collector setups without `DOMAIN`, set `API_PUBLIC_URL` to the public API origin.

### Grouping

Issues use a fingerprint that does not depend on the browser engine or the build (`v2:` prefix), so one bug in Chromium, Firefox and Safari, across deploys, lands in one issue:

- Frames from the Cairn SDKs and Faro, browser internals (`[native code]`, `<anonymous>`, extension URLs) and `Error` constructor frames are dropped.
- Your own (in-app) frames are used. `node_modules`, vendor, framework, polyfill and runtime bundles only count when no in-app frame remains.
- Each frame contributes its URL path with build hashes removed (`main.3f2a1b9c.js`, `main.3f2a1b9c.chunk.js`, `chunk-ABCD1234.js`, `index-B_xY3a9Z.js` and hashed build-id folders all become one name), plus its function name when the engine reports one (`Object.fn`, `async fn`, `fn [as x]` and `outer/fn` all become `fn`).
- The source line is included only for source-mapped frames. Minified line and column numbers change per build and differ between engines, so they never split groups. Columns are never used.
- The first five distinct frames plus the exception type (an `Uncaught ` prefix is ignored) are hashed. Messages do not split errors that have frames. Errors without frames use the message, with numbers, UUIDs and long hex values normalized.

Without source maps, minifiers may rename functions between builds, and different errors in the same bundle function can group together.

Every event also stores the older fingerprints (raw and mapped frames: path, line, column) as aliases, and joins the oldest issue matching any of them. Issues created before `v2` keep receiving events and pick up the `v2` alias on their next event. Late source map uploads find the existing raw group. Issues that were already separate are not merged afterwards. Each environment has its own issues.

### Regressions and releases

Releases are compared as `major.minor.patch`. For other versions, such as git SHAs, a version not seen before the issue was resolved counts as newer; versions seen before do not reopen it. Use numbered releases if you need strict ordering. Release comparison is by version string only.

### Source maps

Only flat source map v3 files up to 5 MiB each are accepted. Indexed or remote maps are rejected, and the API never fetches source URLs. The deployed file path must match the uploaded `file` exactly (URL origin, query and fragment are ignored). The upload script requires HTTPS (except localhost) and refuses redirects. The API symbolicates with the lockfile-pinned `source-map` 0.6.1 package and caches up to 16 maps per process by immutable object key, so replacing maps invalidates caches on all replicas. Maps uploaded after an error arrived also apply when you open the issue. If a map is missing or storage is down, raw frames are shown.

The trace link opens Grafana Explore with the Tempo data source. The replay link opens the session replay player.

### Alerts

New issues and regressions publish an alert event (source `error-tracking`) with project, environment, a stable dedupe key, the release and a portal link. Resolving publishes the matching resolved event. Publishing is best effort and never blocks ingest.

### Not provided

Sentry envelope compatibility and native crash symbolication are not provided. Legacy log, error and bug report APIs are unchanged.

### Tests

Unit and route tests cover fingerprint stability, symbolication, caching, validation, grouping of 100 events, retry deduplication, regressions and access checks. Set `MIGRATION_TEST_PG_HOST`, `MIGRATION_TEST_PG_PORT`, `MIGRATION_TEST_PG_USER` and `MIGRATION_TEST_PG_PASSWORD` for the real PostgreSQL concurrency test and the migration drift suite. Migration `1798000000041` is additive and idempotent.

## For developers / API

### Send an error

`POST /api/sdk/errors` with a project-bound server or browser SDK token and a version 1 error event:

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

- `type`, `message`, `environment` and each frame's `file` are required. A rejected event returns 400 naming the field.
- Frames are innermost first; lines start at 1, columns at 0.
- `eventId` is generated if missing. Keep the same id when you retry a request.
- `release` defaults to `unknown`. `replayId` links the event to a session replay.
- Instead of `frames` (or with an empty `frames` array) you can send the browser's `Error.stack` string as `stack`, up to 64 KiB. V8 (`at fn (url:line:col)`) and SpiderMonkey/JavaScriptCore (`fn@url:line:col`) formats are parsed.
- At most 100 frames and 100 breadcrumbs; string fields are bounded. The response is `{ "accepted": true }`.

`POST /api/errors/rum` accepts short-lived `web` ingest tokens with origin checks and takes the project and environment from the token.

### Upload a source map

`POST /api/projects/<id>/releases/<version>/sourcemaps` with JSON `{ "file": "/assets/app.js", "map": { ... } }`. The script `scripts/platform-sourcemaps.mjs` (run as `node scripts/platform-sourcemaps.mjs upload PROJECT_UUID RELEASE DIST_DIR [PUBLIC_PATH]`) sends one request per `.map` file.

Create the CI token with `POST /api/agent-tokens`, signed in as a Cairn admin or DevOps user who has recently confirmed a second factor, with body `{ "name": "ci-sourcemaps", "scopes": ["errors:sourcemaps:<project id>"] }`. The `projects:read` scope does not allow uploads. The token picker in the portal does not offer this scope.

### Read and triage

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/<id>/errors` | List issues (filter by release, environment, status) |
| `GET` | `/api/projects/<id>/errors/<issueId>` | One issue with recent events |
| `PATCH` | `/api/projects/<id>/errors/<issueId>` | Set `status` (`open`, `resolved`, `ignored`) and/or `assigneeId` (a user with project access, or `null`). Returns the updated issue, or 404 if the issue is not in that project |
