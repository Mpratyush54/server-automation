# Build and deploy from Git

Cairn can build an app on your server when you push to a linked branch. It uses a Dockerfile at the repository root when one exists. Otherwise, Cloud Native Buildpacks detects the language and builds the image. A successful build is deployed by its immutable image digest. Failed builds leave the running version in place.

Your app must listen on port **8080** (Cairn sets `PORT=8080`) and its image must declare a numeric, non-root user ID. Source builds create a Deployment and Service in the environment's isolated namespace; they do not require Kubernetes manifests in your repository. Keep an environment dedicated to source builds rather than managing the same workload with Argo CD.

## Enable builds on the server

Builds are an explicit opt-in on the standard, full and ha install profiles. They are always disabled on minimal. A single build may use up to 2 CPU and 3 GiB of memory at a time, plus up to 12 GiB of temporary disk. Plan headroom for the app and Cairn itself. The default is one build at a time across the cluster and one per project.

Set `BUILDS_ENABLED=true` and `BUILDS_EGRESS_CIDRS` before running `sudo -E platformctl provision`, or install the component with `sudo -E platformctl install builds`. The egress setting is a comma-separated list of explicit public IPv4 ranges for your Git host, base image registries and package repositories. Builds may reach only those ranges, only on port 443 (HTTPS), plus cluster DNS and the in-cluster registry. Private, loopback, link-local (including cloud metadata addresses), carrier-grade NAT, the cluster's pod and service ranges (read from the k3s configuration) and the nodes' own addresses (as known when builds are installed, plus `BUILDS_REGISTRY_NODE_CIDRS`) are always excluded, even when a listed range contains them; a range that lies inside one of them is rejected. Broad default routes are rejected. Keep the list current when provider addresses change. Plain-HTTP mirrors, package repositories on other ports and mirrors on private networks do not work from builds.

The installer also excludes the server's public IPv4 address when the cloud reports it (on AWS, through IMDSv2; skipped silently elsewhere). It does not exclude the addresses your domain resolves to, because a domain behind a CDN or proxy shares those addresses with unrelated sites. If the platform is reached through a dedicated load balancer, floating IP or another public address that Kubernetes does not list, add it to `BUILDS_EXTRA_BLOCKED_CIDRS` in `/etc/platform/.env` (comma-separated CIDRs; default routes `0.0.0.0/0` and `::/0` are rejected). Builds cannot download from apps hosted on the same Cairn server. After a server's public address changes, re-run `sudo platformctl install builds`. Provisioning and server joins refresh this policy when builds are enabled. Agent joins cannot update cluster policy: re-run the installer on a server, and add any agent public address missing from Kubernetes to `BUILDS_EXTRA_BLOCKED_CIDRS`.

The installer creates a distribution registry inside the cluster. It has no public hostname and no Ingress: builds push to it over the cluster network, the API manages it there, and each node's container runtime pulls from its Service address. Images are named `registry.<your Cairn domain>/...`; the installer adds a k3s mirror that routes that name to the in-cluster Service, so no DNS record is needed. Bundled MinIO gets a dedicated bucket (`BUILDS_S3_BUCKET`, default `platform-registry`) and a bucket-scoped registry account. The installer does not add another database or storage server.

For external S3, set `BUILDS_S3_ENDPOINT` and `BUILDS_S3_BUCKET`, and create `registry/registry-storage` with the `REGISTRY_STORAGE_S3_ACCESSKEY` and `REGISTRY_STORAGE_S3_SECRETKEY` keys before installing builds. The endpoint must use HTTPS. Do not put credentials into these settings or source code.

