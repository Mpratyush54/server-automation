# Project namespace isolation

Project namespaces use kube-router NetworkPolicy enforcement already bundled with k3s. No additional CNI, controller pod, or profile-specific service is installed. Kubernetes 1.30+ is required for the GA ValidatingAdmissionPolicy used to guard RBAC binding bootstrap. Apply the updated installer RBAC manifest before deploying the new API. Do not disable the k3s network policy controller.

## Baseline

`ensureProjectNamespace(projectId, { name, namespace })` is the only API namespace creator. API deployment, SDK registration (GitOps and direct), ingress creation, and previews apply it before workloads. Argo's automatic namespace creation is disabled. Only dedicated namespaces are accepted; shared/system namespaces (`reservedNamespaces`: default, platform, databases, preview, ingress-nginx, argocd, cert-manager, monitoring, oauth2-proxy, portainer, storage and kube-*) and conflicting project ownership fail closed. Kubernetes errors other than absence/conflict are propagated.

New namespaces have project/environment identity labels and restricted PSA enforce/warn/audit. Existing namespaces retain their enforcement level (privileged if previously unset) and receive restricted warn/audit for the migration release. The generated preview/direct deployment templates set non-root, RuntimeDefault seccomp, no privilege escalation, dropped capabilities, and no mounted service-account token. Images must support non-root execution; otherwise use a compatible image. User Git manifests must satisfy restricted admission themselves.

Policies default-deny ingress and egress and explicitly allow:

