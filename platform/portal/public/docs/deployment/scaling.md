# Scale Cairn and your apps

This page helps you give your apps and the platform more room: more copies of the platform API, more copies of an app, bigger disks, or more servers. You make most of these changes with `platformctl` and `kubectl` on the server. To see how busy each server is, open **Infrastructure** in the portal sidebar (DevOps role) for CPU, memory and pods, or **Grafana** for detailed dashboards.

## Run more copies of the platform API

The API runs 2 copies by default (1 on the `minimal` profile). With two or more, updates and server maintenance cause no downtime. To change the number, set `API_REPLICAS` (1 to 10) and run `provision` again:

```bash
sudo API_REPLICAS=3 platformctl provision
```

The value is saved in `/etc/platform/.env`, so later runs keep it. Each extra copy uses about 150 to 250 MB of memory.

> [!NOTE]
> Do not change the API's copy count with `kubectl scale` or an autoscaler. `provision` and `platformctl update` set it back to `API_REPLICAS`.

## Run more copies of an app

There is no portal control for this yet. A user with the DevOps role can set the number of copies of an environment's app through the API. See [For developers / API](#for-developers--api). Argo CD is told to leave the new count alone, so it is not reset by the next sync.

## Add servers

Use the `ha` profile and `platformctl join`. **Infrastructure** in the portal shows the join command, and [Run Cairn on several servers](../operations/ha.md) explains every step. In short, on an existing server:

```bash
sudo platformctl token create --role agent --ttl 2h --output /root/agent.token
```

Copy the file to the new machine, install `platformctl`, and run:

```bash
sudo platformctl join --role agent --server https://<server-ip>:6443 \
  --token-file /root/agent.token --nodes <all-node-ips>
```

A cluster of more than one machine needs the `ha` profile with `PLATFORM_CLUSTER_NODES` set, because the host firewall otherwise blocks the other machines. Without it, `harden` refuses to run and you must manage the firewall yourself (`--skip-hardening`).

## Grow a disk

1. Check that the storage can grow volumes:

   ```bash
   kubectl get storageclass
   ```

   Look for `ALLOWVOLUMEEXPANSION` `true` on the class your volume uses. On a single server, volumes use `local-path`. On the `ha` profile they use Longhorn classes.

2. Ask for the bigger size. For example, the platform's PostgreSQL volume on a single server:

   ```bash
   kubectl -n databases patch pvc data-postgresql-0 -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'
   kubectl -n databases get pvc data-postgresql-0
   ```

If the class cannot grow volumes, move the data to a new, larger volume with a [backup and restore](../operations/backups.md).

## See resource usage

- **Infrastructure** (sidebar, DevOps role): nodes, namespaces, pods and their logs, and CPU, memory and network charts.
- **Grafana** (sidebar): sign in with your Cairn account. Admin and DevOps users are Grafana admins, Tech Leads are editors, everyone else can view. The standard Kubernetes dashboards are included, such as *Kubernetes / Compute Resources / Namespace (Pods)*.
- **Command line:** `kubectl top nodes` and `kubectl top pods -A`.

Useful queries in Grafana's Explore view:

```promql
# CPU use of platform pods as a percentage of their request
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="platform", container!=""}[5m]))
/ sum by (pod) (kube_pod_container_resource_requests{resource="cpu", namespace="platform"}) * 100

# Memory use of platform pods as a percentage of their request
sum by (pod) (container_memory_working_set_bytes{namespace="platform", container!=""})
/ sum by (pod) (kube_pod_container_resource_requests{resource="memory", namespace="platform"}) * 100

# Volume fill level (%) in the databases namespace
kubelet_volume_stats_used_bytes{namespace="databases"} / kubelet_volume_stats_capacity_bytes{namespace="databases"} * 100
```