Builds run only on nodes that carry the `cairn.dev/build-runtime=v2` label. The installer installs the BuildKit runtime profiles (see below) on the node where it runs, labels that node, and requires AppArmor to be enabled (it is on Ubuntu). On **ha** installations, the other nodes stay unlabeled and never run builds unless you install the same profiles there. Every node pulls from the registry, so copy the registry mirror from `/etc/rancher/k3s/registries.yaml` and the `registry-token.cairn.internal` line from `/etc/hosts` (it points the node's container runtime at the registry token endpoint) to each server and agent (preserving their existing settings), restart its k3s service during a maintenance window, and list the nodes' addresses in `BUILDS_REGISTRY_NODE_CIDRS` so the registry accepts their pulls. Each entry must be a node address or a node subnet no broader than /16 and must not overlap the cluster's pod or service range. Re-run `sudo -E platformctl install builds` after adding nodes so their addresses are excluded from build egress. Registry traffic stays on the cluster network and is not encrypted between nodes; use an encrypted overlay network on multi-node clusters. Registry data is in S3, so it survives pod rescheduling.

## Connect a branch

1. Link a GitHub or GitLab repository to the project.
   - **GitHub:** install the connected GitHub App on the repository. Each clone uses its own App token, limited to that repository with read-only contents access and revoked when the clone finishes. Builds do not fall back to a personal access token; without the App installation they are refused.
   - **GitLab:** connect GitLab with a token that can create project deploy tokens (Maintainer access and the `api` scope). Each clone uses a new deploy token with only `read_repository`, revoked when the clone finishes. If GitLab does not issue one, the build is refused with that reason; it never falls back to a broader token.
   A repository can be linked to only one active project. Cairn compares repository addresses without regard to case, a trailing `.git` or a trailing slash.
2. Ask a platform administrator to open **Deployments → Builds** and select **Approve repository**. Builds, including **Build now** and build-on-push, run only for a repository an administrator approved. Changing the project's repository clears the approval, and while build-on-push is enabled only a platform administrator can change the repository.
3. Open **Deployments → Builds**. Select an environment and enter a branch for **Build now**.
4. To build future pushes automatically, enter the environment's linked branch, enable **Build from source on push**, and save. This setting requires project DevOps access.
5. Select **View logs** to follow the build. History and logs refresh every five seconds. Logs require project developer access; build history requires viewer access.

Build success means the image has been pushed. Check deployment history for rollout readiness. Cairn checks that the new pod is available before marking the deployment deployed. It does not treat a failed build as a successful deployment.

Webhook signatures and delivery deduplication are checked before queuing builds. Cairn then asks GitHub or GitLab whether the pushed commit is the current head of the linked branch of the project's linked repository. Only the branch head is built. If the branch has already moved on, the push is skipped because a newer commit exists. A commit that is not on the branch is not built and is recorded in the audit log as `build.push_rejected`. If the provider cannot answer (an outage, a rate limit or a missing credential), the webhook returns an error so that the provider's redelivery is processed. Repeated push events share one build while it is queued or running. Pushing a commit that was already built successfully, for example after a revert, deploys its existing image again; a commit whose build failed is built again. A newer push cancels builds for the same environment that are still waiting in the queue; a build that already started finishes. Builds are ordered by when their commit was confirmed as the branch head, so an older commit never cancels or replaces a newer one, even when webhook deliveries arrive out of order. **Build now** can rebuild a branch, including after a failure. Deleted branches and tag pushes do not trigger source builds. Only opted-in environments whose linked branch matches the push use the source pipeline; existing manifest workflows remain available.

## How builds are isolated

Everything in your repository is treated as untrusted code: Dockerfile `RUN` steps, buildpack scripts and package install hooks. The goal is that a build can affect only its own project's images, never another project or the platform.

Each build is one Kubernetes Job in the separate `builds` namespace. Its steps run one after another:

1. **Clone** (platform-controlled) fetches the exact commit with the per-build Git credential described above, verifies the commit, and removes Git metadata. This is the only step that sees a Git credential, and the credential is revoked as soon as the step ends.
2. **Build** (runs repository code): BuildKit builds a Dockerfile into an image archive on a temporary volume, or the Buildpacks detect and build phases run. These containers receive no Git token, no registry credential and no Kubernetes service account token, and cannot reach the cluster network beyond DNS and the in-cluster registry port.
3. **Publish** (platform-controlled) pushes the result. For Dockerfiles, a separate container pushes the archive; for Buildpacks, the lifecycle is split so that only the analyze, restore and export phases, which run no buildpack code, hold registry access. The push credential is a short-lived token that can push to and pull from exactly this environment's repository. The publish step reports the digest it pushed; Cairn deploys that digest and never looks the image up by tag.

Registry access is authorized per repository. The API issues every registry token. Build tokens cannot delete. Each project namespace gets its own pull-only credential, which can be exchanged only for short-lived tokens that read that project's repositories; a project cannot pull another project's images. Source workloads always re-check pull authorization with the registry when a pod starts, so an image another project left in a node's cache cannot be started without access. Only the API's retention identity can delete images. The registry signing key is stored in the `platform` namespace, never in the namespace where builds run. Pull credentials are derived from that key: when the installer replaces it, the API rewrites every project's pull Secret within a few minutes, and pods that start in that window may need a retry.

**Runtime settings.** The `builds` namespace uses Pod Security **baseline**; project namespaces keep their restricted policy. Jobs have no host mounts and no privileged containers. All build containers except BuildKit run with the runtime's default seccomp profile, no privilege escalation and all capabilities dropped. BuildKit also drops all capabilities except `SETUID` and `SETGID`, and allows privilege escalation, because rootless BuildKit sets up its user-ID mapping with the `newuidmap` and `newgidmap` helpers, which carry the `setuid` and `setgid` file capabilities. [Rootless BuildKit](https://github.com/moby/buildkit/blob/master/docs/rootless.md) needs to create user namespaces and mounts to isolate `RUN` steps, which the default seccomp profile and Ubuntu's AppArmor policy forbid. Instead of disabling either, the installer adds two node-local profiles used only by the BuildKit container: a seccomp profile that denies kernel interfaces builds never need (modules, kexec, keyrings, BPF, perf events, ptrace, io_uring, netfilter configuration sockets and similar) while allowing user namespaces and mounts, and an AppArmor profile that adds user namespaces, mounts and POSIX message queues (for the `/dev/mqueue` mount of each `RUN` step) to the default container rules. User-namespaced pods (`hostUsers: false`) were not used for BuildKit because rootless BuildKit needs a nested user-ID range that does not fit inside a pod user namespace.

The v2 seccomp profile denies the newer mount API (`fsopen`, `fsconfig`, `fsmount`, `fspick`, `move_mount`, `open_tree`, `mount_setattr`) with `ENOSYS`, allowing runc to fall back to `mount(2)`. Re-run `sudo platformctl install builds` on each build node when upgrading: it installs `cairn/buildkit-v2.json`, removes the old seccomp file and updates the runtime label. The unchanged AppArmor profile remains `cairn-buildkit-v1`. Existing running builds keep their original seccomp filters.

**Limits of this isolation.** Builds are containers, not virtual machines: they share the node's kernel with everything else on it, and the BuildKit profiles expose more kernel surface (user namespaces and mounts) than the default profile. A kernel vulnerability could therefore cross the boundary. Run builds on nodes whose kernels you patch promptly, and for repositories from people you do not trust at all, consider dedicating a node to builds. The image a build produces is your project's own app and is as trustworthy as its source. Logs are bounded and known credential forms are redacted; avoid printing application secrets in build scripts. Dockerfile builds start without a layer cache because the build step has no registry access; Buildpacks keep a per-environment cache in the registry. Base images and packages must be publicly downloadable; private base images are not supported.

## Limits, recovery and settings

The API resumes interrupted operations and reattaches to the existing Job. A build whose Job was created is never started again: if its Job times out, is cancelled or has expired, the build fails and you start a new one. Environment deploy locks serialize builds and other deploy actions for that environment. Global and per-project admission checks enforce the concurrency limits. Build records and bounded logs are kept in PostgreSQL; completed Jobs expire after one day. Every build container has CPU, memory and temporary-disk limits, and the `builds` namespace has a quota for each.

API environment settings:

| Setting | Default | Meaning |
|---|---|---|
| `BUILDS_ENABLED` | `false` | Installer-controlled source build availability |
| `BUILDS_REGISTRY` | `registry.<domain>` | Registry name used in image references, without a scheme |
| `BUILDS_MAX_CONCURRENT` | `1` | Running build Jobs across the cluster, from 1 to 8; provision enough quota and RAM before increasing |
| `BUILDS_MAX_ACTIVE_PER_PROJECT` | `1` | Running build Jobs per project, from 1 to 8 |
| `BUILDS_MAX_QUEUED_PER_PROJECT` | `5` | Builds waiting per project, from 1 to 100; further pushes or requests are refused |
| `BUILDS_MANUAL_PER_10_MINUTES` | `5` | **Build now** requests per project in any 10 minutes, from 1 to 100 |
| `BUILDS_TIMEOUT_SECONDS` | `900` | Job deadline, up to 3600 seconds |
| `BUILDS_QUEUE_TIMEOUT_SECONDS` | `3600` | Maximum queue wait, up to 86400 seconds |
| `BUILDS_RETAIN` | `10` | Successful images kept per environment, from 1 to 1000 |
| `BUILDS_REQUIRE_SIGNATURE` | `false` | Fail closed until a cluster signing identity is configured |

The installer publishes the availability flag and registry name in the API's environment Secret. Apply the optional API settings through your cluster configuration. Values outside the supported bounds use the defaults.

## Retention and storage cleanup

After a deployment, Cairn removes old image manifests beyond the retention count. It protects the current deployed image, in-flight deployments, and digests shared with retained builds or the registry cache. Environments without a registry cache (Dockerfile builds) are cleaned up too. If the registry cannot be checked, cleanup is skipped until the next successful build. Historical deployment rows remain for auditing; images beyond retention may no longer be available for rollback. Failed builds do not count as retained successful images.

Distribution reclaims unreferenced blobs in a separate maintenance step. Pause new builds, wait for active builds and deploys to finish, then run:

```bash
sudo platformctl install registry-gc
```

This temporarily stops the registry, runs a bounded garbage-collection Job, and restarts the registry after confirming the collector has stopped. If that confirmation fails, the command reports an error and keeps the registry paused for operator recovery. App pods already running continue to serve, but image pulls and pushes are unavailable during the window. Do not run garbage collection concurrently with another registry administration action. Schedule this command in your server's maintenance system according to storage growth; it is deliberately not an always-running controller.

## Image signing

Cairn release images use keyless cosign signing in GitHub Actions. That workflow identity is unavailable to in-cluster source builds, and this repository has no cluster signing key. Source builds include a named signing hook that receives the digest reported by the trusted publish step. They are **not signed yet**. Set `BUILDS_REQUIRE_SIGNATURE=true` to block source deployments until a cluster identity is configured. See [image signing](../operations/image-signing.md) for the existing release verification and admission setup.

## Validation before production

The implementation has unit coverage for Job rendering (including that build steps receive no credentials), registry token scoping, webhook commit verification, queue limits, deduplication, pipeline failures, retention, authorization and portal actions. Fresh-server testing is a separate release gate. On Ubuntu 24.04 with 4 vCPU / 8 GB, confirm that rootless BuildKit starts with the installed profiles, build both a Dockerfile repository and a Buildpacks repository, check that a build cannot push to another project's repository and that a project cannot pull another project's image, check that a push naming a commit outside the linked branch is rejected and that only the branch head is built, and measure build-to-ready time. Also test API restart during a build, pulls on every node, and a garbage-collection maintenance window. No build-time target is claimed until those measurements exist.
