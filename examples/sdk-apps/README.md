# Platform SDK demo apps (Node + React + Angular)

End-to-end proof that the SDK owns DevOps + DBs + telemetry on the cluster.

## What the SDK does on `init()`

1. **Register** → creates/refreshes ArgoCD Application from `repositoryUrl` + `gitPath`
2. **Ensure DBs** → creates project Postgres / Mongo / Redis credentials if missing and returns them via `/api/sdk/db-credentials`
3. **Ingress TLS** → wires HTTPS host for the Node service
4. **Telemetry** → heartbeats + per-route API latency

You only need to **build/import images** (and bootstrap the same manifests once until they are on `main` for Argo).

## Live hosts (VPS)

| App | URL |
|-----|-----|
| Node API + SDK | https://sdk-demo-apps-development.148.113.59.3.sslip.io/health |
| DB check | https://sdk-demo-apps-development.148.113.59.3.sslip.io/api/db-check |
| React | https://sdk-react.148.113.59.3.sslip.io |
| Angular | https://sdk-angular.148.113.59.3.sslip.io |

Portal project: **sdk-demo-apps** → Metrics / API Latency.

## Deploy on VPS

```bash
# On your machine: upload sources, then on VPS:
ADMIN_PASSWORD='…' bash /tmp/vps-deploy-sdk-apps.sh /tmp/sdk-apps-src
```

## Local demos

```powershell
cd examples/sdk-apps
$env:PLATFORM_SDK_TOKEN='sdk_live_...'
./start-demos.ps1
```

## Automated checks

```powershell
# Unit (API)
cd platform/api
npx jest --forceExit tests/unit/project-db-ensure.test.ts

# Telemetry E2E (local node-api → live API)
$env:NODE_TLS_REJECT_UNAUTHORIZED='0'
$env:ADMIN_PASSWORD='…'
node scripts/e2e-sdk-telemetry.mjs
```

## Notes

- Do not call `captureConsole()` in the Node demo (log recursion).
- Keep `platform-auto-update` suspended while using `local-*` / `:local` image tags.
- Push `examples/sdk-apps/k8s` to `main` so Argo self-heals without re-applying manifests.
