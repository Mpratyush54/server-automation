# Changelog

## Unreleased — Phase 4: observability, session replay, heatmaps, status pages

### New
- **High availability (`ha` profile):** multi-node k3s with embedded etcd, `platformctl join --role server|agent`, join token create/rotate/install, cluster firewall limited to `PLATFORM_CLUSTER_NODES`, etcd snapshots to S3 (#53); Longhorn replicated storage as the default StorageClass with S3 backups and volume alerts (#50); ingress HA with a kube-vip ARP VIP (`INGRESS_HA_MODE=vip`) or external LB/DNS failover (`external`), ingress-nginx DaemonSet with client-IP preservation, optional `API_VIP` for joins (#54). `join` prepares Longhorn prerequisites on every node and the storage skip file and ingress HA k3s fragment on servers. See [operations/ha.md](operations/ha.md).
- **Session replay** (opt-in, consent-based) for the React and Angular SDKs: rrweb recording with input masking, unload delivery via `sendBeacon` / keepalive, portal player with error/navigation/network markers, audited access (`replay.view`, `replay.chunk_view`, `replay.snapshot_view`); agent tokens need the `replays:read` scope. See [guides/frontend-rum.md](guides/frontend-rum.md).
- **Heatmaps**: per-page click and scroll-depth aggregates with the newest replay snapshot of each page as the background; buffered, exact aggregation. See [guides/heatmaps.md](guides/heatmaps.md).
- **Status pages**: public `/status/<slug>` pages fed by synthetic checks, incidents and scheduled maintenance, JSON/Atom/RSS feeds, light/dark themes. See [guides/status-pages.md](guides/status-pages.md).
- **Observability views**: fleet and per-project views (RED, services, logs, traces, RUM, sessions, synthetics, infrastructure, profiles), every query forced to the project scope. See [guides/observability.md](guides/observability.md).
- **Database insights**: PostgreSQL/MongoDB/Redis exporters on the full profile and a per-project Database tab with normalised top queries and slow operations. See [operations/database-monitoring.md](operations/database-monitoring.md).
- **Dashboard** shows live data instead of placeholders.
- **GDPR delete** also removes error-tracking events, replay objects/sessions and submits Loki delete requests. See [operations/telemetry-privacy.md](operations/telemetry-privacy.md).

### Fixed (found by full-profile VM testing)
- Browser RUM was blocked by CORS on every install: the API now publishes the Faro allow-list (`monitoring/telemetry-origins`).
- Collector ingress returns 429/503 with `Retry-After` for throttling (was 500); ingress-nginx preserves real client IPs (`externalTrafficPolicy: Local`), so per-IP limits are per client again.
- Upgrades from v1.2.0: loki-stack is migrated instead of failing; schema drift after a rollback is repaired; `PLATFORM_IMAGE_TAG` is persisted; new components and changed database values are reconciled by `platformctl upgrade`; project Redis users are re-created after a Redis restart. See [operations/upgrades.md](operations/upgrades.md).
- Alerting: bounded SMTP sends and concurrent delivery (one unreachable mail server no longer stalls every channel); SMTP secrets encrypted at rest; recovery titles on resolved notifications.
- Retention that actually applies: error events, per-project logs (Loki runtime overrides), replays, heatmaps, alert deliveries and resolved incidents.
- Browser synthetic checks: every navigation hop re-validated, dedicated runner API listener, missing runner reports become failed results, project env hosts reachable with the platform CA.
- MongoDB standalone uses the `Recreate` strategy (rolling updates deadlocked on `mongod.lock`).
- Portal: responsive layout (mobile drawer, tablet), readable Observability, checkbox/disabled-button styling, Errors page restyle, all docs pages available in the in-portal docs viewer.
- Go toolchain 1.26.11 (GO-2026-6859).
- **Alerting per project (#151):** project owners and devops configure their own project's channels, escalation policies, on-call schedules, silences, availability/latency SLOs and trace/resource monitors; raw PromQL/LogQL monitors and ratio SLOs stay with platform admin/devops. See [operations/alerting.md](operations/alerting.md).
- **Synthetics against the platform's own domain (#152):** HTTP and browser checks of `DOMAIN` / `*.DOMAIN` no longer fail as private addresses; they are reached only through the ingress controller, trusting the platform CA.
- **NAT-friendly limits (#153):** per-IP ingress limits are configurable (`INGRESS_IP_RATE_LIMIT`, `INGRESS_IP_BURST`, `INGRESS_IP_CONNECTIONS`; defaults 1000 r/s, burst 2000, 2000 connections) and the heatmap ingest limits are raised, so many visitors behind one office or carrier address are not throttled.
- **Replay on Firefox (#154):** the page-hide upload is sent as a CORS simple request (`sendBeacon`, keepalive fallback), so the last chunk of short sessions is no longer lost.
- **Git branches (#155):** the project page looks up branches through the API (authenticated, cached) and skips the lookup when the project has no repository.
- **Error grouping (#156):** the same browser error is grouped into one issue across engines and builds (normalised v2 fingerprint; existing issues keep receiving events).
- **Firewall status (#157):** `platformctl` marks `harden-firewall` done after hardening instead of reporting it as in progress.

## Unreleased — end-to-end VM suite and release gate

- **Release gate:** every tag is now published as a GitHub pre-release. A stable `vX.Y.Z` becomes the Latest release (what `install.sh` and `releases/latest` install, and the GHCR `platformctl:latest` copy) only after the e2e VM suite passes on the `minimal` and `full` profiles. Until then stable installs keep the previous release. See [operations/e2e-ci.md](operations/e2e-ci.md).
- **e2e CI:** nightly and on every tag, a fresh Ubuntu 24.04 EC2 VM is provisioned and checked (TLS, API, SDK, per-engine DB credentials, SSO to Grafana/Argo CD/Portainer, Argo CD sync, backup + restore test, tenant isolation, security probes), then destroyed. An hourly janitor removes leftovers.
- `platformctl provision` also writes the step timings as JSON to `/var/log/platformctl/timings.json`.

## Unreleased — faster `platformctl provision`

- **Parallel install:** cluster components install as a dependency graph, up to 4 at a time (`--parallel N`, `PLATFORMCTL_PARALLEL`; `--parallel 1` keeps the old serial, live-output behaviour). Each step logs to `/var/log/platformctl/<step>.log`.
- **Step timings:** provision prints a per-step timing table and saves it to `/var/log/platformctl/timings.txt`.
- **Image pre-pull:** every image the install needs is pulled in the background right after k3s starts.
- **Pinned versions:** k3s, Helm and all charts are pinned in `platformctl/internal/versions`; chart tarballs are prefetched while k3s installs. No more `helm repo update`; Bitnami charts come from OCI.
- **Docker CE is no longer installed** on the server — k3s uses its own containerd. Private GHCR pulls now use `GITHUB_TOKEN` via `/etc/rancher/k3s/registries.yaml`.
- Removed duplicate Helm upgrades (ingress-nginx, kube-prometheus-stack) and the ArgoCD reset on fresh installs.
- **Fix:** Infisical was never actually installed (dead chart repo); it is now applied from its manifest.
- New `--profile minimal|standard|full` and `--bundle <path|auto>` (offline bundle release asset).

## v1.0.0 (2026-08-18)

First git-tagged **1.0.0** Platform release (prior production tags were `v0.3.x`).

- MCP server (`platform/mcp-server`) with agent tokens (`plat_agent_*`), command guard, and human approval for destructive commands
- User + agent MCP documentation (overview, setup, tools/policy, for-agents) and homepage `curl | bash` install
- `platformctl` commands: `provision`, `install`, `status`, `seed`, `update`, `recover`, `backup`, `version`
- Safer secret rotate / recover: passwords fsynced to `/etc/platform` before `ALTER USER`; JSON Patch rollout restart for `platform-api`
- GitHub / GitLab login, profile, notifications, one-click rotate UI

The Caps-era notes below were documentation versions, not these git tags.

## Caps docs v2.0.0 (2026-07-01)

### Breaking Changes

- Rebranded all packages from `@caps/*` to `@mpratyush54/*`
- Renamed `CapsClient` → `PlatformClient` across all SDKs
- Renamed `CAPS_*` env vars to `PLATFORM_*`
- Renamed `caps_sdk/` → `platform_sdk/` in Python SDK

### Features

- OAuth2 / OpenID Connect support with RS256-signed tokens
- Custom RBAC roles with permission presets (admin, devops, tech_lead, developer, viewer)
- Preview environments with 72h auto-cleanup
- Infisical-powered secrets management with AES-256-GCM encryption
- Multi-SDK support (Node.js, Python, React, Angular)
- Grafana dashboards + Loki log aggregation
- Automated database backups to MinIO
- GitLab/GitHub webhook integration
- ClickUp task linking

### Fixed

- Angular `@` template escaping (use `&#64;` instead of `@`)
- ArgoCD subpath routing (`--rootpath=/argocd`)
- Grafana subpath redirect (`GF_SERVER_ROOT_URL` fix)
- MinIO PVC initialization ordering
- DNS IPv6 timeouts (systemd-resolved config)
- cert-manager staging/production issuer workflow

## Caps docs v1.0.0 (2026-06-01)

- Initial Caps-branded documentation snapshot (legacy; not git tag `v1.0.0`)
