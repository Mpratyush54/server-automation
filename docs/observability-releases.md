# Releases and deployment comparisons

The project overview includes a Releases panel with a deployment marker on a p95
before/after chart. Select a successful deploy and a 1?120 minute window. The API
reports request-weighted 5xx percentage, nearest-rank p95 latency from individual
SDK API request samples, requests/second, and issues first seen in each window.
Requests and issues are filtered by project UUID and environment name. Windows
are half-open, so a request at the marker belongs to the after window only.
The after window is marked incomplete until the entire requested interval has
elapsed. Its throughput uses elapsed seconds. Empty latency/error data and
percentage changes from zero are null, not fabricated zeroes. Comparisons over
50,000 request samples per window return an explicit error; choose a shorter
window. Historical telemetry retention limits available comparisons.

## Runtime release identity

Release identity is commit SHA when supplied, otherwise the image tag, otherwise
version. Use immutable commits and image tags/digests; floating tags cannot
reliably reproduce a historical release. Every supported preview container gets
PLATFORM_RELEASE, OTEL_SERVICE_VERSION and OTEL_RESOURCE_ATTRIBUTES with
service.version at creation. For Argo deployments the finalization step merges
these variables into Deployments and StatefulSets (including init containers)
in the project-owned namespace and waits up to three minutes for updated, ready
replicas. Literal existing OTel attributes are preserved except service.version;
valueFrom attributes fail explicitly because they cannot be safely merged.
Argo ignores only the three managed environment entries and uses
RespectIgnoreDifferences=true to preserve them on subsequent syncs. Unrelated
manifest values remain under Git control. Node/Python telemetry prefers
PLATFORM_RELEASE, including when stale application/config versions are supplied.

Limitations: the first Argo sync can briefly emit unversioned telemetry before
finalization rolls out the injected template. For complete coverage from the
first pod, include these variables in the application manifests/build itself.
Jobs/CronJobs, externally deployed workloads and browser build versions are not
injected by this change. Browser SDK builds must provide their release version.
Faro web vitals comparison is unavailable until a project-scoped query/storage
contract is available; the panel explicitly shows this rather than sample data.

## Markers and Grafana

Existing Deployment rows are the durable event store: deployedAt is the marker,
with commitSha, imageTag, version and deployedById. Restarting a workload no
longer moves its release marker. No database migration or new infrastructure is
needed. GET /api/projects/:projectId/releases returns the newest 200 successful
markers; GET /api/projects/:projectId/releases/:id/comparison?minutes=15 returns
the comparison. Both require project access.

Set GRAFANA_URL (internal base URL without /api) and
GRAFANA_SERVICE_ACCOUNT_TOKEN (annotation read/write permissions) on the API to
enable Grafana annotations. Store the token as an API Secret, never in browser
config. The operation outbox retries failures without failing deployments and
looks up the deployment tag before retrying a POST. Configure a Grafana annotation
query with tags platform-deploy and project:<project UUID>; optionally filter
by environment:<environment UUID>. Annotations contain the release, commit,
author ID, timestamp and rollback indication. No credentials are exposed through
the releases API. Without Grafana, portal markers and deploy events still work.

## Rollback and alert integration

POST /api/rollback accepts {deploymentId, reason}; the reason is now required
(1?1000 characters). Send Idempotency-Key to safely retry requests. Existing
role and project access checks apply. The route takes the same per-environment
lock as deploy/restart/scale/terminate, rejects stale deployment IDs, finds the
previous successful deployment, and creates a pending deployment using its
image, commit, branch and Git path. The response includes operationId and
newDeployment; follow GET /api/operations/:id. The original deployment is marked
rolled_back only after the restored release successfully finalizes. A failed
rollback is recorded as failed and does not claim that restoration succeeded.
New markers have fresh annotation IDs and record rollbackFrom, rollbackTarget,
rollbackReason and the initiating author. The old previousVersion parameter no
longer selects a target. Existing portal deployment buttons supply a generic
manual-action reason and an idempotency key through ApiService; the new release
panel records the operator-entered reason. Restoration of mutable tags is not guaranteed.

Successful deploys publish the shared B1 deploy alert event. Reading a completed
comparison with at least 20 requests on each side publishes a warning when p95
increases over 20% or error rate rises over one percentage point. Deduplication
uses deploy-regression:<deployment UUID>; #43 owns routing/silences. This is a
comparison-triggered advisory, not continuous SLO evaluation. Automatic SLO burn
rollback is not implemented/enabled: #43's evaluator and a shared policy contract
must land before automatic destructive actions can be wired safely.

## Ubuntu acceptance exercise (requires a real VM)

1. On a fresh Ubuntu 24.04 VM with 4 vCPU / 8 GB, provision the full profile using
   sudo platformctl provision --profile full. Configure Grafana annotation access.
2. Deploy an SDK-instrumented app at immutable commit/image v1. Send requests for
   15 minutes. Deploy v2 with an injected delay and send the same load for another
   15 minutes. Verify injected environment entries and service.version in traces,
   metrics, logs and profiles; verify Grafana's project annotation query.
3. Open the project Releases panel, select v2 and verify p95 increases, with stable
   throughput/error percentage under the controlled load. Ensure another project's
   requests do not affect the result. Web vitals currently show unavailable.
4. Enter a reason and click rollback once. Follow the operation to success; verify
   the previous image/commit is live, v2 is marked rolled_back, and a new marker
   and annotation identify the restored version. Retry the same request with the
   same Idempotency-Key and verify no duplicate operation. Repeat while a deploy
   lock is held and verify HTTP 409. Restart the API during rollback and verify
   the leader resumes the existing three-step operation.
