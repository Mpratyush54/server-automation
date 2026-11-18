# How projects are kept apart

Each environment of each project runs in its own Kubernetes namespace (a walled-off area of the cluster). Apps in one project cannot reach apps in another, and each environment has resource limits. You can see the state on the project page under **Settings > Namespace isolation**.

## What an app can and cannot do

An app can:

- talk to other pods in the same environment
- receive web traffic through Cairn's ingress (the front door for web requests)
- call public websites on ports 80 and 443 (this can be turned off per environment)
- look up names (DNS)
- reach the shared PostgreSQL, MongoDB and Redis servers
- send logs, metrics and traces to Cairn

An app cannot:

- reach pods in another project or another environment
- reach private networks, or the internet on other ports or over UDP
- run as root or in privileged mode (new namespaces)
- create LoadBalancer or NodePort services
- use more than its quota of CPU, memory, pods and storage

## Default limits per environment

| Environment | CPU requests / limits | Memory requests / limits | Pods | Volumes |
|---|---|---|---|---|
| Development, staging, preview | 1 / 2 | 1Gi / 2Gi | 10 | 4, total 5Gi |
| Production | 2 / 4 | 2Gi / 4Gi | 20 | 4, total 20Gi |

A container that sets no resources gets requests of 100m CPU / 128Mi and limits of 500m CPU / 512Mi. These are ceilings, not reserved capacity.

## Check isolation for a project

1. Open the project and go to **Settings**.
2. Find **Namespace isolation**. Each environment shows its network policies, Pod Security level and quota use.

A warning appears when ownership labels do not match, when extra network policies need review, or when quotas differ from the configured baseline.

## Change limits or internet access

