# Platform SDK demo apps (Node + React + Angular)

End-to-end proof that the SDK owns DevOps + DBs + telemetry on the cluster.

## What the SDK does on `init()`

1. **Register** → creates/refreshes ArgoCD Application from `repositoryUrl` + `gitPath`
2. **Ensure DBs** → creates project Postgres / Mongo / Redis credentials if missing and returns them via `/api/sdk/db-credentials`
3. **Ingress TLS** → wires HTTPS host for the Node service
4. **Telemetry** → heartbeats + per-route API latency

You only need to **build/import images** (and bootstrap the same manifests once until they are on `main` for Argo).

## Hosts

`k8s/all.yaml` uses the placeholder `__DOMAIN__` for every Ingress host and URL; the deploy
script substitutes your platform's `DOMAIN` (e.g. `sed "s/__DOMAIN__/$DOMAIN/g" k8s/all.yaml | kubectl apply -f -`).

| App | URL |
|-----|-----|
| Node API + SDK | https://sdk-demo-apps-development.__DOMAIN__/health |
| DB check | https://sdk-demo-apps-development.__DOMAIN__/api/db-check |
| React | https://sdk-react.__DOMAIN__ |
| Angular | https://sdk-angular.__DOMAIN__ |

The React and Angular images run unprivileged nginx (UID 101) on port **8080**; their
containers and Services target 8080 (the Services still expose port 80 to the Ingress).

Portal project: **sdk-demo-apps** → Metrics / API Latency.

## Deploy on VPS

```bash
# On your machine: upload sources, then on VPS:
ADMIN_PASSWORD='…' bash /tmp/vps-deploy-sdk-apps.sh /tmp/sdk-apps-src
```

## Package-level examples (snippets)

| SDK | Path |
|-----|------|
| Node | [`sdk-node/examples`](../../sdk-node/examples) |
| React | [`sdk-react/examples`](../../sdk-react/examples) |
| Angular | [`sdk-angular/examples`](../../sdk-angular/examples) |
| Python | [`sdk-python/examples`](../../sdk-python/examples) |

Docs index: [`docs/getting-started/sdk-examples.md`](../../docs/getting-started/sdk-examples.md)

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
# Lab install with a private/self-signed CA: trust it instead of disabling TLS checks
$env:NODE_EXTRA_CA_CERTS='C:\certs\platform-ca.pem'
$env:ADMIN_PASSWORD='…'
node scripts/e2e-sdk-telemetry.mjs
```

## Notes

- `captureConsole()` is safe to use (it no longer recurses through the SDK logger).
- Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`; use `NODE_EXTRA_CA_CERTS` to trust a lab CA. In Kubernetes, mount the CA from a ConfigMap and point `NODE_EXTRA_CA_CERTS` at it.
- Keep `platform-auto-update` suspended while using `local-*` / `:local` image tags.
- Push `examples/sdk-apps/k8s` to `main` so Argo self-heals without re-applying manifests.