To get notified, create an alert in **Alerts** in the portal. See [Get alerts when something breaks](../operations/alerting.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Pod `OOMKilled` | Memory limit too low | `kubectl describe pod -n <namespace> <pod>`, then raise the limit |
| Pod `CrashLoopBackOff` | Crash, out of memory or slow start | `kubectl logs -n <namespace> <pod> --previous` |
| Autoscaler shows `<unknown>` targets | No metrics, or the pods have no CPU request | Check `kubectl top pods -n <namespace>` and the pods' resource requests |
| Node `NotReady` | Out of memory or disk | `kubectl describe node <node>`; see [Disk pressure](../troubleshooting/disk-pressure.md) |
| Volume claim `Pending` | No matching storage class, or no space | `kubectl get storageclass`; `kubectl describe pvc -n <namespace> <pvc>` |
| A new machine cannot join | Firewall or token | See the troubleshooting table in [Run Cairn on several servers](../operations/ha.md#troubleshooting) |

## How it works

### Default sizes

| Component | CPU request | Memory request | CPU limit | Memory limit | Disk |
|---|---|---|---|---|---|
| Cairn API | 250m | 256Mi | 1000m | 1Gi | none |
| Cairn portal | 50m | 64Mi | 200m | 256Mi | none |
| PostgreSQL (single server) | chart default | chart default | | | 10Gi |
| MongoDB (single server) | chart default | chart default | | | 10Gi |
| Redis (single server) | chart default | chart default | | | 5Gi, plus one read replica |
| MinIO | chart default | chart default | | | 50Gi (4 x 25Gi on `ha`) |

Prometheus keeps metrics for 30 days. On the `ha` profile the databases have their own sizes; see [Run Cairn on several servers](../operations/ha.md#datastores). The portal runs 1 copy, 2 on `ha`.

`platformctl` owns the platform's own Deployments and Helm releases. It re-applies the platform manifest on every `provision`, and it installs Helm releases with its own values (without `--reuse-values`), so changes made by hand with `kubectl patch` or `helm upgrade --set` can be lost the next time `platformctl` applies them.

### API replicas, shared state and zero-downtime deploys

The API keeps no request-spanning state in process memory, so it runs as several replicas behind its Service.

| Setting | Value |
|---|---|
| Replicas | `2` on `standard`, `full` and `ha`; `1` on `minimal`. Override with `API_REPLICAS=<1-10>` (saved in `/etc/platform/.env`) |
| Placement on `ha` | Spread across nodes with a topology spread constraint, so one node loss leaves a replica running |
| Rolling update | `maxUnavailable: 0`, `maxSurge: 1`: a new pod must be ready before an old one stops |
| PodDisruptionBudget | `platform-api`, `minAvailable: 1`, only with 2 or more replicas (a single-replica PDB would block node drains) |
| Readiness probe | `GET /api/health/ready`: PostgreSQL reachable and the pod is not draining (Redis is reported, not required) |
| Liveness probe | `GET /api/health`: process only; a database or Redis outage never restarts the API |
| Shutdown | `preStop` sleep 10 s, then SIGTERM: readiness turns 503, new connections are refused, in-flight requests finish (up to `SHUTDOWN_TIMEOUT_MS`, default 25 s), then Redis, PostgreSQL and MongoDB connections close. `terminationGracePeriodSeconds: 45` |

#### What lives in Redis

All keys use the prefix `plat:api:`. The API connects as a dedicated ACL user (`plat-api`, limited to `plat:api:*` keys and channels, no admin commands). The user is created from the platform Redis password at startup, and again if Redis restarts without it. Set `REDIS_API_USERNAME` and `REDIS_API_PASSWORD` to use a user you manage yourself.

| State | Key or channel | Behaviour |
|---|---|---|
| GitHub/GitLab sign-in `state` | `plat:api:oauth-state:<state>` | Set with `PX` and `NX`, 10 min, redeemed with `GETDEL` (single use) |
| Portal sign-in exchange codes | `plat:api:login-code:<code>` | 60 s, `GETDEL` |
| OIDC authorization codes | `plat:api:oidc-code:<code>` | 2 min, `GETDEL` |
| Rate-limit counters | `plat:api:rl:<name>:*` | Shared by all replicas |
| Permission-cache invalidation | channel `plat:api:perm-invalidate` | Pub/sub; each replica keeps a 60 s local cache |

#### When Redis is unavailable

| State | Behaviour | Why |
|---|---|---|
| Sign-in state, exchange codes, OIDC codes | Fail closed: GitHub/GitLab sign-in and the code exchange answer `503`; the OAuth authorize and token endpoints answer `503 temporarily_unavailable`; an OAuth callback returns to the sign-in page with an error | A code kept in one pod's memory could be replayed, or fail on another replica |
| Permission cache | Read from PostgreSQL on every request until the invalidation subscription is back | A missed invalidation must never keep a revoked permission alive |
| Rate limits | Fall back to per-replica limits in memory, with a logged warning; Redis is retried every 10 s | Brute-force protection never switches off |
| Readiness | Unaffected: `/api/health/ready` stays `200` and reports `checks.redis: "unavailable"` | Failing readiness on a shared dependency would remove every replica at once |

Password sign-in and requests with existing session tokens do not need Redis. Alert on the `[health] redis unavailable` log line, or on `checks.redis`.

`PLATFORM_STATE_STORE=memory` keeps all of this in process memory. It is for single-process local development only; never use it with more than one replica.

#### Checking a zero-downtime rollout

```bash
# 20 requests per second against readiness while restarting the API; expect no non-2xx responses
hey -z 60s -q 20 -c 1 https://$DOMAIN/api/health/ready &
kubectl -n platform rollout restart deploy/platform-api
kubectl -n platform rollout status deploy/platform-api
kubectl -n platform get pdb platform-api
```

### Autoscaling

k3s includes metrics-server, so Kubernetes HorizontalPodAutoscalers work for your own app Deployments. Do not put one on `platform-api`: `provision` and `platformctl update` set its replica count from `API_REPLICAS`. Databases are stateful; give them more resources rather than more copies.

### Node scheduling

On a single server, the k3s server also runs workloads. On the `ha` profile, servers and agents both run workloads; agents add capacity without taking part in the cluster vote. Labels and node selectors work as in any Kubernetes cluster, but `platformctl` re-applies the platform's own Deployments, so a node selector patched onto them by hand does not last.

## For developers / API

Set the number of copies of an app:

```http
PATCH /api/deployments/<deploymentId>/scale
Content-Type: application/json

{ "replicas": 3 }
```

- Needs the DevOps role and DevOps access to the project.
- `replicas` is an integer from 0 to 1000.
- It scales every Deployment in that environment's namespace, adds `/spec/replicas` to the Argo CD application's ignored differences (with `RespectIgnoreDifferences=true`) so the next sync keeps the count, saves the count on the deployment record and writes a `deployment.scaled` audit entry.

See [Deployments API](../api-reference/platform-api/deployments.md).