An operator sets these in a JSON file mounted into the API. See [Administrator settings](#administrator-settings) below. For example, to block internet access in production for one project:

```json
{
  "projects": {
    "PROJECT_UUID": {
      "production": { "internetEgress": false }
    }
  }
}
```

## How it works

Network rules use the kube-router NetworkPolicy enforcement built into k3s. No extra network plugin or controller is installed. Kubernetes 1.30 or later is required, for the ValidatingAdmissionPolicy that guards RBAC bootstrap. Apply the updated installer RBAC manifest before deploying a new API. Do not turn off the k3s network policy controller.

### Namespace creation

`ensureProjectNamespace(projectId, { name, namespace })` is the only place the API creates namespaces. Deploys, SDK registration (GitOps and direct), ingress creation and previews all call it before creating workloads. Argo CD's automatic namespace creation is off.

Only dedicated namespaces are accepted. Shared or system namespaces (`default`, `platform`, `databases`, `preview`, `ingress-nginx`, `argocd`, `cert-manager`, `monitoring`, `oauth2-proxy`, `portainer`, `storage` and `kube-*`), and namespaces owned by another project, are refused. Kubernetes errors other than "not found" or "conflict" are passed on.

### Pod Security

New namespaces get project and environment labels and the `restricted` Pod Security level for enforce, warn and audit. Existing namespaces keep their enforce level (privileged if it was unset) and get `restricted` warn and audit for one migration release.

The generated preview and direct deployment templates set non-root, RuntimeDefault seccomp, no privilege escalation, dropped capabilities and no mounted service-account token. Images must run as non-root. Manifests in your own Git repository must meet the restricted level themselves.

### Network policies

Policies deny all traffic in and out by default, then allow:

- Traffic between pods in the same environment namespace.
- Traffic in from the ingress-nginx controller pods, and out to them on TCP 80/443, so an app can call a public host name that loops back through the controller (the target's Ingress rules still apply).
- DNS on TCP and UDP port 53 to kube-dns in `kube-system`.
- The shared `postgresql` (5432), `mongodb` (27017) and `redis` (6379, plus 26379 for Sentinel on the high-availability profile) pods in `databases`, selected by chart instance and name labels. An operator can limit the database types per environment.
- `platform-api` in `platform` on TCP 3000, and the Alloy collector in `monitoring` on TCP 4317/4318. Change the selector and ports if you use other collectors.
- Public IPv4 on TCP 80/443 by default, configurable or off per project and environment. Private (RFC 1918), loopback, link-local, CGNAT, multicast and reserved ranges are excluded. Public IPv6 is denied. Clusters that use public ranges for pods, services or nodes must add them to `privateNetworks` before allowing public egress. No open UDP or other-port internet access is granted.

**Shared databases.** All projects reach the same database endpoint. Network policy cannot tell logical databases or users apart behind it. The boundary there is each project's database user and permissions, including Redis key prefixes. Test cross-project denial with project credentials, separately from the network tests. Network policy does not replace database authorization.

### Quotas

Quotas cap CPU and memory requests and limits, pods, volume count and storage, and block LoadBalancer and NodePort services. The values are in the table above.

### Administrator settings

Mount a JSON file you own into the API (a ConfigMap is enough) and set `NAMESPACE_BASELINE_SETTINGS_FILE` to its path. Do not expose this file through SDK settings. Without the variable, conservative defaults are used. A malformed file makes deploys fail. The file is read on each operation; after a change, reconcile existing namespaces with the backfill job.

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

`internetCidrs` are IPv4 ranges, never DNS names. Private ranges cannot be allowed this way. An empty list blocks public egress. The service-type quota rules cannot be overridden. Future plan or usage limits, and build workloads, should use this same settings file rather than bypass the baseline.

### Backfill existing namespaces

Run the one-shot job with the built API image, its normal database settings and a cluster-operator kubeconfig or service account. It turns off ORM schema sync. It does not run at API startup and does not restart workloads.

```sh
node dist/jobs/namespace-backfill.js --report /tmp/namespace-report.json
# Review desired manifests, current policy names, quota usage, pod warnings,
# skipped namespaces, and every workload's network destinations.
node dist/jobs/namespace-backfill.js --apply --report /tmp/namespace-report.json
```

- A dry run only reads from Kubernetes and writes the local report (no pod specs or credentials in it).
- Apply needs a matching fingerprint of the desired configuration. RBAC, policy or API errors are reported and block apply. Namespaces not yet created and shared legacy previews are skipped.
- Allow rules are installed before default deny, then the LimitRange and quota. Reruns replace the named baseline objects and keep namespace metadata.
- New quotas and defaults do not change running pods.
- Unrelated existing NetworkPolicies are reported, not deleted. They can widen access, so the status flags them for review.
- Workloads with destinations not in the list need settings or policy review before you apply.

**Legacy previews.** New deploys go to a dedicated namespace per project ID, recorded in the deployment metadata. Old deployment records keep their old cleanup and ownership check. Redeploy previews, check health and routing, then retire old preview ingresses and workloads with the normal terminate operation. The shared `preview` namespace is never relabelled as one tenant. When an old and a new preview share a host name, coordinate the ingress cutover before removing the old ingress. The backfill does not do this migration for you.

**Warnings.** Deploys save restricted Pod Security and resource warnings in the deployment metadata, show them in the portal and write them to the API deployment log. The backfill report has per-pod detail. This check does not replace Kubernetes admission: also review API server warnings and Argo CD sync errors for new manifests.

**Turn on enforcement.** After one release in warn and audit mode, fix manifests and quota headroom, make a fresh report, then:

```sh
node dist/jobs/namespace-backfill.js --report /tmp/enforce-report.json
node dist/jobs/namespace-backfill.js --apply --enforce --report /tmp/enforce-report.json
```

Enforcement is blocked while current pods have security or resource warnings. It does not evict running pods. A failed apply can be resumed with the same report unless the configuration changed. Make a new report after a completed enforcement change.

### Permissions the API holds

| Grant | Scope | Verbs | Used for |
|---|---|---|---|
| `namespaces` | cluster (ClusterRole `platform-api`) | get, list, create, update | read, create and label project namespaces |
| `rolebindings` | cluster (ClusterRole `platform-api`) | get, create, update | create the baseline RoleBinding in each namespace |
| `clusterroles/platform-namespace-baseline` | that one role | bind | reference the baseline role from that RoleBinding |
| `networkpolicies`, `resourcequotas`, `limitranges` | each project namespace (RoleBinding to ClusterRole `platform-namespace-baseline`) | get, list, create, update | apply the baseline, status, backfill report |
| `statefulsets` | each project namespace (same RoleBinding) | get, list, update | add the release environment variables when a deploy finalizes |

No delete, patch, watch, escalate or clusterrolebindings rights are granted. Two fail-closed ValidatingAdmissionPolicies limit the cluster-wide verbs:

- `platform-project-namespaces` lets the API create or update only non-reserved namespaces that carry `platform.io/project` and `platform.io/env` labels, and never change an existing owner label.
- `platform-baseline-bindings` lets it create or update only the exact baseline RoleBinding, for the exact role and the Cairn API service account, in such namespaces.

A new RoleBinding reaches the authorizer with a delay, so the first baseline write retries briefly on 403. The baseline ClusterRole has no ClusterRoleBinding, and no policy, quota or limit rights exist in system or platform namespaces. Creating and labelling namespaces stays a trusted API permission, because RBAC cannot filter namespaces by label. Install the admission guards before granting bootstrap rights. Cluster administrators and GitOps permissions stay trusted and must not let tenants rewrite namespace ownership or baseline policies.

## For developers / API

`GET /api/projects/:id` includes `namespaceBaselines` after the normal project access check. Each environment reports policy, ownership and Pod Security status, quota hard and used values, whether the LimitRange and quota match, and extra policies. If Kubernetes is unreachable, the status says so.

### Validate on a test VM

Provision a fresh Ubuntu 24.04 VM (4 vCPU / 8 GB) with `sudo platformctl provision`. Deploy two non-root example apps into different projects and confirm kube-router policy enforcement is on. With a restricted-compliant probe pod in each project namespace:

1. Check namespace labels, seven NetworkPolicies, the ResourceQuota and LimitRange, and quota use in the API and portal.
2. Resolve the local service and cluster DNS. Reach the local service, and the app through ingress-nginx.
3. Try a TCP connection to the other project's pod IP and service name or IP. Require a timeout, not just an HTTP error. Test both directions, and with public egress off.
4. Reach the shared database ports. With each project's credentials, confirm access to its own database and denial to the other project's database and Redis keys.
5. Check default public HTTP/HTTPS access, and that it is removed after a settings change. Check private destinations are not covered by public egress.
6. Submit a privileged pod with server-side dry run and require a Pod Security rejection. Submit a compliant pod without resources and confirm the LimitRange defaults and quota use. Try a LoadBalancer or NodePort service and require a quota rejection.
7. Back-fill a legacy dedicated namespace in dry run and confirm nothing changed. Apply in warn mode while watching a compliant workload; require no restart or dropped traffic. Fix warnings, report again, enforce, and confirm privileged pods are rejected.
8. As `platform-api`, confirm baseline access and binding creation are denied in `kube-system` and `platform`. Confirm the backfill is safe to repeat.

The automated part (two namespaces, pod and service timeouts both ways, DNS and local service, privileged rejection, LoadBalancer quota, LimitRange defaults and pods kept on rerun) runs with:

```sh
cd platform/api
npm run build
node scripts/test-namespace-isolation.mjs
```

It creates only generated test namespaces and deletes them at the end. Ingress, real project database credentials, backfill traffic, public egress and RBAC impersonation still need the checklist above. These tests need a real k3s VM; unit tests cannot prove packet forwarding, admission configuration or zero-downtime behaviour.
