# Background jobs and leader election

The platform API can run as several replicas. Periodic work must still run
**once per schedule cluster-wide**, and long-running work (deploy rollouts)
must survive an API restart. This page lists every timer and background task
in `platform/api/src` and how each one is made exactly-once.

## Inventory

| Work | Before | Now | Schedule |
|---|---|---|---|
| Preview decay (`lib/preview-decay.ts`) | `setInterval` + startup `setTimeout` in every replica | Leader loop | `PREVIEW_DECAY_INTERVAL_SECONDS` (default 900), TTL `PREVIEW_TTL_HOURS` (default 72) |
| Deploy rollout (`POST /deploy`) | fire-and-forget `setTimeout`, lost on restart | Step-logged operation (`lib/deploy-op.ts`, #23) under the deploy lock; started on the accepting replica | per request |
| Argo health polling (rollout step) | `setTimeout` sleep loop inside the rollout | Unchanged loop, now the `wait-healthy` step of the deploy operation | 5 s × 36 |
| Operation resume (`operation-resume`) | — | Leader loop: resumes non-terminal operations whose lock is free | every 60 s and right after gaining leadership |
| Outbox dispatch (`outbox-dispatch`) | — | Leader loop | every 5 s |
| Operation cleanup (`operation-cleanup`) | — | Leader loop: prunes expired idempotency keys, webhook deliveries, outbox rows | hourly |
| Deploy recovery | — | Leader loop: fails orphaned rollouts with neither a job nor an operation | every 15 s and right after gaining leadership |
| Token cleanup | — | Leader loop | hourly |
| Alert evaluation (`POST /alerts/evaluate`) | request-driven; caller supplies the metric values | Unchanged (no timer) | — |
| `withTimeout` (`lib/with-timeout.ts`) | per-request timeout helper | Unchanged (not background work) | — |
| Webhook preview deploys (`routes/webhooks.ts`) | inline in the webhook request | Unchanged (not background work) | — |

Alert evaluation stays request-driven: there is no metric source inside the
API to evaluate on a schedule yet. A scheduled evaluator belongs with the
alerting work (monitors/SLOs) and would register as another leader job.

## Leader election

`lib/leader.ts` implements leader election on a `coordination.k8s.io/v1`
Lease named `platform-api-leader` in the API's own namespace (`platform`).

- Lease duration 10 s, renew/retry every 2 s (`LEADER_LEASE_DURATION_SECONDS`,
  `LEADER_RETRY_PERIOD_SECONDS`).
- Updates are compare-and-swap on `resourceVersion`, so two candidates can never
  both win.
- A follower takes over once the holder's record has not changed for a full
  lease duration, measured on its own clock (clock skew between nodes does not
  matter). Worst case after a hard kill: about 12 s.
- A leader that cannot renew steps down after 6 s (before any peer may take
  over), and `isLeader()` turns false as soon as its last renew is stale.
- On SIGTERM/SIGINT the leader releases the Lease; a peer takes over at its next
  retry (about 2 s).
- Outside Kubernetes, or with `LEADER_ELECTION=disabled`, the single process is
  always the leader.

API: `isLeader()`, `onLeadershipChange(fn)`, `getLeadership().start()/stop()`.
Jobs registered with `registerLeaderJob()` (`lib/scheduler.ts`) start their
timer on leadership gain and clear it on loss; runs of the same job never
overlap.

### RBAC

The `platform-api` Role in the `platform` namespace grants:

```yaml
- apiGroups: ["coordination.k8s.io"]
  resources: ["leases"]
  verbs: ["create"]                 # create cannot be limited by name
- apiGroups: ["coordination.k8s.io"]
  resources: ["leases"]
  resourceNames: ["platform-api-leader"]
  verbs: ["get", "update"]
```

No cluster-wide Lease access is granted. The manifests are
`platformctl/internal/manifests/data/platform-api-rbac.yaml` and
`k8s/platform/api-rbac.yaml`; they must stay identical (a test enforces this).

## Durable deploy rollouts

`POST /deploy` takes the per-environment deploy lock
(`lock:project:<id>:deploy:<envId>`), saves the Deployment and creates a
`deployment.deploy` operation (`operations` + `operation_steps`, see
`lib/operations.ts`). The accepting replica runs it while holding the lock
(auto-renewed) and records each step: `apply`, `wait-healthy`, `finalize`.

If that replica dies, its lock lapses and the leader's `operation-resume` job:

- re-runs the step that was in flight (every step is idempotent: Argo app
  ensure+sync, preview apply, ingress ensure), or fails the deploy as
  superseded when a newer deployment of the same environment exists;
- once a step was interrupted `maxAttempts` (2) times, fails the operation
  **and** the Deployment (`metadata.error` explains the interruption).

The operation worker has no leader mechanism of its own: its three jobs
(`operation-resume`, `outbox-dispatch`, `operation-cleanup`) are ordinary
leader jobs on the `platform-api-leader` Lease.

Deployments that are still `pending`/`building`/`deploying` after 10 minutes
with neither a `background_jobs` row nor a deploy operation (rollouts started
by an older API version) are marked failed by `deploy-recovery`. A Deployment
therefore never stays "in progress" after a restart.

`background_jobs` remains the generic durable-job table (claim with a
conditional `UPDATE`, 60 s heartbeated lock, `max_attempts`); a legacy
`type=deploy` row is handed over to a deploy operation. Finished rows are
pruned after 30 days by `token-cleanup`.

## CronJob alternative

Leader loops are the default because they cost nothing extra on a single
server. A Kubernetes CronJob spins up a pod per run (image pull, memory spike),
so it suits infrequent jobs only (hourly or slower). To move a job to a
CronJob:

1. Set `JOBS_EXTERNAL=<name>[,<name>]` on the API Deployment; the in-process
   timer for those jobs is then not started.
2. Run `node dist/jobs/<name>.js` from the API image in a CronJob with
   `concurrencyPolicy: Forbid` and the same `envFrom: platform-env`.

Available entry points: `dist/jobs/preview-decay.js`, `dist/jobs/token-cleanup.js`.
Deploy recovery is not available as a CronJob: resuming a rollout needs a
long-lived process.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: platform-api-cron-token-cleanup
  namespace: platform
spec:
  schedule: "17 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 1
      template:
        spec:
          restartPolicy: Never
          automountServiceAccountToken: false
          securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
          containers:
          - name: job
            image: <platform-api image>
            command: ["node", "dist/jobs/token-cleanup.js"]
            envFrom: [{ secretRef: { name: platform-env } }]
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
            resources:
              requests: { cpu: 50m, memory: 96Mi }
              limits: { cpu: 500m, memory: 256Mi }
```

## Metrics

`GET /api/metrics/jobs` (devops/admin) returns the serving replica's counters
in Prometheus text format:

- `platform_job_runs_total{job,result}` — `result` is `success`, `failure` or
  `skipped`; jobs: `preview-decay`, `deploy-recovery`, `token-cleanup`,
  `operation-resume`, `outbox-dispatch`, `operation-cleanup`.
- `platform_job_last_success_timestamp_seconds{job}`
- `platform_api_leader` — 1 on the replica holding the Lease.

Counters are per process; collect every API pod and `sum` across them.

## Verifying with two replicas

1. Scale the API to 2 replicas and set `PREVIEW_DECAY_INTERVAL_SECONDS=60`.
2. `kubectl -n platform get lease platform-api-leader -o yaml` shows one holder.
3. `kubectl -n platform logs -l app=platform-api -f | grep '\[decay\] run started'`
   prints one line per minute in total.
4. Delete the holder pod (`kubectl delete pod --grace-period=0 --force ...`);
   the other pod logs `acquired leadership` within about 12 s.
5. Start a deploy, then delete the pod that accepted it; the Deployment either
   finishes (resumed by the leader) or turns `failed` — never stays `deploying`.