- Communication between pods in the same environment namespace.
- Ingress from ingress-nginx controller pods in the ingress-nginx namespace, and egress to them on TCP 80/443 so an app can call a public hostname that hairpins back through the controller (traffic still passes the target's Ingress rules).
- TCP/UDP DNS port 53 to kube-dns pods in kube-system.
- Shared postgresql:5432, mongodb:27017, and redis:6379 pods in databases, selected by chart instance/name labels. An operator can restrict the enabled database types per environment.
- platform-api in platform on TCP 3000, and Alloy in monitoring on TCP 4317/4318. Adjust the selector/ports when integrating other collectors (#37/#49).
- Public IPv4 TCP 80/443 by default, configurable or disabled per project/environment. RFC1918, loopback, link-local, CGNAT, multicast, and reserved networks are excluded. IPv6 public egress is denied. Custom clusters using public pod/service/node CIDRs need those ranges added to `privateNetworks` before enabling public egress. No unrestricted UDP or arbitrary-port internet egress is granted.

Shared databases have a common endpoint for all projects. NetworkPolicy cannot distinguish logical databases/users behind that endpoint. Tenant boundaries there depend on project database users/ACLs, including Redis key prefixes. Cross-project logical database denial must be tested with project credentials, separately from the namespace TCP matrix. These policies cannot replace database authorization.

Quotas cap requests/limits for CPU/memory, pods, PVC count/storage, and disallow LoadBalancer/NodePort Services. Development/staging/preview defaults: requests 1 CPU/1Gi RAM, limits 2 CPU/2Gi RAM, 10 pods, 4 PVCs/5Gi storage. Production: requests 2 CPU/2Gi RAM, limits 4 CPU/4Gi RAM, 20 pods, 4 PVCs/20Gi storage. LimitRange gives new containers requests 100m/128Mi and limits 500m/512Mi. These are ceilings, not reservations or added workloads.

## Administrator settings

Mount an operator-owned JSON file in the API (a ConfigMap is sufficient) and set `NAMESPACE_BASELINE_SETTINGS_FILE` to its path. Do not expose this file through SDK settings. A missing variable uses conservative defaults; malformed configuration fails deployment. Settings are read per operation; reconcile existing namespaces with the backfill job after a change.

```json
{
  "defaults": { "internetEgress": true },
  "projects": {
    "PROJECT_UUID": {
      "production": {
        "internetEgress": false,
        "databases": ["postgres"],
        "quota": { "pods": "12", "requests.storage": "10Gi" }
      },
      "preview": { "internetCidrs": ["8.8.8.0/24"] }
    }
  }
}
```

`internetCidrs` are IPv4 CIDRs, never DNS names; private ranges cannot be allowed by this setting. An empty list denies public egress. Service-type quota restrictions cannot be overridden. Plan/usage work (#57) can feed this same settings contract; no plan schema is introduced here. Build workloads (#55) should run restricted/non-root and use an explicit profile/settings quota rather than bypassing the baseline.

## Backfill and PSA rollout

Run the one-shot job using the built API image with its normal database environment and a cluster-operator kubeconfig/service account. It intentionally disables TypeORM schema synchronization. It is not scheduled at API startup and does not restart workloads.

```sh
node dist/jobs/namespace-backfill.js --report /tmp/namespace-report.json
# Review desired manifests, current policy names, quota usage, pod warnings,
# skipped namespaces, and every workload's network destinations.
node dist/jobs/namespace-backfill.js --apply --report /tmp/namespace-report.json
```

Dry-run issues only Kubernetes reads and writes the local report (which contains no pod specs or credentials). A matching desired-configuration fingerprint is required to apply. RBAC/policy/API errors are reported and block apply; namespaces not yet created and shared legacy previews are explicitly skipped. Allows are installed before default deny, then LimitRange and quota; reruns replace named baseline resources with resourceVersion and preserve namespace metadata. New quotas/defaults do not mutate running pods. Existing unrelated NetworkPolicies are reported, not deleted; these can widen access, and status flags additional policies for review. Workloads with unlisted network destinations need operator settings/policy review before applying. This is how compliant workloads keep running without a rollout.

For legacy previews, new deploys target a dedicated namespace per immutable project ID. New deployment metadata records that namespace. Old deployment records retain their legacy cleanup behavior and ownership check. Redeploy previews, verify health/routing, then retire old preview ingress/workloads with the existing terminate operation. The shared preview namespace is never relabeled as one tenant. When an old and new preview use the same hostname, coordinate ingress cutover before removing the old ingress. The backfill intentionally does not attempt this rolling workload migration.

Deploy operations persist restricted PSA/resource preflight warnings in deployment metadata, display them in the portal, and write them to API deployment logs. The backfill report provides per-pod details. This conservative preflight does not replace Kubernetes admission: also review API-server admission warnings and Argo sync errors for new user manifests.

After one release in warn/audit mode, fix manifests and quota headroom, generate/review a fresh report, then opt into enforcement:

```sh
node dist/jobs/namespace-backfill.js --report /tmp/enforce-report.json
node dist/jobs/namespace-backfill.js --apply --enforce --report /tmp/enforce-report.json
```

Enforcement is blocked if current pods have preflight security/resource warnings. It does not evict existing pods. Review manifests for future jobs/rollouts too. Failed apply is resumable with the same report unless configuration changed; regenerate the report after a completed enforcement change.

## Status and permissions

`GET /projects/:id` adds `namespaceBaselines` after the usual project access check. Each environment reports policy/ownership/PSA status, quota hard/used values, LimitRange/quota match status and additional policies; Kubernetes unavailability yields an explicit status error. The portal displays isolation and quota usage on project details.

RBAC added for this feature, and nothing else:

| Grant | Scope | Verbs | Used by |
|---|---|---|---|
| `namespaces` | cluster (ClusterRole platform-api) | get, list, create, update | read/create/label project namespaces |
| `rolebindings` | cluster (ClusterRole platform-api) | get, create, update | bootstrap the per-namespace baseline RoleBinding |
| `clusterroles/platform-namespace-baseline` | that one role | bind | reference the baseline role from that RoleBinding |
| `networkpolicies`, `resourcequotas`, `limitranges` | each project namespace (RoleBinding to ClusterRole platform-namespace-baseline) | get, list, create, update | apply baseline, status, backfill report |

No delete, patch, watch, escalate or clusterrolebindings are granted. Two fail-closed ValidatingAdmissionPolicies confine the cluster-scoped verbs: `platform-project-namespaces` lets the API create/update only non-reserved namespaces that carry `platform.io/project` and `platform.io/env` labels and never reassign an existing owner label; `platform-baseline-bindings` lets it create/update only the exact baseline RoleBinding in such namespaces. A newly created RoleBinding reaches the authorizer asynchronously, so the first baseline write retries briefly on 403.

The baseline ClusterRole has no ClusterRoleBinding. Each project namespace receives a RoleBinding for networkpolicies, resourcequotas and limitranges. The API can bootstrap only that named ClusterRole binding; a fail-closed ValidatingAdmissionPolicy restricts API-created bindings to labeled dedicated project namespaces, the exact role, and the exact platform API service account. No policy/quota/limit rights are added in system/platform namespaces. Cluster namespace creation/label management remains a trusted API control-plane permission; RBAC cannot filter namespaces by labels. Install admission guards before granting bootstrap rights. Cluster administrators and GitOps permissions remain trusted and must not grant tenants rights to rewrite namespace ownership or baseline policies.

## Validation on Ubuntu 24.04

Provision a fresh 4-vCPU/8-GB VM with `sudo platformctl provision`. Deploy two non-root example apps into different projects; confirm kube-router policy enforcement is enabled. With a restricted-compliant probe pod in each project namespace:

1. Check namespace labels, seven NetworkPolicies, ResourceQuota and LimitRange, and quota usage in API/portal.
2. Resolve the local service and cluster DNS; reach the local service and the app through ingress-nginx.
3. Attempt a TCP connection to the other project's pod IP and Service DNS/IP; require a connection timeout, not merely an HTTP error. Repeat in both directions, and with public egress disabled.
4. Reach configured shared database ports; use each project's credentials to confirm access to its database and denial to the other project's logical database/Redis keys.
5. Verify public HTTP/HTTPS default access and revocation after settings reconciliation; verify private destinations are not covered by public egress.
6. Submit a privileged pod using server-side dry-run and require PSA rejection. Try a compliant pod without resource fields and confirm LimitRange defaults and quota accounting. Attempt a LoadBalancer/NodePort Service and require quota rejection.
7. Backfill a legacy dedicated namespace in dry-run; confirm no cluster changes. Apply in warn mode while watching compliant workload readiness/traffic; require no restart/drop. Fix warnings, re-report, enforce, and confirm privileged rejection.
8. As platform-api, confirm baseline resource access is denied in kube-system/platform and baseline binding creation is denied there. Confirm replaying the backfill is idempotent.

The automated subset (two namespaces, bidirectional pod/Service timeouts, DNS/local service, privileged rejection, LoadBalancer quota, LimitRange defaults and idempotent pod preservation) runs with:

```sh
cd platform/api
npm run build
node scripts/test-namespace-isolation.mjs
```

It creates only generated test namespaces and deletes them in a finally block. Ingress, real project database credentials, existing-project backfill traffic, public egress and RBAC impersonation still require the checklist above.

These cluster tests require a real k3s VM. Unit manifest tests cannot establish packet forwarding, admission configuration, or zero-downtime behavior. Record VM evidence before treating the runtime acceptance criteria as verified.
