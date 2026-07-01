# Changelog

## v2.0.0 (2026-07-01)

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

## v1.0.0 (2026-06-01)

- Initial release with core features
- Caps branding (legacy)
