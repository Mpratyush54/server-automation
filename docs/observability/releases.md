# Compare releases and roll back

Check whether a deploy made your app slower or less reliable, and go back to the previous version if it did. Open the project's **Deployments** section and find the **Releases and deploy markers** panel.

## Compare before and after a deploy

1. Open the project and go to **Deployments**.
2. In **Releases and deploy markers**, pick a deploy under **Select a deployment**.
3. Set **Minutes before / after**, from 1 to 120. For example, 15 compares the 15 minutes before the deploy with the 15 minutes after it.
4. Read the table. For each side it shows the error rate (share of requests with a 5xx status), p95 latency (95% of requests were faster than this), requests per second, and new error issues. The chart shows p95 before and after the deploy marker.

Notes:

- Data comes from your app's Cairn SDK. Without the SDK, the panel has no numbers.
- If the after window has not fully passed yet, the result is marked incomplete.
- Empty data shows as blank, not zero. A change from zero has no percentage.
- Very busy windows (over 50,000 requests on one side) are refused. Pick fewer minutes.
- Request samples are kept 30 days, so older deploys cannot be compared.
- Browser web vitals are not compared yet. The panel says so instead of showing sample data.

## Roll back

1. In the same panel, select the deploy you want to undo.
2. Type a **Rollback reason**, for example "p95 doubled after v2".
3. Click **Roll back to previous release**.

The platform redeploys the previous successful release: its image, commit, branch and Git path. The undone deploy is marked *Rolled back* only after the restored version is running. A failed rollback is shown as failed.

Use fixed image tags or digests and real commits. A floating tag such as `latest` may not bring back the old code.

## Get alerted about a bad deploy

When you open a completed comparison with at least 20 requests on each side, the platform sends a warning alert if p95 latency went up by more than 20%, or the error rate went up by more than one percentage point. This is a one-off check when the comparison is read, not continuous monitoring. Route it in [alerting](../operations/alerting.md).

Every successful deploy also sends a deploy alert event. Automatic rollback is not available.

## Show deploys in Grafana

Grafana can draw a line for each deploy on its charts (an annotation). Ask your administrator to set these on the API:

- `GRAFANA_URL`: Grafana's internal base URL, without `/api`.
- `GRAFANA_SERVICE_ACCOUNT_TOKEN`: a Grafana service account token that can read and write annotations. Store it as a Secret, never in browser config.

Then add an annotation query in Grafana with the tags `platform-deploy` and `project:<project UUID>`. Optionally filter with `environment:<environment UUID>`.

Without Grafana, the portal markers and deploy events still work.

## How it works

- Release identity is the commit SHA when given, otherwise the image tag, otherwise the version.
- The comparison uses the project's own API request samples, filtered by project and environment name. p95 is nearest-rank over individual samples. The error rate is weighted by requests. New issues are errors first seen in each window.
- Windows are half-open: a request exactly at the deploy time belongs to the after window. Throughput for an unfinished after window uses the seconds that have passed.
- Markers are the existing deployment records. The deploy time (`deployedAt`) is the marker, with `commitSha`, `imageTag`, `version` and `deployedById`. Restarting a workload does not move the marker.
- The regression alert uses source `deploy`, severity warning and dedupe key `deploy-regression:<deployment UUID>`. Routing and silences are handled by alerting.
- Release environment variables: every supported preview container gets `PLATFORM_RELEASE`, `OTEL_SERVICE_VERSION` and `OTEL_RESOURCE_ATTRIBUTES` (with `service.version`) when it is created. For Argo CD deployments, the finalize step merges these into Deployments and StatefulSets (including init containers) in the project namespace and waits up to three minutes for updated, ready replicas. Existing literal OTel attributes are kept except `service.version`. Attributes set with `valueFrom` fail explicitly because they cannot be merged safely. Argo CD ignores only these three entries (with `RespectIgnoreDifferences=true`), so other manifest values stay under Git control. The Node and Python SDKs prefer `PLATFORM_RELEASE` over other version settings.
- Limits: the first Argo CD sync can briefly send telemetry without a version, before finalize rolls out. To cover the first pod, put the variables in your manifests or build. Jobs, CronJobs, workloads deployed outside the platform, and browser builds are not injected. Browser SDK builds must set their own release version.
- Grafana annotations contain the release, commit, author ID, time and whether it was a rollback. Failed annotation calls are retried from an outbox without failing the deploy; before retrying, it looks up the deployment tag to avoid duplicates. The releases API never exposes Grafana credentials.
- Rollback takes the same per-environment lock as deploy, restart, scale and terminate, and rejects stale deployment IDs. A rollback creates a pending deployment. New markers get fresh annotation IDs and record `rollbackFrom`, `rollbackTarget`, `rollbackReason` and the author. The old `previousVersion` parameter no longer picks a target. The portal's other deployment buttons send a generic reason and an idempotency key; this panel sends the reason you type.

## For developers / API

All endpoints need project access.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/:projectId/releases` | Markers: the 200 newest deployments, keeping those that finished deploying |
| `GET` | `/api/projects/:projectId/releases/:id/comparison?minutes=15` | Before and after comparison. `minutes` is 1–120 (default 15). Returns `before`, `after`, `deltas`, `complete`. |
| `POST` | `/api/rollback` | Body `{ "deploymentId": "...", "reason": "..." }`. `reason` is required, 1–1000 characters. |

Send an `Idempotency-Key` header with `POST /api/rollback` to retry safely. The response includes `operationId` and `newDeployment`; follow the progress with `GET /api/operations/:id`.

### Test on a real server

1. On a fresh Ubuntu 24.04 VM with 4 vCPU and 8 GB, run `sudo platformctl provision --profile full` and set up Grafana annotation access.
2. Deploy an SDK-instrumented app at a fixed commit or image (v1) and send requests for 15 minutes. Deploy v2 with an added delay and send the same load for 15 minutes. Check the injected variables and `service.version` in traces, metrics, logs and profiles, and the Grafana annotation query.
3. In the releases panel, select v2. p95 should go up while throughput and error rate stay stable. Another project's requests must not affect the result.
4. Enter a reason and roll back once. Follow the operation to success. The previous image or commit should be live, v2 marked rolled back, and a new marker and annotation should name the restored version. Retry with the same `Idempotency-Key`: no duplicate operation. Retry while a deploy lock is held: HTTP 409. Restart the API during rollback: the leader resumes the existing operation.
