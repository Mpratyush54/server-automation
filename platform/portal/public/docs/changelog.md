# Changelog

## v1.0.0 (2026-08-18)

First git-tagged **1.0.0** Platform release (prior production tags were `v0.3.x`).

- MCP server (`platform/mcp-server`) with agent tokens (`plat_agent_*`), command guard, and human approval for destructive commands
- User + agent MCP documentation (overview, setup, tools/policy, for-agents) and homepage `curl | sh` install
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
