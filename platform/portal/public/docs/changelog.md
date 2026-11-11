# Changelog

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
